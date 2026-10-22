// kotoba - 資料の中の URL をリンクにする
//
// 構成:
//   findUrls（DOM なし）: 本文から URL の位置を探す。node だけでテストできる
//   create             : 下線の描画と、⌘（Windows は Ctrl）+クリックで開く処理
//
// 仕組み:
//   textarea の中の文字は装飾できないので、検索のハイライトと同じく、caret.js のミラーで URL の位置を測り、
//   透明な textarea の「裏」に下線を敷く。普通のクリックはカーソルを置く操作なので奪わない。
//   開き方は2つ:
//     - カーソルを URL の中に置くと、すぐ下に「↗ 開く」の吹き出しが出る（Google ドキュメントと同じ）。
//       修飾キーを知らなくても使えるので、こっちが主
//     - ⌘（Windows は Ctrl）を押しながらクリック（VS Code と同じ。慣れている人向けの近道）
//
// 安全面:
//   開くのは http:// と https:// だけ（javascript: などは URL として拾わない）。
//   新しいタブで開き、noopener で開いた先から元のページを操作されないようにする。

(function (root) {
  'use strict';

  // ===============================================================
  // URL を探す（DOM なし）
  // ===============================================================

  // 日本語の文章は「https://example.com/です。」のように URL の直後に普通の文字が続く。
  // 「空白が来るまで」を URL にすると「です。」まで入るので、URL に使える ASCII の文字だけを拾う
  const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

  // 文末の句読点や閉じかっこは URL に含めない（「（https://example.com）」「https://example.com.」）
  function trimTail(url) {
    let u = url;
    for (;;) {
      const last = u.at(-1);
      if ('.,;:!?\''.includes(last)) { u = u.slice(0, -1); continue; }
      // 閉じかっこは、URL の中に対応する開きかっこがないときだけ外す（Wikipedia の URL は (...) を含む）
      if (last === ')' && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) { u = u.slice(0, -1); continue; }
      if (last === ']' && (u.match(/\[/g) || []).length < (u.match(/\]/g) || []).length) { u = u.slice(0, -1); continue; }
      return u;
    }
  }

  // 戻り値: [{ start, end, url }]（本文の順）
  function findUrls(text) {
    const out = [];
    URL_RE.lastIndex = 0; // g フラグ付きの正規表現は前回の位置を覚えているので、毎回リセットする
    for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
      const url = trimTail(m[0]);
      if (url.length > 'https://'.length) out.push({ start: m.index, end: m.index + url.length, url });
    }
    return out;
  }

  // ===============================================================
  // 下線の描画と、クリックで開く（DOM あり）
  // ===============================================================

  const MAX_DRAW = 200;

  function create({ editor, layer, caret, isActive, isMac }) {
    const marks = document.createElement('div');
    marks.className = 'link-layer';
    marks.setAttribute('aria-hidden', 'true');
    layer.prepend(marks);

    let links = [];
    let rects = [];       // 画面上の下線の位置（クリック判定用）: { x1, y1, x2, y2, url }
    let rerunTimer = 0;
    let composing = false;
    let mouse = null;     // 最後のマウス位置
    let modDown = false;  // ⌘/Ctrl を押しているか
    let typing = false;   // 打っている最中は吹き出しを出さない（URL を打っている途中にチラつくので）

    // 「↗ 開く」の吹き出し。textarea の上に重ねるので、押せるように pointer-events を戻す
    const tip = document.createElement('div');
    tip.className = 'link-tip';
    tip.hidden = true;
    const tipBtn = document.createElement('button');
    tipBtn.type = 'button';
    tipBtn.className = 'link-tip-open';
    const tipUrl = document.createElement('span');
    tipUrl.className = 'link-tip-url';
    tip.append(tipBtn, tipUrl);
    layer.appendChild(tip);
    let tipLink = null;

    const modOf = (e) => (isMac ? e.metaKey : e.ctrlKey);

    function run() {
      links = isActive() ? findUrls(editor.value) : [];
      draw();
      updateTip();
    }

    function scheduleRun(delay = 200) {
      clearTimeout(rerunTimer);
      rerunTimer = setTimeout(run, delay);
    }

    // 検索のハイライトと同じく、画面に見えているリンクだけを描く
    function draw() {
      marks.textContent = '';
      rects = [];
      if (!links.length) { updateCursor(); return; }
      caret.syncNow();

      const sideOf = (l) => caret.paraSide(caret.paraIndexOf(l.start));
      let lo = 0;
      let hi = links.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sideOf(links[mid]) < 0) lo = mid + 1; else hi = mid;
      }

      const box = editor.getBoundingClientRect();
      const clip = {
        left: box.left + editor.clientLeft,
        top: box.top + editor.clientTop,
        right: box.left + editor.clientLeft + editor.clientWidth,
        bottom: box.top + editor.clientTop + editor.clientHeight,
      };
      const base = layer.getBoundingClientRect();
      const vertical = caret.isVertical();
      const frag = document.createDocumentFragment();

      for (let i = lo; i < links.length && rects.length < MAX_DRAW; i++) {
        const l = links[i];
        if (sideOf(l) > 0) break;
        for (const r of caret.rangeRects(l.start, l.end)) {
          const x1 = Math.max(r.x, clip.left);
          const y1 = Math.max(r.y, clip.top);
          const x2 = Math.min(r.x + r.w, clip.right);
          const y2 = Math.min(r.y + r.h, clip.bottom);
          if (x2 <= x1 || y2 <= y1) continue;
          rects.push({ x1, y1, x2, y2, url: l.url });

          // 下線（縦書きは文字の左側に縦線）
          const el = document.createElement('div');
          el.className = 'link-mark';
          if (vertical) {
            el.style.transform = `translate(${x1 - base.left}px, ${y1 - base.top}px)`;
            el.style.width = '1px';
            el.style.height = y2 - y1 + 'px';
          } else {
            el.style.transform = `translate(${x1 - base.left}px, ${y2 - base.top - 3}px)`;
            el.style.width = x2 - x1 + 'px';
            el.style.height = '1px';
          }
          frag.appendChild(el);
        }
      }
      marks.appendChild(frag);
      updateCursor();
    }

    // ------------------------------------------------------------
    // カーソルが URL の中にあるときの吹き出し
    // ------------------------------------------------------------
    // 「中」= URL の1文字目の後ろから、最後の文字の前まで。URL を打ち終えた直後（末尾）では出さない
    function linkAtCaret() {
      if (document.activeElement !== editor) return null;
      const { selectionStart: s, selectionEnd: e } = editor;
      if (s !== e) return null;
      return links.find((l) => l.start < s && s < l.end) || null;
    }

    // 吹き出しに出す URL は短くする（https:// は省き、長ければ後ろを …）
    const shortUrl = (url) => {
      const u = url.replace(/^https?:\/\//, '');
      return u.length > 42 ? u.slice(0, 41) + '…' : u;
    };

    function updateTip() {
      const l = composing || typing ? null : linkAtCaret();
      if (!l) { tip.hidden = true; tipLink = null; return; }

      // カーソルのある行の、URL の部分の位置に出す
      const pos = editor.selectionStart;
      const r = caret.rangeRects(pos - 1, pos)[0] || caret.rangeRects(l.start, l.end)[0];
      if (!r) { tip.hidden = true; return; }
      if (tipLink !== l.url) {
        tipBtn.textContent = '↗ 開く';
        tipBtn.title = `ブラウザで開く（${isMac ? '⌘' : 'Ctrl'}+Enter）`;
        tipUrl.textContent = shortUrl(l.url);
        tipUrl.title = l.url;
        tipLink = l.url;
      }
      tip.hidden = false;

      const base = layer.getBoundingClientRect();
      const box = editor.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      let x;
      let y;
      if (caret.isVertical()) {
        // 縦書き：行の左隣（次の行の側）に出す
        x = r.x - w - 6;
        y = r.y;
      } else {
        // 横書き：行のすぐ下に出す
        x = r.x;
        y = r.y + r.h + 4;
      }
      // 紙からはみ出さないように寄せる
      x = Math.min(Math.max(x, box.left + 4), box.right - w - 4);
      y = Math.min(Math.max(y, box.top + 4), box.bottom - h - 4);
      // 行が画面の外（スクロールで隠れた）なら出さない
      if (r.y + r.h < box.top || r.y > box.bottom || r.x + r.w < box.left || r.x > box.right) { tip.hidden = true; return; }
      tip.style.transform = `translate(${Math.round(x - base.left)}px, ${Math.round(y - base.top)}px)`;
    }

    function linkAt(x, y) {
      const hit = rects.find((r) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2);
      return hit ? hit.url : null;
    }

    // ⌘/Ctrl を押しながら URL の上にいるときだけ、指のカーソルと URL のツールチップを出す
    function updateCursor() {
      const url = modDown && mouse ? linkAt(mouse.x, mouse.y) : null;
      editor.classList.toggle('over-link', !!url);
      editor.title = url || (mouse && linkAt(mouse.x, mouse.y) ? `${isMac ? '⌘' : 'Ctrl'}+クリックで開く` : '');
    }

    // 開くのは platform.js に任せる（アプリ化したら「いつものブラウザで開く」に差し替える）。
    // http/https 以外は findUrls で拾わないし、platform 側でも開く直前に確かめる
    const open = (url) => root.KotobaPlatform.openExternal(url);

    // ------------------------------------------------------------
    // イベント
    // ------------------------------------------------------------
    // mousedown の時点で開く。click まで待つと、その前にカーソルがリンクの位置へ移動してしまう
    editor.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !modOf(e)) return;
      const url = linkAt(e.clientX, e.clientY);
      if (!url) return;
      e.preventDefault();
      open(url);
    });
    editor.addEventListener('mousemove', (e) => {
      mouse = { x: e.clientX, y: e.clientY };
      modDown = modOf(e);
      updateCursor();
    });
    editor.addEventListener('mouseleave', () => { mouse = null; updateCursor(); });
    // マウスを動かさずに ⌘ を押した・離したときも、カーソルの形を切り替える
    window.addEventListener('keydown', (e) => { if (modOf(e) !== modDown) { modDown = modOf(e); updateCursor(); } });
    window.addEventListener('keyup', (e) => { if (modOf(e) !== modDown) { modDown = modOf(e); updateCursor(); } });
    window.addEventListener('blur', () => { modDown = false; updateCursor(); });

    editor.addEventListener('compositionstart', () => { composing = true; });
    editor.addEventListener('compositionend', () => { composing = false; scheduleRun(); });
    editor.addEventListener('input', () => { if (!composing) scheduleRun(); });
    // スクロール・リサイズ・文字サイズの変更などで、カーソルを描き直すたびに下線も描き直す
    caret.onFlush(() => { if (links.length) draw(); updateTip(); });

    // 吹き出し：押してもエディタのフォーカスを奪わない（押した瞬間に blur して吹き出しが消えるのを防ぐ）
    tipBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    tipBtn.addEventListener('click', () => { if (tipLink) open(tipLink); editor.focus(); });

    // 打ち始めたら引っ込め、カーソルを動かしたら（矢印キー・クリック）また出す
    editor.addEventListener('input', () => { typing = true; tip.hidden = true; });
    editor.addEventListener('mousedown', () => { typing = false; });
    editor.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (/^(Arrow|Home|End|Page)/.test(e.key)) typing = false;
      // ⌘/Ctrl+Enter で、カーソルのある URL を開く
      if (e.key === 'Enter' && modOf(e) && !e.shiftKey && !e.altKey) {
        const l = linkAtCaret();
        if (l) { e.preventDefault(); open(l.url); }
      }
    });
    editor.addEventListener('blur', () => { tip.hidden = true; });
    editor.addEventListener('focus', () => updateTip());

    return { refresh: run };
  }

  root.KotobaLinks = { findUrls, trimTail, create };
})(typeof window !== 'undefined' ? window : globalThis);
