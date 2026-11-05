#!/usr/bin/env python3
"""kotoba の類語辞書（dictionary.js）を生成する。

元データ（先に ./fetch_sources.sh で tools/sources/ に取ってくる）:
  - 日本語WordNet      : 本命。動詞・形容詞・文学的な語が多い
  - Sudachi 同義語辞書 : 補助。現代的な名詞・カタカナ語に強い
  - extra.txt          : 手書きの補足（上の2つで足りない語を埋める）
  - wordfreq           : 候補を「よく使う順」に並べるためだけに使う（頻度の値は出力しない）

使い方:
  python3 tools/build_dictionary.py            # ../dictionary.js を上書き
  python3 tools/build_dictionary.py --no-sudachi

  # 個人用：分類語彙表（国立国語研究所）も混ぜた版を dictionary.local.js に作る（公開しない。下を参照）
  python3 tools/build_dictionary.py --wlsp ~/WLSP/bunruidb.txt --out dictionary.local.js

分類語彙表について:
  CC BY-NC-SA 3.0（非営利のみ）。タコエディタは投げ銭を受け付けるので、配布する版には入れられない
  （国語研に確認済み。投げ銭がある場合は商業利用＝有償契約で、しかも契約でも語の一覧の配布は禁止）。
  なので自分のパソコンだけで使う。dictionary.local.js は .gitignore 済み、sw.js の ASSETS にも入れない
  （＝ build_site.py が dist/ にコピーしないので、Cloudflare には上がらない）。

出力の形:
  window.KOTOBA_DICTIONARY = {
    groups: [["本日","きょう"], ...],   // 意味グループ。語はよく使う順
    index:  { "今日": [0, 12], ... },     // 見出し語 → グループ番号（よく使う意味の順）
    adjectives: ["暑い", ...],            // い形容詞（「暑かった」から「暑い」を引くのに使う）
    verbs: ["佇む", ...],                 // 動詞（「佇んで」から「佇む」を引き、候補を同じ活用にするのに使う）
  }
  グループを語ごとに複製せず番号で参照するのは、同じグループを何十語もの見出しが共有するから。
  複製すると数倍のサイズになる。
"""
import argparse
import csv
import gzip
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import msgpack_mini  # noqa: E402

HERE = Path(__file__).parent
SOURCES = HERE / 'sources'

WNJA_XML = SOURCES / 'wnja' / 'data' / 'wn-ntumc-jpn.xml'
SUDACHI_TXT = SOURCES / 'SudachiDict' / 'src' / 'main' / 'text' / 'synonyms.txt'
WORDFREQ = SOURCES / 'wordfreq' / 'wordfreq' / 'data' / 'large_ja.msgpack.gz'
EXTRA_TXT = HERE / 'extra.txt'
OUT = HERE.parent / 'dictionary.js'

# Sudachi の分野のうち、物書きの言い換え候補としてはノイズになるもの（固有名詞系）
SUDACHI_SKIP_FIELDS = {
    '人名', 'キャラ', '国名', '地名', '観光', '店名', '商品', '大学名', '企業名', '組織名', '不快',
}

MAX_GROUPS_PER_WORD = 8     # 1語に出す意味グループの上限（多すぎるとパネルが埋まる）
MAX_WORDS_PER_GROUP = 24    # 1グループの語数の上限（よく使う順に切る）。extra.txt の手書きの行には効かない
MAX_WORD_LENGTH = 12        # これより長い「語」はほぼ説明文なので捨てる
UNKNOWN_RANK = 10_000       # 頻度データにない語の順位（＝一番後ろ）

ASCII_LETTER = re.compile(r'[A-Za-z]')
ONLY_SYMBOLS = re.compile(r'^[\d\W_]+$')


# ---------------------------------------------------------------------------
# 語のクリーニング
# ---------------------------------------------------------------------------

def normalize(word: str) -> str | None:
    """元データの表記をアプリで使う形にそろえる。使えない語は None。"""
    w = word.strip()
    # WordNet の「拝見+する」→「拝見する」
    w = w.replace('+', '')
    w = w.replace('　', '').replace(' ', '')
    if not w:
        return None
    if ASCII_LETTER.search(w):       # beautiful / view などの英語は外す（日本語の言い換えが目的）
        return None
    if ONLY_SYMBOLS.match(w):        # 記号・数字だけ
        return None
    if len(w) > MAX_WORD_LENGTH:
        return None
    return w


