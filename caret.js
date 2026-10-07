// kotoba - 自前のカーソルと、カーソル位置の計測
//
// なぜ自前で描くのか:
//   ブラウザ標準のカーソルは、点滅の速さも「打っている間は止める」も CSS から制御できない（OS の設定次第）。
//   そこで標準カーソルは caret-color: transparent で透明にし、同じ位置に自前のカーソルを重ねて描く。
//   IME の変換候補ウィンドウは透明な標準カーソルの位置に出るので、そのまま正しい場所に出る。
//
// カーソル位置の測り方（ミラー）:
//   textarea は「何文字目が画面のどこにあるか」を教えてくれない。
//   そこで textarea と寸分違わない見えない div（ミラー）を同じ場所に重ね、同じ文章を流し込んで測る。
//   10万字を毎回丸ごと流し込むと、それ自体が入力遅延の原因になるので、
//   ミラーは「1段落 = 1つの div」に分けておき、打鍵のたびに変わった段落の div だけ書き換える。
//   ブラウザは変わっていない段落の折り返し計算を使い回すので、文章が長くても重くならない。
//
// 使い方:
//   const caret = KotobaCaret.create(editor, layer);  // layer は editor を包む position:relative の要素
//   caret.schedule({ text: true })  // 文章が変わった
//   caret.schedule()                // カーソルが動いた・スクロールした
//   caret.layout()                  // フォント・縦書き・サイズが変わった
//   caret.setTypewriter(true)       // タイプライタースクロール

