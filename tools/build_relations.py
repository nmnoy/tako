#!/usr/bin/env python3
"""連想の欄に出す「関係のある語」（relations.js）を生成する。

日本語WordNet の語は、英語の WordNet と同じ「意味の番号（ILI）」を持っている。
語どうしの関係（雨 → 上位：降水 / 下位：霧雨・夕立 / 部分・全体）は日本語版にはほとんど入っていないが、
英語版（Open English WordNet）には入っているので、ILI を介して借りてくる。英語の語は使わない（関係だけ借りる）。

元データ（tools/fetch_sources.sh で取ってくる）:
  - 日本語WordNet       : 語と意味（synset）と ILI
  - Open English WordNet: 意味どうしの関係（hypernym / mero_* など）。CC BY 4.0 + WordNet License
  - wordfreq            : よく使う順に並べるためだけ

使い方:
  python3 tools/build_relations.py        # ../relations.js を上書き

出力の形:
  window.KOTOBA_RELATIONS = {
    words: ["降水", "霧雨", …],                 // 出てくる語の一覧
    rel: { "雨": [[0, …], [1, …], […], []], … }  // 語 → [上位語, 下位語, 部分, 全体]（words の番号）。空の欄は []
  }
"""
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import json
import yaml

sys.path.insert(0, str(Path(__file__).parent))
from build_dictionary import WNJA_XML, load_rank, normalize, word_rank  # noqa: E402

HERE = Path(__file__).parent
OEWN_YAML = HERE / 'sources' / 'oewn' / 'src' / 'yaml'
OUT = HERE.parent / 'relations.js'

MAX_PER_KIND = 10  # 1つの欄に出す語の上限（よく使う順に切る）
SENSES_PER_WORD = 2  # 1語につき、よく使う意味をいくつまで見るか

# 1語にはたくさんの意味（synset）がぶら下がっている。「家」なら 建物・家族・家系・(英語由来の)関係…。
# 全部の意味の関係を混ぜると「家 → 上位：関係、連絡、ユニット」のように訳の分からない語が並ぶので、
# 「よく使う語が多く入っている意味」を上から SENSES_PER_WORD 個だけ使う（辞書の並び順と同じ考え方）

# Open English WordNet の関係のうち、どれをどの欄に入れるか。逆向き（下位・全体）は後で作る
UP = ('hypernym', 'instance_hypernym')
PART = ('mero_part', 'mero_member', 'mero_substance')


def load_japanese() -> tuple[dict[str, list[str]], dict[str, set[str]]]:
    """ILI → その意味の日本語の語 / 語 → その語が属する ILI。"""
    synset_ili: dict[str, str] = {}
    synset_words: dict[str, list[str]] = defaultdict(list)
    for _, el in ET.iterparse(WNJA_XML):
        if el.tag == 'Synset':
            ili = el.get('ili')
            if ili:
                synset_ili[el.get('id')] = ili
            el.clear()
        elif el.tag == 'LexicalEntry':
            w = normalize(el.find('Lemma').get('writtenForm', ''))
            if w:
                for sense in el.findall('Sense'):
                    synset_words[sense.get('synset')].append(w)
            el.clear()

    ili_words: dict[str, list[str]] = defaultdict(list)
    word_ilis: dict[str, set[str]] = defaultdict(set)
    for sid, words in synset_words.items():
        ili = synset_ili.get(sid)
        if not ili:
            continue
        for w in words:
            if w not in ili_words[ili]:
                ili_words[ili].append(w)
            word_ilis[w].add(ili)
    return ili_words, word_ilis