# ---------------------------------------------------------------------------
# 頻度（並べ替え用）
# ---------------------------------------------------------------------------

def load_rank() -> dict[str, int]:
    """語 → 順位（小さいほどよく使う）。wordfreq は頻度ごとの「箱」の並びになっている。"""
    if not WORDFREQ.exists():
        print('  wordfreq なし: 並び順は元データのまま', file=sys.stderr)
        return {}
    data = msgpack_mini.unpackb(gzip.open(WORDFREQ).read())
    rank: dict[str, int] = {}
    for i, bucket in enumerate(data[1:]):   # data[0] はヘッダ
        for w in bucket:
            rank.setdefault(w, i)
    return rank


def word_rank(word: str, rank: dict[str, int]) -> int:
    if word in rank:
        return rank[word]
    # 「拝見する」は頻度データに無い（分かち書きされている）ので「拝見」で代用
    if word.endswith('する') and word[:-2] in rank:
        return rank[word[:-2]] + 5
    return UNKNOWN_RANK


# ---------------------------------------------------------------------------
# 元データの読み込み（どれも「語のリストのリスト」を返す）
# ---------------------------------------------------------------------------

VERB_ENDINGS = set('うくぐすつぬぶむる')


def load_wordnet() -> tuple[list[list[str]], set[str], set[str]]:
    """synset（意味）ごとの語のリストと、い形容詞の集合と、動詞の集合。"""
    synsets: dict[str, list[str]] = defaultdict(list)
    adjectives: set[str] = set()
    verbs: set[str] = set()

    # 55MB の XML を一気に読むとメモリを食うので、要素ごとに読んで捨てる
    for _, el in ET.iterparse(WNJA_XML):
        if el.tag != 'LexicalEntry':
            continue
        lemma = el.find('Lemma')
        w = normalize(lemma.get('writtenForm', ''))
        if w:
            pos = lemma.get('partOfSpeech')
            if pos == 'a' and w.endswith('い') and len(w) >= 2:
                adjectives.add(w)
            if pos == 'v' and w[-1] in VERB_ENDINGS:
                verbs.add(w)
            for sense in el.findall('Sense'):
                synsets[sense.get('synset')].append(w)
        el.clear()

    return list(synsets.values()), adjectives, verbs


def load_wlsp(path: Path, adjectives: set[str], verbs: set[str], rank: dict[str, int]) -> list[list[str]]:
    """分類語彙表（bunruidb.txt, Shift_JIS の CSV）を、段落ごとのグループにする。

    列: 0 レコード番号, 3 類（体・用・相・他）, 7 分類番号（1.3020 など）, 8 段落番号, 9 小段落番号, 12 本体（見出しの語）
    分類番号の下の「段落」が、意味の近い語のまとまり（中央値8語）。小段落は細かすぎる（中央値3語）。
    分類番号の頭の数字が類（1 体・2 用・3 相・4 他）なので、名詞と動詞が同じグループに混ざることはない。
    """
    groups: dict[tuple[str, str], list[str]] = defaultdict(list)
    with open(path, encoding='cp932', errors='replace', newline='') as f:
        for row in csv.reader(f):
            if len(row) < 13:
                continue
            kind, code, para, body = row[3], row[7], row[8], row[12]
            # 「－こ［椀～］」のような接辞・用例つきの見出しは言い換え候補にならない
            if any(c in body for c in '－［］～〜…'):
                continue
            # 「憂い・憂え」のような表記の併記は分ける（カタカナ語の中黒は語の一部なので分けない）
            parts = body.split('・') if re.search(r'[\u3040-\u309f\u4e00-\u9fff]', body) else [body]
            for part in parts:
                w = normalize(part)
                if not w:
                    continue
                groups[(code, para)].append(w)
                if kind == '相' and w.endswith('い') and len(w) >= 2 and w in rank:
                    adjectives.add(w)
                if kind == '用' and w[-1] in VERB_ENDINGS:
                    verbs.add(w)
    return list(groups.values())