(function (root) {
  'use strict';

  const SOLID_AFTER_INPUT = 500; // 手が止まってから点滅を再開するまで(ms)

  // ミラーに写す textarea のスタイル。1つでも漏れると折り返し位置がずれてカーソルがずれる
  const COPY_STYLES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontFeatureSettings', 'fontKerning',
    'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent', 'textTransform', 'textAlign',
    'writingMode', 'textOrientation', 'direction', 'tabSize',
    'whiteSpace', 'wordBreak', 'overflowWrap', 'lineBreak',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  ];

  function create(editor, layer) {
    const mirror = document.createElement('div');
    mirror.className = 'caret-mirror';
    mirror.setAttribute('aria-hidden', 'true');

    const caret = document.createElement('div');
    caret.className = 'caret hidden';
    caret.setAttribute('aria-hidden', 'true');

    layer.append(mirror, caret);

    let paras = [];        // 段落ごとの文字列（ミラーの div と1対1）
    let paraStarts = [0];  // 各段落が本文の何文字目から始まるか（二分探索で段落を引くため）
    let textDirty = true;
    let frame = 0;
    let solidTimer = 0;
    let typewriter = false;
    let wantCenter = false;  // 次のフレームでタイプライター位置に合わせるか
    let composing = false;
    const flushListeners = []; // 描画のたびに呼ぶ処理（検索のハイライト等）

    // ------------------------------------------------------------
    // ミラーの見た目を textarea に合わせる
    // ------------------------------------------------------------
    // タイプライター用の余白。1行目も最終行も画面の中央まで来られるよう、
    // 入力欄の実際の高さ（縦書きは幅）から計算して入れる。
    // CSS だと padding の % は「幅」基準で、高さに対しては書けない。vh で書くと、
    // 検索バーやタイトルのぶん合計が入力欄より大きくなって、textarea がはみ出す
    function applyTypewriterPadding() {
      const st = editor.style;
      st.paddingTop = st.paddingBottom = st.paddingLeft = st.paddingRight = '';
      if (!typewriter) return;
      const cs = getComputedStyle(editor);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.9;
      const box = editor.getBoundingClientRect(); // 余白を変えても箱の大きさは flex で決まっているので変わらない
      if (cs.writingMode.startsWith('vertical')) {
        const half = Math.max(0, box.width / 2 - line / 2);
        st.paddingRight = half + 'px';
        st.paddingLeft = half + 'px';
      } else {
        st.paddingTop = Math.max(0, box.height * 0.45 - line / 2) + 'px';
        st.paddingBottom = Math.max(0, box.height * 0.55 - line / 2) + 'px';
      }
    }

    // ミラーを合わせたときの textarea の中身の幅・高さ。これが変わったら合わせ直す
    let syncedW = -1;
    let syncedH = -1;

    function layout() {
      applyTypewriterPadding();
      copyStyles();
      // 大きさが変わると中央の位置も変わるので、タイプライター中なら寄せ直す（検索バーの開け閉めなど）
      schedule({ text: true, center: true });
    }

    function copyStyles() {
      const cs = getComputedStyle(editor);
      for (const p of COPY_STYLES) mirror.style[p] = cs[p];
      // textarea の折り返しは pre-wrap + break-word。div のデフォルトとは違うので明示する
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.overflowWrap = 'break-word';

      // clientWidth/Height はスクロールバーを除いた幅。スクロールバーが幅を取る環境（Windows 等）でも
      // 折り返し位置が一致するよう、textarea の「中身が使える幅」にぴったり合わせる
      mirror.style.width = editor.clientWidth + 'px';
      mirror.style.height = editor.clientHeight + 'px';
      mirror.style.left = editor.offsetLeft + editor.clientLeft + 'px';
      mirror.style.top = editor.offsetTop + editor.clientTop + 'px';

      caret.classList.toggle('vertical', cs.writingMode.startsWith('vertical'));
      syncedW = editor.clientWidth;
      syncedH = editor.clientHeight;
    }

    // ------------------------------------------------------------
    // 文章を写す（変わった段落だけ）
    // ------------------------------------------------------------
    function makePara(text) {
      const div = document.createElement('div');
      // 空の段落は高さが0になってしまうので、幅のない文字を入れて1行ぶんの高さを確保する
      div.textContent = text || '​';
      return div;
    }

    function syncText() {
      const next = editor.value.split('\n');

      // 先頭から一致している段落数と、末尾から一致している段落数を数え、間だけ差し替える
      let head = 0;
      const max = Math.min(paras.length, next.length);
      while (head < max && paras[head] === next[head]) head++;
      let tail = 0;
      while (tail < max - head &&
             paras[paras.length - 1 - tail] === next[next.length - 1 - tail]) tail++;

      const removeCount = paras.length - head - tail;
      const insert = next.slice(head, next.length - tail);

      // よくあるのは「1段落の中で打っている」＝段落の数が変わらないケース。
      // このときは div を差し替えず、中の文字だけ書き換える（DOM の作り直しが減り、レイアウトも軽い）
      if (removeCount === insert.length) {
        insert.forEach((t, i) => { mirror.children[head + i].firstChild.data = t || '\u200b'; });
        paras = next;
        rebuildStarts();
        textDirty = false;
        return;
      }

      for (let i = 0; i < removeCount; i++) mirror.children[head].remove();
      const ref = mirror.children[head] || null;
      const frag = document.createDocumentFragment();
      for (const t of insert) frag.appendChild(makePara(t));
      mirror.insertBefore(frag, ref);

      paras = next;
      rebuildStarts();
      textDirty = false;
    }

    function rebuildStarts() {
      paraStarts = new Array(paras.length);
      let pos = 0;
      for (let i = 0; i < paras.length; i++) {
        paraStarts[i] = pos;
        pos += paras[i].length + 1; // +1 は改行
      }
    }

    // ------------------------------------------------------------
    // カーソル位置（画面上の座標）を測る
    // ------------------------------------------------------------
    // offset が何番目の段落に入っているか。先頭から数えると、検索で1000件測るとき
    // 1000回頭から数えることになるので、段落の開始位置の表を二分探索する
    function paraIndexOf(offset) {
      let lo = 0;
      let hi = paras.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (paraStarts[mid] <= offset) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    function locate(offset) {
      const i = paraIndexOf(offset);
      return { index: i, div: mirror.children[i], text: paras[i], at: offset - paraStarts[i] };
    }

    // 範囲 [start, end) の画面上の矩形（折り返しをまたぐと複数）。1段落の中の範囲だけ扱う
    function rangeRects(start, end) {
      const { div, text, at } = locate(start);
      if (!div) return [];
      const to = Math.min(text.length, at + (end - start));
      if (to <= at) return [];
      const range = document.createRange();
      range.setStart(div.firstChild, at);
      range.setEnd(div.firstChild, to);
      return [...range.getClientRects()].map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
    }

    // その段落が、エディタの表示範囲より前(-1)・中(0)・後(1)のどこにあるか。
    // 検索で「画面に見えている一致だけ描く」ための二分探索に使う
    function paraSide(i) {
      const div = mirror.children[i];
      if (!div) return 1;
      const r = div.getBoundingClientRect();
      const box = editor.getBoundingClientRect();
      if (caret.classList.contains('vertical')) {
        // 縦書きは右から左へ進む。表示範囲より右にあるものが「前」
        if (r.left > box.right) return -1;
        if (r.right < box.left) return 1;
        return 0;
      }
      if (r.bottom < box.top) return -1;
      if (r.top > box.bottom) return 1;
      return 0;
    }

    // ミラーを今の textarea の状態に合わせる（フレームを待たずに測りたいとき用）
    function syncNow() {
      if (editor.clientWidth !== syncedW || editor.clientHeight !== syncedH) copyStyles();
      if (textDirty) syncText();
      mirror.scrollTop = editor.scrollTop;
      mirror.scrollLeft = editor.scrollLeft;
    }

    function caretRect(offset) {
      const { div, text, at } = locate(offset);
      if (!div) return null;
      const node = div.firstChild;
      const range = document.createRange();
      const vertical = caret.classList.contains('vertical');

      // カーソルの直後の文字の「始まり」の位置 = カーソル位置。
      // 折り返し位置では、次の行の先頭に出る（ブラウザの標準カーソルと同じ）
      if (at < text.length) {
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const r = range.getClientRects()[0];
        if (r) return { x: r.left, y: r.top, w: r.width, h: r.height };
      }
      // 段落の末尾：直前の文字の「終わり」の位置
      if (at > 0) {
        range.setStart(node, at - 1);
        range.setEnd(node, at);
        const rects = range.getClientRects();
        const r = rects[rects.length - 1];
        if (r) return vertical
          ? { x: r.left, y: r.bottom, w: r.width, h: r.height }
          : { x: r.right, y: r.top, w: r.width, h: r.height };
      }
      // 空の段落：幅のない文字の位置
      range.selectNodeContents(node);
      const r = range.getClientRects()[0] || div.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }

    // ------------------------------------------------------------
    // 1フレームに1回だけ、まとめて処理する
    // ------------------------------------------------------------
    function schedule({ text = false, center = false } = {}) {
      if (text) textDirty = true;
      if (center) wantCenter = true;
      if (!frame) frame = requestAnimationFrame(flush);
    }

    function flush() {
      frame = 0;
      // 文章がはみ出してスクロールバーが出る（消える）と、textarea の外枠はそのままで中身の幅だけが変わる。
      // ResizeObserver は外枠しか見ていないので気づけず、ミラーの折り返し位置がずれてカーソルがずれる。
      // 毎フレーム中身の幅を確かめて、変わっていたら合わせ直す（数値の比較だけなので軽い）
      if (editor.clientWidth !== syncedW || editor.clientHeight !== syncedH) copyStyles();
      if (textDirty) syncText();

      const focused = document.activeElement === editor;
      const collapsed = editor.selectionStart === editor.selectionEnd;

      // タイプライター：カーソルのある行を画面の中央に保つ
      if (typewriter && wantCenter && focused && collapsed) {
        mirror.scrollTop = editor.scrollTop;
        mirror.scrollLeft = editor.scrollLeft;
        const r = caretRect(editor.selectionStart);
        if (r) {
          const box = editor.getBoundingClientRect();
          if (caret.classList.contains('vertical')) {
            const dx = (r.x + r.w / 2) - (box.left + editor.clientWidth / 2);
            if (Math.abs(dx) > 1) editor.scrollLeft += dx;
          } else {
            const dy = (r.y + r.h / 2) - (box.top + editor.clientHeight * 0.45);
            if (Math.abs(dy) > 1) editor.scrollTop += dy;
          }
        }
      }
      wantCenter = false;

      mirror.scrollTop = editor.scrollTop;
      mirror.scrollLeft = editor.scrollLeft;
      place(focused && collapsed);
      for (const fn of flushListeners) fn();
    }

    function place(visible) {
      if (!visible) {
        caret.classList.add('hidden');
        return;
      }
      const r = caretRect(editor.selectionStart);
      const box = editor.getBoundingClientRect();
      // textarea の表示範囲の外（スクロールで隠れている）なら描かない
      if (!r || r.y + r.h < box.top || r.y > box.bottom || r.x < box.left - 2 || r.x > box.right + 2) {
        caret.classList.add('hidden');
        return;
      }
      const base = layer.getBoundingClientRect();
      // 縦横を切り替えたとき、前のモードで付けた大きさが残らないよう、使わない方は必ず空にする
      if (caret.classList.contains('vertical')) {
        caret.style.height = '';
        caret.style.width = r.w + 'px';
        caret.style.transform = `translate(${r.x - base.left}px, ${r.y - base.top - 1}px)`;
      } else {
        caret.style.width = '';
        caret.style.height = r.h + 'px';
        caret.style.transform = `translate(${r.x - base.left - 1}px, ${r.y - base.top}px)`;
      }
      caret.classList.remove('hidden');
    }

    // ------------------------------------------------------------
    // 点滅：打っている間は点灯しっぱなし、手が止まって0.5秒で点滅に戻る
    // ------------------------------------------------------------
    function poke() {
      caret.classList.add('solid');
      clearTimeout(solidTimer);
      solidTimer = setTimeout(() => {
        // solid を外すとアニメーションが最初（＝点灯）から始まるので、点滅は「点いた状態」から再開する
        caret.classList.remove('solid');
      }, SOLID_AFTER_INPUT);
    }

    // ------------------------------------------------------------
    // イベント
    // ------------------------------------------------------------
    editor.addEventListener('keydown', (e) => {
      poke();
      // 矢印キーなどで行が変わったときもタイプライター位置に合わせる
      if (!e.isComposing) schedule({ center: true });
    });
    editor.addEventListener('input', () => {
      poke();
      schedule({ text: true, center: true });
    });
    editor.addEventListener('compositionstart', () => { composing = true; });
    editor.addEventListener('compositionend', () => {
      composing = false;
      schedule({ text: true, center: true });
    });
    editor.addEventListener('keyup', () => schedule());
    editor.addEventListener('mousedown', poke);
    editor.addEventListener('mouseup', () => schedule());
    editor.addEventListener('select', () => schedule());
    editor.addEventListener('focus', () => { poke(); schedule(); });
    editor.addEventListener('blur', () => schedule());
    // ホイールでスクロールしたらカーソルもついてくる（タイプライター位置には戻さない）
    editor.addEventListener('scroll', () => schedule(), { passive: true });

    // ウィンドウの大きさが変わると折り返し位置が変わる
    // 余白を変えても反応しないよう、枠の外側（border-box）の大きさだけを見る
    new ResizeObserver(() => layout()).observe(editor, { box: 'border-box' });
    // Web フォントの読み込みが終わると文字幅が変わる
    if (document.fonts) document.fonts.ready.then(layout);

    return {
      layout,
      schedule,
      poke,
      syncNow,
      rangeRects,
      paraIndexOf: (offset) => { syncNow(); return paraIndexOf(offset); },
      paraSide,
      isVertical: () => caret.classList.contains('vertical'),
      onFlush: (fn) => flushListeners.push(fn),
      setTypewriter(on) {
        typewriter = on;
        layout();
        schedule({ center: true });
      },
      get composing() { return composing; },
    };
  }

  root.KotobaCaret = { create };
})(typeof window !== 'undefined' ? window : globalThis);
