// タコエディタ - 「完成」（作品を書き上げたときのボタン）
//
// 完成にすると:
//   - 一覧に「完成」の印が付き、開くと紙が白・文字が黒になる（下書き → 清書の切り替わり）
//   - 完成した時点の原稿を保存する（memo.completed.snapshot）。あとで推敲して書き換えても「完成時の版」に戻せる
//   - お祝いの画面を出す（文字数・書き始めてからの日数・書き出しへの近道）
//   - お祝いの画面の最後に、応援（投げ銭）のお願いを一行だけ出す。
//     ・応援の URL（about.js の SUPPORT_URL）が未設定なら出さない
//     ・同じ作品では1回だけ（memo.cheered。完成の印の中ではなく作品そのものに持たせる。
//       印の中に置くと、完成を取り消して付け直したときに一緒に消えて、もう一度お願いが出てしまう）
//     ・「もう表示しない」を押したら、どの作品でも二度と出さない（settings.cheerOff）
//     完成ボタンが「寄付を頼むためのボタン」に見えたら台無しなので、お願いはおまけの位置に置く
//
// 完成にできるのは作品（本文）だけ。資料には付けない。

(function (root) {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; };
  const DAY = 86400000;

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  // getMemo(id) … 本文を確定させてから原稿を返す / countChars(text) / commit() … 一覧・紙の色・保存を更新
  // openExport() … 書き出しダイアログを開く / settings … store.settings（cheerOff を読み書きする）
  function create({ getMemo, countChars, commit, openExport, notify, settings, label }) {
    const dialog = document.getElementById('doneDialog');
    const body = dialog.querySelector('.done-body');

    function supportUrl() {
      return (root.KotobaAbout && root.KotobaAbout.SUPPORT_URL) || '';
    }

    function close() { if (dialog.open) dialog.close(); }

    function button(text, onclick, cls = '') {
      return el('button', { type: 'button', class: cls, text, onclick });
    }

    // ------------------------------------------------------------
    // 完成にする → お祝い
    // ------------------------------------------------------------
    function complete(memo) {
      const chars = countChars(memo.body);
      memo.completed = { at: Date.now(), chars, snapshot: { title: memo.title, body: memo.body } };
      commit();
      celebrate(memo);
    }

    function celebrate(memo) {
      const c = memo.completed;
      const days = memo.createdAt ? Math.max(1, Math.ceil((c.at - memo.createdAt) / DAY)) : 0;
      body.textContent = '';
      body.append(
        el('img', { class: 'done-tako', src: 'icons/icon.svg', alt: '', width: '64', height: '64' }),
        el('h2', { class: 'done-title', text: '書き上げた！' }),
        el('p', { class: 'done-work', text: `『${label(memo)}』` }),
        el('p', { class: 'done-stats', text: `${c.chars.toLocaleString()}字${days ? `（書き始めてから${days}日）` : ''}` }),
        el('div', { class: 'done-actions' },
          button('書き出す…', () => { close(); openExport(); }),
          button('閉じる', close, 'done-primary')),
        el('p', { class: 'done-note', text: '完成した時点の原稿を残しておいた。このあと推敲して書き換えても、一覧の ✓ から「完成時の版」に戻せる。' }),
      );

      // 応援のお願い（おまけ）。出す条件はファイル冒頭のとおり
      const url = supportUrl();
      if (url && !settings.cheerOff && !memo.cheered) {
        memo.cheered = true;
        commit();
        const line = el('p', { class: 'done-cheer' },
          'タコエディタが役に立ったら、応援してもらえるとうれしい。',
          el('a', {
            href: url, text: '応援する', rel: 'noopener noreferrer', target: '_blank',
            onclick: (e) => { e.preventDefault(); root.KotobaPlatform.openExternal(url); },
          }),
          el('button', {
            type: 'button', class: 'done-cheer-off', text: 'もう表示しない',
            onclick: () => { settings.cheerOff = true; commit(); line.remove(); },
          }));
        body.append(line);
      }
      dialog.showModal();
    }

    // ------------------------------------------------------------
    // 完成済みの作品：確認・完成時の版に戻す・取り消す
    // ------------------------------------------------------------
    function manage(memo) {
      const c = memo.completed;
      const s = c.snapshot || { title: memo.title, body: memo.body };
      const changed = s.title !== memo.title || s.body !== memo.body;
      body.textContent = '';
      body.append(
        el('h2', { class: 'done-title small', text: `『${label(memo)}』` }),
        el('p', { class: 'done-stats', text: `${fmtDate(c.at)} に完成（${c.chars.toLocaleString()}字）` }),
        el('p', { class: 'done-note', text: changed ? '完成のあとに書き換えている。' : '完成のあとは書き換えていない。' }),
        el('div', { class: 'done-actions' },
          changed ? button('完成時の版に戻す', () => revert(memo)) : null,
          button('完成を取り消す', () => { delete memo.completed; commit(); close(); notify('完成を取り消した。'); }),
          button('閉じる', close, 'done-primary')),
      );
      dialog.showModal();
    }

    // 完成時の版に戻す。今の文章はお知らせの「元に戻す」で取り戻せる
    function revert(memo) {
      const before = { title: memo.title, body: memo.body };
      memo.title = memo.completed.snapshot.title;
      memo.body = memo.completed.snapshot.body;
      memo.updatedAt = Date.now();
      commit({ reopen: true });
      close();
      notify('完成時の版に戻した。', {
        label: '元に戻す',
        run: () => { memo.title = before.title; memo.body = before.body; memo.updatedAt = Date.now(); commit({ reopen: true }); },
      });
    }

    // 一覧の ✓ から呼ばれる
    function toggle(id) {
      const memo = getMemo(id);
      if (!memo || memo.parentId) return;
      if (memo.completed) manage(memo);
      else complete(memo);
    }

    return { toggle };
  }

  root.KotobaDone = { create };
})(typeof window !== 'undefined' ? window : globalThis);