def load_english_relations() -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """ILI → 上位の ILI / ILI → 部分の ILI。"""
    up: dict[str, set[str]] = defaultdict(set)
    part: dict[str, set[str]] = defaultdict(set)
    loader = getattr(yaml, 'CSafeLoader', yaml.SafeLoader)  # C 版があれば速い（56MB あるので）
    for path in sorted(OEWN_YAML.glob('*.yaml')):
        if path.name.startswith('entries-') or path.name == 'frames.yaml':
            continue
        data = yaml.load(path.read_text(encoding='utf-8'), Loader=loader) or {}
        # まず「この版の synset id → ILI」を作る（関係の行き先は synset id で書かれている）
        for sid, s in data.items():
            if isinstance(s, dict) and s.get('ili'):
                ID_TO_ILI[sid] = s['ili']
        RAW.append(data)
    for data in RAW:
        for sid, s in data.items():
            if not isinstance(s, dict):
                continue
            ili = s.get('ili')
            if not ili:
                continue
            for key in UP:
                for t in s.get(key, []) or []:
                    if t in ID_TO_ILI:
                        up[ili].add(ID_TO_ILI[t])
            for key in PART:
                for t in s.get(key, []) or []:
                    if t in ID_TO_ILI:
                        part[ili].add(ID_TO_ILI[t])
    return up, part


ID_TO_ILI: dict[str, str] = {}
RAW: list[dict] = []


def main() -> None:
    if not OEWN_YAML.exists():
        sys.exit(f'{OEWN_YAML} がない。先に tools/fetch_sources.sh を実行して')
    print('関係を生成中…', file=sys.stderr)
    rank = load_rank()
    ili_words, word_ilis = load_japanese()
    up, part = load_english_relations()

    # 逆向き：下位（上位の逆）・全体（部分の逆）
    down: dict[str, set[str]] = defaultdict(set)
    whole: dict[str, set[str]] = defaultdict(set)
    for a, bs in up.items():
        for b in bs:
            down[b].add(a)
    for a, bs in part.items():
        for b in bs:
            whole[b].add(a)

    UNKNOWN = word_rank('\uffff', rank)  # 頻度データにない語の順位

    def words_of(ilis: set[str], exclude: set[str]) -> list[str]:
        out: list[str] = []
        for i in ilis:
            for w in ili_words.get(i, []):
                # 頻度データに無い語（「年代順の継続」のような訳語・まず使われない語）は出さない
                if w not in exclude and w not in out and word_rank(w, rank) < UNKNOWN:
                    out.append(w)
        out.sort(key=lambda w: (word_rank(w, rank), w))
        return out[:MAX_PER_KIND]

    result: dict[str, list[list[str]]] = {}
    def sense_score(ili: str, head: str) -> float:
        others = sorted(word_rank(x, rank) for x in ili_words.get(ili, []) if x != head)[:3]
        return sum(others) / len(others) if others else UNKNOWN

    for w, all_ilis in word_ilis.items():
        # 同じ意味の語（＝類語）は類語の欄に出るので、連想からは外す（使わない意味の語も含めて外す）
        same = {x for i in all_ilis for x in ili_words.get(i, [])}
        ilis = set(sorted(all_ilis, key=lambda i: (sense_score(i, w), i))[:SENSES_PER_WORD])  # 同点は番号順（毎回同じ結果にする）
        cols = [
            words_of({t for i in ilis for t in up.get(i, ())}, same),
            words_of({t for i in ilis for t in down.get(i, ())}, same),
            words_of({t for i in ilis for t in part.get(i, ())}, same),
            words_of({t for i in ilis for t in whole.get(i, ())}, same),
        ]
        if any(cols):
            result[w] = cols

    # 同じ語が何千回も出てくる（「時間」「建物」…）ので、語を一覧にして番号で参照する。7MB → 半分以下
    words: list[str] = []
    wid: dict[str, int] = {}

    def ref(x: str) -> int:
        if x not in wid:
            wid[x] = len(words)
            words.append(x)
        return wid[x]

    packed = {w: [[ref(x) for x in col] for col in cols] for w, cols in result.items()}
    body = json.dumps({'words': words, 'rel': packed}, ensure_ascii=False, separators=(',', ':'))
    header = (
        '// 自動生成ファイル。直接編集しない（tools/build_relations.py で再生成する）。\n'
        '// 元データ: 日本語WordNet（語）/ Open English WordNet（意味どうしの関係）\n'
        '// ライセンスは THIRD_PARTY_NOTICES.md を参照。\n'
    )
    OUT.write_text(header + 'window.KOTOBA_RELATIONS = ' + body + ';\n', encoding='utf-8')
    kb = OUT.stat().st_size / 1024 / 1024
    print(f'→ {OUT}  見出し語 {len(result):,} / {kb:.1f} MB', file=sys.stderr)


if __name__ == '__main__':
    main()
