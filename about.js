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
        el('img', { class: 'about-icon', src: 'icons/icon-192.png', alt: '', width: '48', height: '48' }),
        el('div', {},
          el('div', { class: 'about-name', text: APP_NAME }),
          el('div', { class: 'about-version', text: `バージョン ${APP_VERSION}` })),
      ));
      body.append(el('p', { class: 'about-lead', text: '文章の中の言葉を選ぶと、その場で類語が並ぶ原稿エディタ。' }));

      body.append(section('原稿の保存について',
        el('p', { text: '原稿・資料・画像は、このパソコンのブラウザに保存されます。ログイン不要。コマーシャルで溢れた空虚なインターネット空間にデータを託しません。' }),
        // 注意事項は赤字（消える条件だけは読み飛ばされたくない）
        el('p', { class: 'about-warn' },
          el('strong', { text: '注意事項' }), el('br'),
          'ブラウザのデータ（「Cookie と他のサイトデータ」）を消すと原稿が消えます。'),
        el('p', { text: '「書き出し」→「自動バックアップ」でフォルダを選んでおくと、書いている途中で自動的にバックアップのファイルが作られます。もし消えてしまったら、そのファイルをウィンドウにドロップして戻しましょう。' }),
      ));

      body.append(section('動作環境',
        el('p', { text: 'パソコンの Chrome / Edge（最新版）。※スマートフォン・タブレットには対応していません。画面右下の「アプリにする」をクリックすると、デスクトップやタスクバーから開けるようになります。' }),
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

      body.append(section('脱稿と原稿削除について',
        el('p', { text: '右パネルの原稿タイトルにマウスを乗せると、チェックマークとバッテンが出ます。チェックマークを押すと、おめでとう！ついにあなたの原稿は脱稿を迎えました。きっと素晴らしい作品です。バッテンを押すと、どんな素晴らしい作品でも原稿と資料を削除します。' }),
      ));

      body.append(section('応援する',
        el('p', { text: `${APP_NAME}はすべての機能を無料で使えます。` }),
        el('p', { text: 'もしあなたの収入に余裕があって他者への施しに抵抗がなければ、以下のリンク先から可能な投げ銭が開発者を笑顔にします。あなたは素晴らしい執筆者だ。' }),
        SUPPORT_URL
          ? el('p', {}, link('投げ銭で応援する', SUPPORT_URL))
          : el('p', { class: 'about-muted', text: '（応援の受け付けは準備中です）' }),
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
      // 個人用の分類語彙表入り辞書を読んでいるときだけ、その出典を足す（国語研に指定された書き方）
      const wlsp = root.KOTOBA_DICTIONARY && root.KOTOBA_DICTIONARY.wlsp
        ? el('div', { class: 'about-license' },
          el('p', { text: '国立国語研究所（2004）『分類語彙表増補改訂版データベース』（ver.1.0.1）' }),
          el('p', { text: 'ライセンス：CC BY-NC-SA 3.0' }),
          el('p', {}, link('https://creativecommons.org/licenses/by-nc-sa/3.0/deed.ja', 'https://creativecommons.org/licenses/by-nc-sa/3.0/deed.ja')),
          el('p', {}, link('https://clrd.ninjal.ac.jp/goihyo.html', 'https://clrd.ninjal.ac.jp/goihyo.html')),
          el('p', { class: 'about-muted', text: '（この辞書は個人用の版です。配布しません）' }))
        : null;
      body.append(section('類語辞書について',
        el('p', { text: '類語のデータは、次の辞書データをもとに作っています。' }),
        list,
        wlsp,
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

  root.KotobaAbout = { create, APP_NAME, APP_VERSION, SUPPORT_URL };
})(typeof window !== 'undefined' ? window : globalThis);