def load_sudachi(verbs: set[str]) -> list[list[str]]:
    groups: dict[str, list[str]] = defaultdict(list)
    with open(SUDACHI_TXT, encoding='utf-8') as f:
        for row in csv.reader(f):
            if len(row) < 9 or not row[0].strip():
                continue
            gid, kind, expand, _, form, _, variant, field, head = row[:9]
            if expand == '2':          # 削除履歴（使わない語）
                continue
            if form in ('1', '4'):     # 対訳（雨→レイン のようなカタカナ英語）・誤用
                continue
            if variant in ('1', '3'):  # アルファベット表記・誤表記
                continue
            if field.strip('()') in SUDACHI_SKIP_FIELDS:
                continue
            w = normalize(head)
            if w:
                groups[gid].append(w)
                if kind == '2' and w[-1] in VERB_ENDINGS:   # 用言
                    verbs.add(w)
    return list(groups.values())


def load_extra() -> list[list[str]]:
    groups = []
    for line in EXTRA_TXT.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        words = [normalize(w) for w in re.split(r'[、,]', line)]
        groups.append([w for w in words if w])
    return groups


# ---------------------------------------------------------------------------
# 組み立て
# ---------------------------------------------------------------------------

def dedupe(words: list[str]) -> list[str]:
    seen = set()
    words = [w for w in words if not (w in seen or seen.add(w))]
    # WordNet の動詞グループには「確認」と「確認する」が両方入っている。
    # 言い換え候補としては「確認する」だけでいい（動詞を名詞に置き換えると文が壊れる）
    return [w for w in words if w + 'する' not in seen]


