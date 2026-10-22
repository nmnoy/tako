// タコエディタ - 「このアプリについて」
//
// 載せるもの:
//   - 名前・バージョン・ひとこと説明
//   - 原稿の保存場所（外に送らないこと・バックアップのすすめ）。無料で配るアプリでも、ここが一番気にされる
//   - 動作環境（PC の Chrome / Edge 推奨）
//   - ショートカット
//   - 応援（投げ銭）のリンク。SUPPORT_URL が空のあいだは「準備中」と出す
//   - 類語辞書の元データのライセンス表記（notices.js。THIRD_PARTY_NOTICES.md から tools/build_notices.py で生成）
//     ライセンス表記は「全コピーに含める」ことが条件のものがあるので、アプリの中から必ず見られるようにしておく
//
// 入口は右パネルの一番下の小さなリンクだけ。起動時に出したり、応援をお願いするポップアップは出さない
// （「書いているときに余計なものを見せない」方針。うるさいお願いは、かえって応援を減らす）。

(function (root) {
  'use strict';

  const APP_NAME = 'タコエディタ';
  const APP_VERSION = '0.9.0';
  // 投げ銭の受け取り先（BOOTH のブースト付き0円商品など）。決まったらここに URL を入れる
  const SUPPORT_URL = '';

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function create({ isMac }) {
    const dialog = document.getElementById('aboutDialog');
    const body = dialog.querySelector('.about-body');
    const mod = isMac ? '⌘' : 'Ctrl';
    let built = false;

    // 外部へのリンクは platform.js に任せる（アプリ化したとき「いつものブラウザで開く」に差し替えるため）
    function link(text, url) {
      const a = el('a', { href: url, text, rel: 'noopener noreferrer', target: '_blank' });
      a.addEventListener('click', (e) => { e.preventDefault(); root.KotobaPlatform.openExternal(url); });
      return a;
    }

    function section(title, ...children) {
      return el('section', { class: 'about-section' }, el('h3', { class: 'about-h', text: title }), ...children);
    }

    function build() {
      body.textContent = '';

      body.append(el('div', { class: 'about-head' },
        el('img', { class: 'about-icon', src: 'icons/icon.svg', alt: '', width: '48', height: '48' }),
        el('div', {},
          el('div', { class: 'about-name', text: APP_NAME }),
          el('div', { class: 'about-version', text: `バージョン ${APP_VERSION}` })),
      ));
      body.append(el('p', { class: 'about-lead', text: '言葉を選ぶと、その場で類語が並ぶ原稿エディタ。1つの言葉から言い換えを足のように伸ばしていく。' }));

      body.append(section('原稿の保存について',
        el('p', { text: '原稿・資料・画像は、このパソコンのブラウザの中にだけ保存される。インターネットには送らない（ログインもない）。' }),
        el('p', { text: 'そのかわり、ブラウザのデータ（「Cookie と他のサイトデータ」）を消すと原稿も消える。「書き出し」→「自動バックアップ」でフォルダを選んでおくと、書いている途中で自動的にバックアップのファイルが作られる。消えてしまったら、そのファイルをウィンドウにドロップすれば戻せる。' }),
      ));

      body.append(section('動作環境',
        el('p', { text: 'パソコンの Chrome / Edge（新しい版）向け。スマートフォン・タブレットには対応していない。Chrome / Edge では右下の「アプリにする」から、デスクトップのアイコンで開けるようにできる。' }),
      ));

      const keys = [
        ['選んだ言葉の類語', '言葉を選ぶ（ダブルクリック・ドラッグ）'],
        ['類語の検索ボックスへ', `${mod}+K`],
        ['本文を検索 / 置換', isMac ? '⌘F / ⌘⌥F' : 'Ctrl+F / Ctrl+H'],
        ['資料から本文へ戻る', 'Esc'],
        ['パネルを開く・閉じる', `${mod}+\\（JIS 配列は ${mod}+¥）`],
        ['文字を大きく / 小さく / 元に', `${mod}+＋ / ${mod}+− / ${mod}+0`],
        ['資料の URL を開く', `URL にカーソルを置いて「開く」、または ${mod}+クリック`],
        ['資料に画像を貼る', '資料を開いて貼り付け・ドロップ'],
      ];
      body.append(section('ショートカット',
        el('table', { class: 'about-keys' }, ...keys.map(([what, key]) => el('tr', {}, el('th', { text: what }), el('td', { text: key })))),
      ));

      body.append(section('応援する',
        el('p', { text: `${APP_NAME}は無料で使える。気に入ったら、投げ銭で応援してもらえると開発の励みになる。` }),
        SUPPORT_URL
          ? el('p', {}, link('投げ銭で応援する', SUPPORT_URL))
          : el('p', { class: 'about-muted', text: '（応援の受け付けは準備中）' }),
      ));

      // ライセンス表記。数が多いので、普段は名前だけ見せて、開くと全文
      const notices = root.KOTOBA_NOTICES || { items: [], texts: {} };
      const list = el('div', { class: 'about-licenses' });
      for (const it of notices.items) {
        const d = el('details', { class: 'about-license' },
          el('summary', { text: it.name }),
          it.use ? el('p', { text: `用途：${it.use}` }) : null,
          it.license ? el('p', { text: `ライセンス：${it.license}` }) : null,
          it.url ? el('p', {}, '配布元：', link(it.url, it.url)) : null,
          it.notice ? el('pre', { class: 'about-pre', text: it.notice }) : null,
        );
        // 表示する文言が全文とほぼ同じ（WordNet は全文の掲載が条件）なら、同じ文章を二度出さない
        const squash = (t) => (t || '').replace(/\s+/g, ' ').trim();
        const full = notices.texts[it.fullText];
        const same = full && it.notice && squash(full).includes(squash(it.notice)) && squash(it.notice).length > squash(full).length * 0.6;
        if (it.fullText && full && !same) {
          d.append(el('details', { class: 'about-full' },
            el('summary', { text: 'ライセンス全文' }),
            el('pre', { class: 'about-pre', text: notices.texts[it.fullText] })));
        }
        list.append(d);
      }
      body.append(section('類語辞書について',
        el('p', { text: '類語のデータは、次のデータをもとに作っている。' }),
        list,
      ));
      built = true;
    }

    function open() {
      if (!built) build(); // 初めて開いたときに作る（起動を少しでも軽くするため）
      dialog.showModal();
      body.scrollTop = 0;
    }

    document.getElementById('aboutBtn').addEventListener('click', open);
    return { open, APP_NAME, APP_VERSION };
  }

  root.KotobaAbout = { create, APP_NAME, APP_VERSION };
})(typeof window !== 'undefined' ? window : globalThis);
