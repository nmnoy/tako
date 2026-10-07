// kotoba - 動詞の活用（ライブラリなしのルールベース）
//
// やること:
//   1. 本文中の「佇んで」から辞書形「佇む」と活用の形（て形）を割り出す   … deinflect()
//   2. 候補「立ち止まる」を同じ形に活用させて「立ち止まって」を作る        … conjugate()
//
// 方針:
//   置換する範囲に「活用で変わる部分」を全部含め、残りの部分（ない・れる・ます…）は
//   五段動詞の形に揃えておく。こうすると、元が一段動詞でも候補が五段動詞でも、
//   残りの部分を触らずに差し替えるだけで文が成立する。
//     見ら|れる  ↔  歩か|れる   （一段の受け身は「ら」まで置換範囲に入れる）
//     見よ|う    ↔  歩こ|う     （一段の意志形は「よ」まで入れる）
//     佇んで|いた ↔ 立ち止まって|いた（て・で は動詞によって変わるので範囲に入れる）
//
// 形の名前:
//   a  : 未然形（ない・ず が続く）       aR : 未然形（れる・せる が続く）
//   i  : 連用形（ます・たい が続く）     e  : 仮定形・可能（ば・る が続く）
//   o  : 意志形（う が続く）             te : て形（て・で まで含む）   ta : た形（た・だ まで含む）
//
// 既知の限界:
//   - 「〜る」で終わる動詞が五段か一段かは、送り仮名と例外リストで推定している（帰る・走る 等）
//   - カ変（来る）、ザ変（感ずる）、「ちゃ・じゃ」などの縮約形は扱わない（候補から外れる / 引けない）