def build(use_sudachi: bool, wlsp: Path | None = None) -> dict:
    rank = load_rank()
    print(f'  wordfreq: {len(rank):,} 語', file=sys.stderr)

    # (グループの語, 手書きかどうか)
    raw: list[tuple[list[str], bool]] = []

    extra = load_extra()
    raw += [(g, True) for g in extra]
    print(f'  extra:    {len(extra):,} グループ', file=sys.stderr)

    wn_groups, adjectives, verbs = load_wordnet()
    raw += [(g, False) for g in wn_groups]
    print(f'  WordNet:  {len(wn_groups):,} グループ / い形容詞 {len(adjectives):,} 語 / 動詞 {len(verbs):,} 語',
          file=sys.stderr)

    if use_sudachi and SUDACHI_TXT.exists():
        su = load_sudachi(verbs)
        raw += [(g, False) for g in su]
        print(f'  Sudachi:  {len(su):,} グループ', file=sys.stderr)

    if wlsp:
        wl = load_wlsp(wlsp, adjectives, verbs, rank)
        raw += [(g, False) for g in wl]
        print(f'  分類語彙表: {len(wl):,} グループ（個人用）', file=sys.stderr)

    # 手書きグループの「〜い」で終わる見出し語も形容詞として扱う（暑い、寒い…）
    for g in extra:
        for w in g:
            if w.endswith('い') and len(w) >= 2 and w in rank:
                adjectives.add(w)
            if w.endswith('する') and len(w) >= 3:   # 散歩する 等
                verbs.add(w)

    # --- グループを整える：重複を除き、よく使う順に並べ、2語未満は捨てる ---
    groups: list[list[str]] = []
    is_manual: list[bool] = []
    seen_sets: dict[frozenset, int] = {}
    for words, manual in raw:
        words = dedupe(words)
        if len(words) < 2:
            continue
        key = frozenset(words)
        if key in seen_sets:
            # まったく同じ語の組み合わせが別の元データにもあった。手書き扱いが勝つ
            is_manual[seen_sets[key]] |= manual
            continue
        if not manual:
            # 手書きは書いた順を尊重。それ以外はよく使う順
            words.sort(key=lambda w: word_rank(w, rank))
        seen_sets[key] = len(groups)
        groups.append(words)
        is_manual.append(manual)

    # --- 見出し語 → グループ ---
    by_word: dict[str, list[int]] = defaultdict(list)
    for gid, words in enumerate(groups):
        for w in words:
            by_word[w].append(gid)

    def group_score(gid: int, head: str) -> tuple:
        # 手書き → よく使う語が入っている意味 の順。上位3語の順位の平均で比べる。
        # 手書きどうしは「その語を先頭に書いた行」→ 書いた順。頻度で並べると、「拒否感」で
        # 「抵抗感、…」の行が「拒否感、…」の行より上に来てしまう（10/24）
        if is_manual[gid]:
            return (0, 0 if groups[gid][0] == head else 1, gid)
        others = sorted(word_rank(w, rank) for w in groups[gid] if w != head)[:3]
        return (1, 0, sum(others) / max(1, len(others)))

    index: dict[str, list[int]] = {}
    for head, gids in by_word.items():
        gids = sorted(gids, key=lambda g: group_score(g, head))
        # 自分を除いた候補が、もっと上の意味グループに全部含まれているなら出さない（同じ候補の繰り返しになる）
        kept: list[int] = []
        shown: set[str] = set()
        for g in gids:
            cands = set(groups[g]) - {head}
            if cands and not cands <= shown:
                kept.append(g)
                shown |= cands
            if len(kept) >= MAX_GROUPS_PER_WORD:
                break
        if kept:
            index[head] = kept

    # --- 使われなくなったグループを捨てて番号を詰める ---
    used = sorted({g for gids in index.values() for g in gids})
    renum = {old: new for new, old in enumerate(used)}
    # 手書きの行は切らない（人が選んで書いた語なので全部出す。一人称の行は30語以上ある、11/5）。
    # 上限は、WordNet の何十語もある大きなグループを絞るためのもの
    out_groups = [groups[g] if is_manual[g] else groups[g][:MAX_WORDS_PER_GROUP] for g in used]
    out_index = {w: [renum[g] for g in gids] for w, gids in index.items()}
    in_groups = {w for g in out_groups for w in g}

    # 切り詰めでグループから落ちた見出し語は、自分のグループに自分がいなくても引けるので問題なし

    return {
        'groups': out_groups,
        'index': out_index,
        'adjectives': sorted(a for a in adjectives if a in out_index),
        # 候補として出るだけの動詞も活用させたいので、見出し語でなくてもグループに入っていれば残す
        # よく使う順に並べる。「行って」が 行く か 行う か迷ったとき、アプリはこの順で前にある方を選ぶ
        'verbs': sorted((v for v in verbs if v in out_index or v in in_groups),
                        key=lambda v: (word_rank(v, rank), v)),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--no-sudachi', action='store_true', help='Sudachi 同義語辞書を使わない')
    ap.add_argument('--out', type=Path, default=OUT)
    ap.add_argument('--wlsp', type=Path, help='分類語彙表の bunruidb.txt。個人用の版を作るときだけ（--out dictionary.local.js と一緒に）')
    args = ap.parse_args()

    if not WNJA_XML.exists():
        sys.exit(f'{WNJA_XML} がない。先に tools/fetch_sources.sh を実行して')

    print('辞書を生成中…', file=sys.stderr)
    if args.wlsp:
        if not args.wlsp.exists():
            sys.exit(f'{args.wlsp} がない')
        # うっかり配布用の dictionary.js を上書きしないように
        if args.out.resolve() == OUT.resolve():
            sys.exit('分類語彙表入りは配布できないので、--out dictionary.local.js を指定して')
    data = build(use_sudachi=not args.no_sudachi, wlsp=args.wlsp)
    if args.wlsp:
        data['wlsp'] = True   # アプリ側で出典を表示するための印

    body = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    header = (
        '// 自動生成ファイル。直接編集しない（tools/build_dictionary.py で再生成する）。\n'
        '// 元データ: 日本語WordNet / Sudachi 同義語辞書 / tools/extra.txt'
        + (' / 分類語彙表（国立国語研究所、CC BY-NC-SA 3.0。個人用・配布しない）' if args.wlsp else '') + '\n'
        '// ライセンスは THIRD_PARTY_NOTICES.md を参照。\n'
    )
    args.out.write_text(header + 'window.KOTOBA_DICTIONARY = ' + body + ';\n', encoding='utf-8')

    size = args.out.stat().st_size
    print(f'→ {args.out}  見出し語 {len(data["index"]):,} / グループ {len(data["groups"]):,} / '
          f'{size / 1024 / 1024:.1f} MB', file=sys.stderr)


if __name__ == '__main__':
    main()
