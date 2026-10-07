// kotoba - 検索と置換
//
// 構成:
//   前半（DOM に触らない）: 一致の探し方と置換文字列の作り方。node だけでテストできる
//   後半（create）       : 検索バーの UI、ハイライトの描画、置換の実行
//
// ハイライトの仕組み:
//   textarea の中の文字には色を付けられない（CSS Custom Highlight API も textarea の中には効かない）。
//   そこで caret.js のミラーで一致箇所の画面上の位置を測り、透明な textarea の「裏」に色の矩形を敷く。
//   一致が数千件あっても重くならないよう、画面に見えている範囲の一致だけ描く。
//
// ゆれの扱い:
//   NFKC で正規化すると「㌔→キロ」のように文字数が変わり、見つけた位置が元の文章とずれる。
//   そこで「1文字を1文字に変換する」折りたたみだけを使う（全角英数→半角、大文字→小文字、カタカナ→ひらがな）。

(function (root) {
  'use strict';

  // ===============================================================
  // 一致の探し方（DOM なし）
  // ===============================================================

  // 1文字ずつ、長さを変えずに比較用の形にそろえる
  function fold(str, opts) {
    if (!opts.width && !opts.kana) return str;
    let out = '';
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (opts.width) {
        if (c >= 0xff01 && c <= 0xff5e) c -= 0xfee0;      // 全角英数記号 → 半角
        if (c >= 0x41 && c <= 0x5a) c += 0x20;            // A-Z → a-z
      }
      if (opts.kana && c >= 0x30a1 && c <= 0x30f6) c -= 0x60; // カタカナ → ひらがな
      out += String.fromCharCode(c);
    }
    return out;
  }

  // 動詞の活用形ごとに、後ろに続きうる語（ここは置換しない「残す部分」）
  const VERB_FORMS = [
    ['a', ['ない', 'なかっ', 'なく', 'なけれ', 'ず']],
    ['aR', ['れ', 'せ']],
    ['i', ['ます', 'まし', 'ませ', 'たい', 'たく', 'たかっ', 'ながら', 'つつ']],
    ['e', ['ば', 'る']],
    ['o', ['う']],
    ['te', ['']],
    ['ta', ['']],
  ];
  const ADJ_SUFFIXES = ['い', 'かっ', 'く', 'けれ', 'さ', 'そう', 'すぎ', 'げ', 'がる', 'がっ', 'み'];

  // 検索語から、実際に探す文字列の一覧を作る。
  //   text : 探す文字列
  //   keep : 末尾の何文字は置換しないか（「見ない」の「ない」）
  //   form : 活用形（置換語を同じ形に活用させるのに使う）
  function variantsFor(query, opts, lex) {
    const list = [{ text: query, keep: 0, form: null }];
    if (opts.conj && lex) {
      if (lex.isVerb(query)) {
        list[0].form = 'u'; // 辞書形そのもの
        for (const [form, suffixes] of VERB_FORMS) {
          for (const suffix of suffixes) {
            const span = lex.Verb.conjugate(query, form, suffix);
            if (span) list.push({ text: span + suffix, keep: suffix.length, form });
          }
        }
      } else if (lex.isAdjective(query)) {
        const stem = query.slice(0, -1);
        list.length = 0;
        for (const suffix of ADJ_SUFFIXES) list.push({ text: stem + suffix, keep: suffix.length, form: 'adj' });
      }
    }
    // 同じ文字列が別の形から2回作られることがある（一段動詞の未然形と連用形など）
    const seen = new Set();
    return list.filter((v) => v.text && !seen.has(v.text) && seen.add(v.text));
  }

  // 本文 text の中から query を全部探す。戻り値は開始位置の順に並んだ一致の配列
  function findAll(text, query, opts, lex, limit = 10000) {
    if (!query) return [];
    const ft = fold(text, opts);
    const hits = [];
    for (const v of variantsFor(query, opts, lex)) {
      const fv = fold(v.text, opts);
      for (let i = ft.indexOf(fv); i !== -1 && hits.length < limit * 2; i = ft.indexOf(fv, i + 1)) {
        hits.push({ start: i, end: i + fv.length, keep: v.keep, form: v.form, text: text.slice(i, i + fv.length) });
      }
    }
    // 開始位置の順。同じ位置なら長い方を優先し、重なった一致は捨てる
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    let last = -1;
    for (const h of hits) {
      if (h.start < last) continue;
      out.push(h);
      last = h.end;
      if (out.length >= limit) break;
    }
    return out;
  }

  // 一致 m の「置換する部分」に入れる文字列。text は置換前の本文（活用形の続きを見るのに使う）
  //   戻り値 { insert, end } : [m.start, end) を insert に差し替える
  function replacementFor(m, repl, text, lex) {
    const spanEnd = m.end - m.keep;
    if (!m.form || m.form === 'u') return { insert: repl, end: spanEnd };

    if (m.form === 'adj') {
      // 暑|かった → 蒸し暑|かった。置換語が形容詞でなければ、活用語尾ごと置き換える
      if (repl.endsWith('い')) return { insert: repl.slice(0, -1), end: spanEnd };
      return { insert: repl, end: m.end };
    }

    // 動詞：置換語も同じ形に活用させる（佇んで → 立ち止まって）
    if (lex && (lex.isVerb(repl) || repl.endsWith('する'))) {
      const next = text.slice(spanEnd, spanEnd + 3);
      const conj = lex.Verb.conjugate(repl, m.form, next);
      if (conj) return { insert: conj, end: spanEnd };
    }
    // 活用できない置換語（名詞など）は、活用語尾ごと置き換える
    return { insert: repl, end: m.end };
  }

  // ===============================================================
  // 検索バー（DOM あり）
  // ===============================================================

  const MAX_DRAW = 400; // 1画面に描くハイライトの上限

  function create({ editor, layer, caret, replaceRange, lex, options, onOptionsChange }) {
    const $ = (id) => document.getElementById(id);
    const bar = $('findBar');
    const input = $('findInput');
    const replaceRow = $('replaceRow');
    const replaceInput = $('replaceInput');
    const countEl = $('findCount');
    const noteEl = $('findNote');

    const marks = document.createElement('div');
    marks.className = 'find-layer';
    marks.setAttribute('aria-hidden', 'true');
    layer.prepend(marks);

    let matches = [];
    let current = -1;
    let rerunTimer = 0;
    let composing = false;        // 検索欄で変換中
    let editorComposing = false;  // 本文で変換中
    let selfEdit = false;         // 置換で自分が本文を書き換えている最中（その input には反応しない）

    const isOpen = () => !bar.hidden;

    // ------------------------------------------------------------
    // 検索の実行
    // ------------------------------------------------------------
    function run(anchor = null) {
      if (!isOpen()) return;
      // 探し直す前に「どこから探すか」を決めておく（今見ている一致 → なければ本文のカーソル位置）
      if (anchor === null) anchor = matches[current] ? matches[current].start : editor.selectionStart;

      const query = input.value;
      matches = query ? findAll(editor.value, query, options, lex) : [];

      const idx = matches.findIndex((m) => m.start >= anchor);
      current = !matches.length ? -1 : idx === -1 ? 0 : idx; // 末尾より後ろなら先頭に戻る

      updateCount();
      updateNote();
      if (current >= 0) reveal(matches[current]);
      draw();
    }

    function scheduleRun(delay = 150) {
      clearTimeout(rerunTimer);
      rerunTimer = setTimeout(() => run(), delay);
    }

    function updateCount() {
      if (!input.value) countEl.textContent = '';
      else if (!matches.length) countEl.textContent = 'なし';
      else countEl.textContent = `${current + 1} / ${matches.length >= 10000 ? '10000+' : matches.length}`;
      bar.classList.toggle('no-match', !!input.value && !matches.length);
    }

    function updateNote(message = '') {
      if (message) { noteEl.textContent = message; return; }
      const q = input.value;
      let note = '';
      if (options.conj && q && !lex.isVerb(q) && !lex.isAdjective(q)) {
        note = '「活用」は動詞・形容詞の辞書形で検索したときに効く（例：佇む、暑い）';
      } else if (options.conj && !replaceRow.hidden && replaceInput.value && lex.isVerb(q) &&
                 !lex.isVerb(replaceInput.value) && !replaceInput.value.endsWith('する')) {
        note = '置換語が動詞じゃないので、活用形の一致は活用語尾ごと置き換わる';
      }
      noteEl.textContent = note;
    }

    // ------------------------------------------------------------
    // 一致へ移動（画面内に入るようにスクロール）
    // ------------------------------------------------------------
    function reveal(m) {
      // 閉じたときにその一致が選択された状態で本文に戻れるよう、選択だけ先に合わせておく
      // （フォーカスは検索バーのまま。フォーカスのない textarea は選択を表示しないので邪魔にならない）
      editor.setSelectionRange(m.start, m.end);
      caret.syncNow();
      const r = caret.rangeRects(m.start, m.end)[0];
      if (!r) return;
      const box = editor.getBoundingClientRect();
      if (caret.isVertical()) {
        const cx = r.x + r.w / 2;
        if (cx < box.left + 40 || cx > box.left + editor.clientWidth - 40) {
          editor.scrollLeft += cx - (box.left + editor.clientWidth / 2);
        }
      } else {
        const cy = r.y + r.h / 2;
        if (cy < box.top + 40 || cy > box.top + editor.clientHeight - 40) {
          editor.scrollTop += cy - (box.top + editor.clientHeight / 2);
        }
      }
      caret.schedule();
    }

    function step(dir) {
      if (!matches.length) return;
      current = (current + dir + matches.length) % matches.length;
      updateCount();
      reveal(matches[current]);
      draw();
    }

    // ------------------------------------------------------------
    // ハイライトの描画（画面に見えている一致だけ）
    // ------------------------------------------------------------
    function draw() {
      marks.textContent = '';
      if (!isOpen() || !matches.length) return;
      caret.syncNow();

      // 一致は本文の順に並んでいるので、「画面より前」でない最初の一致を二分探索で探す
      const sideOf = (m) => caret.paraSide(caret.paraIndexOf(m.start));
      let lo = 0;
      let hi = matches.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sideOf(matches[mid]) < 0) lo = mid + 1; else hi = mid;
      }

      const box = editor.getBoundingClientRect();
      const clip = {
        left: box.left + editor.clientLeft,
        top: box.top + editor.clientTop,
        right: box.left + editor.clientLeft + editor.clientWidth,
        bottom: box.top + editor.clientTop + editor.clientHeight,
      };
      const base = layer.getBoundingClientRect();
      const frag = document.createDocumentFragment();
      let drawn = 0;

      for (let i = lo; i < matches.length && drawn < MAX_DRAW; i++) {
        const m = matches[i];
        if (sideOf(m) > 0) break; // 画面より後ろに出たら終わり
        for (const r of caret.rangeRects(m.start, m.end)) {
          // スクロールで半分隠れている一致は、見えている部分だけ塗る
          const x1 = Math.max(r.x, clip.left);
          const y1 = Math.max(r.y, clip.top);
          const x2 = Math.min(r.x + r.w, clip.right);
          const y2 = Math.min(r.y + r.h, clip.bottom);
          if (x2 <= x1 || y2 <= y1) continue;
          const el = document.createElement('div');
          el.className = 'find-mark' + (i === current ? ' current' : '');
          el.style.transform = `translate(${x1 - base.left}px, ${y1 - base.top}px)`;
          el.style.width = x2 - x1 + 'px';
          el.style.height = y2 - y1 + 'px';
          frag.appendChild(el);
          drawn++;
        }
      }
      marks.appendChild(frag);
    }

    // ------------------------------------------------------------
    // 置換
    // ------------------------------------------------------------
    // 置換対象がまだ見つけたときのままか（その後に本文を書き換えていないか）
    function stillThere(m) {
      return m && editor.value.slice(m.start, m.end) === m.text;
    }

    function replaceOne() {
      const m = matches[current];
      if (!stillThere(m)) { run(); return; }
      const { insert, end } = replacementFor(m, replaceInput.value, editor.value, lex);
      selfEdit = true;
      replaceRange(m.start, end, insert);         // execCommand なので Ctrl+Z で戻せる
      selfEdit = false;
      replaceInput.focus();                       // replaceRange が本文にフォーカスを移すので戻す
      // 置換した直後の位置から次を探す（置換語に検索語が含まれていても、同じ所を延々置換しない）
      run(m.start + insert.length + (m.end - end));
    }

    function replaceAll() {
      const text = editor.value;
      const list = findAll(text, input.value, options, lex);
      if (!list.length) return;

      // 後ろから組み立てる（前から置換すると、後ろの一致の位置がずれる）
      let out = text;
      for (let i = list.length - 1; i >= 0; i--) {
        const { insert, end } = replacementFor(list[i], replaceInput.value, text, lex);
        out = out.slice(0, list[i].start) + insert + out.slice(end);
      }

      // 全文を1回で差し替える → Ctrl+Z 1回で全部戻る。
      // 全選択して差し替えるとスクロール位置が飛ぶので、覚えておいて戻す
      const { scrollTop, scrollLeft } = editor;
      const caretPos = editor.selectionStart;
      editor.focus();
      editor.select();
      selfEdit = true;
      if (!document.execCommand('insertText', false, out)) {
        editor.value = out;
        editor.dispatchEvent(new Event('input'));
      }
      selfEdit = false;
      editor.scrollTop = scrollTop;
      editor.scrollLeft = scrollLeft;
      editor.setSelectionRange(Math.min(caretPos, out.length), Math.min(caretPos, out.length));
      replaceInput.focus();

      current = -1;
      run(0);
      updateNote(`${list.length}件置換した（本文で Ctrl+Z を押すと全部戻る）`);
    }

    // ------------------------------------------------------------
    // 開く・閉じる
    // ------------------------------------------------------------
    function open({ replace = false } = {}) {
      bar.hidden = false;
      if (replace) replaceRow.hidden = false;
      bar.querySelector('[data-act="toggleReplace"]').setAttribute('aria-expanded', String(!replaceRow.hidden));

      // 本文で1行以内の語を選んでいれば、それを検索語にする
      const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      if (sel && sel.length <= 100 && !sel.includes('\n')) input.value = sel;

      (replace && input.value ? replaceInput : input).focus();
      input.select();
      current = -1;
      run(editor.selectionStart);
    }

    function close() {
      bar.hidden = true;
      marks.textContent = '';
      clearTimeout(rerunTimer);
      updateNote(' ');
      editor.focus();
      // 最後に見ていた一致を選択した状態で本文に戻る（そのまま類語を引ける）
      const m = matches[current];
      if (stillThere(m)) editor.setSelectionRange(m.start, m.end);
      matches = [];
      current = -1;
    }

    // ------------------------------------------------------------
    // イベント
    // ------------------------------------------------------------
    const isMod = (e) => e.ctrlKey || e.metaKey;

    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; current = -1; scheduleRun(0); });
    input.addEventListener('input', () => {
      if (composing) return; // 変換中の未確定の文字で検索しない
      current = -1;
      scheduleRun();
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });

    replaceInput.addEventListener('input', () => updateNote());
    replaceInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (isMod(e)) replaceAll(); else replaceOne();
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });

    // ボタンを押しても入力欄のフォーカスを奪わない（候補ボタンと同じ理由）
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'next') step(1);
      else if (act === 'prev') step(-1);
      else if (act === 'close') close();
      else if (act === 'replace') replaceOne();
      else if (act === 'replaceAll') replaceAll();
      else if (act === 'toggleReplace') {
        replaceRow.hidden = !replaceRow.hidden;
        btn.setAttribute('aria-expanded', String(!replaceRow.hidden));
        if (!replaceRow.hidden) replaceInput.focus();
        updateNote();
      } else if (btn.dataset.opt) {
        const key = btn.dataset.opt;
        options[key] = !options[key];
        btn.setAttribute('aria-pressed', String(options[key]));
        onOptionsChange();
        current = -1;
        run();
      }
    });

    for (const btn of bar.querySelectorAll('[data-opt]')) {
      btn.setAttribute('aria-pressed', String(!!options[btn.dataset.opt]));
    }

    // 本文が変わったら検索し直す（変換中は待つ）。スクロール等の描画のたびにハイライトを描き直す
    editor.addEventListener('compositionstart', () => { editorComposing = true; });
    editor.addEventListener('compositionend', () => { editorComposing = false; if (isOpen()) scheduleRun(200); });
    // 置換で自分が書き換えたときは、すぐ後で自分で探し直すので反応しない
    // （反応すると「○件置換した」のメッセージが、探し直しのついでに消える）
    editor.addEventListener('input', () => { if (isOpen() && !editorComposing && !selfEdit) scheduleRun(200); });
    caret.onFlush(() => { if (isOpen()) draw(); });

    return {
      open,
      close,
      isOpen,
      next: () => step(1),
      prev: () => step(-1),
      refresh: () => { if (isOpen()) { current = -1; run(0); } },
    };
  }

  root.KotobaFind = { fold, variantsFor, findAll, replacementFor, create };
})(typeof window !== 'undefined' ? window : globalThis);