(function (root) {
  'use strict';

  // 五段動詞の行。[未然, 連用, 仮定, 意志]
  const GODAN_ROWS = {
    'う': ['わ', 'い', 'え', 'お'],
    'く': ['か', 'き', 'け', 'こ'],
    'ぐ': ['が', 'ぎ', 'げ', 'ご'],
    'す': ['さ', 'し', 'せ', 'そ'],
    'つ': ['た', 'ち', 'て', 'と'],
    'ぬ': ['な', 'に', 'ね', 'の'],
    'ぶ': ['ば', 'び', 'べ', 'ぼ'],
    'む': ['ま', 'み', 'め', 'も'],
    'る': ['ら', 'り', 'れ', 'ろ'],
  };
  const ROW_FORMS = ['a', 'i', 'e', 'o'];

  // 音便：て形の直前の文字と、続くのが「て」か「で」か
  const ONBIN = {
    'う': ['っ', 'て'], 'つ': ['っ', 'て'], 'る': ['っ', 'て'],
    'く': ['い', 'て'], 'ぐ': ['い', 'で'],
    'ぬ': ['ん', 'で'], 'ぶ': ['ん', 'で'], 'む': ['ん', 'で'],
    'す': ['し', 'て'],
  };
  const TA = { 'て': 'た', 'で': 'だ' };

  // 「る」の前がイ段・エ段なら基本は一段動詞（食べる・起きる）
  const I_E_KANA = new Set('いきぎしじちぢにひびぴみりえけげせぜてでねへべぺめれ');
  // …だけど五段のもの（ひらがな・送り仮名つきで書かれたとき用。漢字1字+る は下で別に判定）
  const GODAN_RU_EXCEPTIONS = new Set([
    'しる', 'はしる', 'かえる', 'はいる', 'へる', 'ける', 'ちる', 'しゃべる', 'すべる', 'あせる',
    'ねる', 'ひねる', 'うねる', 'くねる', 'つねる', 'おもねる', 'あざける', 'せびる', 'びびる',
    'いじる', 'なじる', 'かじる', 'ねじる', 'よじる', 'ほじる', 'もじる', 'しくじる', 'ちぎる',
    'にぎる', 'かぎる', 'さえぎる', 'みなぎる', 'まいる', 'おちいる', 'ののしる', 'そしる',
    'ひるがえる', 'よみがえる', 'くつがえる',
    '交じる', '混じる', '入り混じる', '入り交じる', '捩じる', '甦える',
  ]);
  // 漢字1字＋る の一段動詞（それ以外の 漢字1字＋る は五段：走る・切る・知る・帰る…）
  const ICHIDAN_ONE_KANJI = new Set('見寝着居出似煮干射得経鋳診観視看');

  const isKanji = (ch) => /[一-鿿々]/.test(ch || '');

  // 動詞の種類を判定する。扱えない動詞は null
  function classify(verb) {
    if (!verb || verb.length < 2) return null;
    if (verb === '来る' || verb === 'くる' || /て来る$|てくる$/.test(verb)) return null; // カ変
    if (/出来る$/.test(verb)) return { type: 'ichidan', stem: verb.slice(0, -1) };
    if (verb.endsWith('する')) return { type: 'sahen', stem: verb.slice(0, -2) };
    if (verb.endsWith('ずる')) return null; // ザ変（感ずる）

    const last = verb.at(-1);
    if (!GODAN_ROWS[last]) return null;

    if (last === 'る') {
      const prev = verb.at(-2);
      // ひらがなの例外は完全一致だけ（末尾一致にすると「ける(蹴る)」が「駆ける」に引っかかる）。
      // 「入り混じる」のような漢字で始まる例外は、複合動詞も拾えるよう末尾一致
      const isException = GODAN_RU_EXCEPTIONS.has(verb) ||
        [...GODAN_RU_EXCEPTIONS].some((x) => isKanji(x[0]) && verb.endsWith(x));
      if (I_E_KANA.has(prev) && !isException) {
        return { type: 'ichidan', stem: verb.slice(0, -1) };
      }
      if (isKanji(prev) && ICHIDAN_ONE_KANJI.has(prev)) {
        return { type: 'ichidan', stem: verb.slice(0, -1) };
      }
    }

    const isIku = last === 'く' && /(行く|いく|ゆく)$/.test(verb); // 行く だけ て形が「行って」
    return { type: 'godan', stem: verb.slice(0, -1), k: last, isIku };
  }

  function onbinOf(c) {
    if (c.isIku) return ['っ', 'て'];
    return ONBIN[c.k];
  }

  // 動詞を指定の形に活用させる。next は置換範囲の直後の文字列（形の細かい分岐に使う）
  function conjugate(verb, form, next = '') {
    const c = classify(verb);
    if (!c) return null;
    const { stem } = c;

    if (c.type === 'godan') {
      const row = GODAN_ROWS[c.k];
      switch (form) {
        case 'a': case 'aR': return stem + row[0];
        case 'i': return stem + row[1];
        case 'e': return stem + row[2];
        case 'o': return stem + row[3];
        case 'te': { const [o, t] = onbinOf(c); return stem + o + t; }
        case 'ta': { const [o, t] = onbinOf(c); return stem + o + TA[t]; }
        default: return null;
      }
    }

    if (c.type === 'ichidan') {
      switch (form) {
        case 'a': case 'i': return stem;
        case 'aR': return stem + (next.startsWith('れ') ? 'ら' : 'さ'); // 見ら|れる / 見さ|せる
        case 'e': return stem + 'れ';
        case 'o': return stem + 'よ';
        case 'te': return stem + 'て';
        case 'ta': return stem + 'た';
        default: return null;
      }
    }

    if (c.type === 'sahen') {
      switch (form) {
        case 'a': return stem + (next.startsWith('ず') ? 'せ' : 'し'); // せず / しない
        case 'aR': return stem + 'さ';                                 // される / させる
        case 'i': return stem + 'し';
        case 'e': return stem + 'すれ';
        case 'o': return stem + 'しよ';
        case 'te': return stem + 'して';
        case 'ta': return stem + 'した';
        default: return null;
      }
    }
    return null;
  }

  // text の start から始まる活用形の動詞を探す。
  // isVerb(辞書形) が true を返す動詞だけを候補にする。
  // verbRank(辞書形) は小さいほどよく使う動詞（「行って」が 行く か 行う か、のような曖昧さの解消に使う）
  // 戻り値: { verb, end, form } の配列（置換範囲が長い順 → よく使う順）。見つからなければ空配列
  function deinflect(text, start, maxLen, isVerb, verbRank = () => 0) {
    const hits = [];
    const limit = Math.min(maxLen, text.length - start);

    for (let len = limit; len >= 1; len--) {
      const surf = text.slice(start, start + len);
      const last = surf.at(-1);
      const body = surf.slice(0, -1);
      const after = text.slice(start + len, start + len + 3);
      const end = start + len;

      // --- 五段 ---
      for (const k of Object.keys(GODAN_ROWS)) {
        const verb = body + k;
        if (!body || !isVerb(verb)) continue;
        const c = classify(verb);
        if (!c || c.type !== 'godan') continue;

        const [o, t] = onbinOf(c);
        if (last === o) {
          if (after[0] === t) hits.push({ verb, end: end + 1, form: 'te' });
          if (after[0] === TA[t]) hits.push({ verb, end: end + 1, form: 'ta' });
        }

        GODAN_ROWS[k].forEach((kana, i) => {
          if (last !== kana) return;
          const form = ROW_FORMS[i];
          if (form === 'i' && /^[てでただ]/.test(after)) return; // 書きて は無い（音便側で拾う）
          if (form === 'o' && after[0] !== 'う') return;
          hits.push({ verb, end, form: form === 'a' && /^[れせ]/.test(after) ? 'aR' : form });
        });
      }

      // --- 一段（「見」「眺め」＋活用語尾） ---
      {
        const verb = surf + 'る';
        const c = isVerb(verb) && classify(verb);
        if (c && c.type === 'ichidan' && after[0] !== 'る' && after[0] !== 'ろ') {
          if (after.startsWith('られ') || after.startsWith('させ')) hits.push({ verb, end: end + 1, form: 'aR' });
          else if (/^(ない|なか|なく|なけ|ず|ぬ|まい)/.test(after)) hits.push({ verb, end, form: 'a' });
          else if (after.startsWith('よう')) hits.push({ verb, end: end + 1, form: 'o' });
          else if (after[0] === 'れ') hits.push({ verb, end: end + 1, form: 'e' });
          else if (after[0] === 'て') hits.push({ verb, end: end + 1, form: 'te' });
          else if (after[0] === 'た') hits.push({ verb, end: end + 1, form: 'ta' });
          else hits.push({ verb, end, form: 'i' });
        }
      }

      // --- サ変（「散策し」＋活用語尾） ---
      if (/(し|さ|せ)$/.test(surf) && body) {
        const verb = body + 'する';
        if (isVerb(verb)) {
          if (last === 'し') {
            if (after[0] === 'て') hits.push({ verb, end: end + 1, form: 'te' });
            else if (after[0] === 'た') hits.push({ verb, end: end + 1, form: 'ta' });
            else if (after.startsWith('よう')) hits.push({ verb, end: end + 1, form: 'o' });
            else if (after[0] === 'な') hits.push({ verb, end, form: 'a' });
            else hits.push({ verb, end, form: 'i' });
          } else if (last === 'さ') {
            hits.push({ verb, end, form: 'aR' });
          } else if (last === 'せ') {
            hits.push({ verb, end, form: after[0] === 'ず' ? 'a' : 'aR' });
          }
        }
      }
      if (surf.endsWith('すれ') && surf.length > 2) {
        const verb = surf.slice(0, -2) + 'する';
        if (isVerb(verb)) hits.push({ verb, end, form: 'e' });
      }

      if (hits.length) break; // 一番長い表層で見つかったものを優先
    }

    return hits.sort((x, y) => (y.end - x.end) || (verbRank(x.verb) - verbRank(y.verb)));
  }

  root.KotobaVerb = { classify, conjugate, deinflect };
})(typeof window !== 'undefined' ? window : globalThis);
