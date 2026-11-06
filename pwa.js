// kotoba - PWA（「アプリとしてインストール」）まわり
//
// やること:
//   - Service Worker（sw.js）を登録して、オフラインでも開けるようにする
//   - Chrome / Edge が「インストールできます」と言ってきたら、右下に「アプリにする」ボタンを出す
//   - 新しい版が届いたら知らせ、ユーザーが押したときだけ保存 → 切り替え → 再読み込み
//   - インストールして使っているときは、ブラウザに「勝手にデータを消さないで」と頼む（storage.persist）
//
// file:// で開いたときは何もしない。PWA は https（と開発用の localhost）でしか動かないので、
// 今まで通り index.html を直接開いても、エディタとしては普通に使える。

(function (root) {
  'use strict';

  const isWeb = /^https?:$/.test(location.protocol);

  // manifest は file:// で読ませると「CORS で読めない」とコンソールが赤くなるので、Web のときだけ足す
  if (isWeb) {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = 'manifest.webmanifest';
    document.head.appendChild(link);
  }

  // インストールしたアプリとして（アドレスバーなしのウィンドウで）開かれているか
  const isStandalone = () =>
    matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; // 後者は Safari

  // ブラウザは容量が足りなくなると、サイトのデータを「消してもいいもの」から消していく。
  // persist() が通ると、その対象から外れる。Chrome はインストール済みアプリなら確認なしで通す。
  // （Firefox は確認ダイアログを出すので、普通のタブで開いたときには呼ばない）
  async function askPersist() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return navigator.storage.persist();
  }

  function create({ installButton, onUpdateReady, beforeReload }) {
    if (!isWeb) return { isStandalone };

    // ------------------------------------------------------------
    // インストールボタン（Chrome / Edge だけ。Safari・Firefox はこのイベント自体が来ない）
    // ------------------------------------------------------------
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      // 放っておくとブラウザが勝手に「インストールしますか」の帯を出すので止めて、自前のボタンから出す
      e.preventDefault();
      deferredPrompt = e;
      if (installButton) installButton.hidden = false;
    });
    if (installButton) {
      installButton.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice; // 「インストール」でも「キャンセル」でも、このイベントは1回しか使えない
        deferredPrompt = null;
        installButton.hidden = true;
      });
    }
    window.addEventListener('appinstalled', () => {
      if (installButton) installButton.hidden = true;
      askPersist();
    });
    if (isStandalone()) askPersist();

    // ------------------------------------------------------------
    // Service Worker と更新の通知
    // ------------------------------------------------------------
    if (!('serviceWorker' in navigator)) return { isStandalone };

    let reloading = false;   // 自分で「更新」を押したときだけ true。初回インストールで再読み込みしないため
    let notified = false;

    function notify(worker) {
      if (notified) return;
      notified = true;
      onUpdateReady(() => {
        beforeReload();       // 打ちかけの文字を必ず保存してから
        reloading = true;
        worker.postMessage('skipWaiting');
      });
    }

    // 新しい SW が有効になった = 画面の裏のファイルが入れ替わった。自分で押したときだけ読み直す。
    // （初回は「SW なし → あり」でもこのイベントが来る。そこで再読み込みすると、開いた瞬間に画面がチカッとする）
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloading) return;
      location.reload();
    });

    navigator.serviceWorker.register('sw.js').then((reg) => {
      // 開くたびに新しい版を確かめる。register() は登録済みなら何もしないので、明示的に update() を呼ぶ。
      // 普段はページを開いたときにブラウザも確かめてくれるが、Shift+再読み込み（SW を通さない読み込み）では走らない。
      // 古い版の SW が壊れてページが開けなくなったとき、Shift+再読み込みで1回開けば新しい版に入れ替わるのは、これのおかげ
      reg.update().catch(() => {});
      // 前回すでに届いて待機していた新版
      if (reg.waiting && navigator.serviceWorker.controller) notify(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          // controller がいる = 既に古い版で動いている。いないなら初回インストールなので知らせない
          if (worker.state === 'installed' && navigator.serviceWorker.controller) notify(worker);
        });
      });

      // 原稿エディタは何日も開きっぱなしにされがち。ブラウザは「ページを開いたとき」しか更新を確かめないので、
      // 開いている間も自分で確かめる（11/6。以前は「画面に戻ってきて、しかも1時間以上たっていたら」だけで、
      // 開きっぱなしのタブにはなかなか更新のお知らせが出なかった）。
      //   - 画面に戻ってきたとき・窓を選んだとき … 前回から10分以上たっていれば
      //   - 開いて見ている間 …………………………… 30分ごと
      // 確かめるのは sw.js 1ファイル（数KB）だけなので、通信の負担はほぼない
      const RECHECK_MIN = 10 * 60 * 1000;
      const POLL = 30 * 60 * 1000;
      let lastCheck = Date.now();
      function check(force) {
        if (notified) return;                                   // もう知らせてあれば、確かめる必要はない
        if (!force && Date.now() - lastCheck < RECHECK_MIN) return;
        lastCheck = Date.now();
        reg.update().catch(() => {}); // オフラインなら失敗するが、気にしない
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check(false);
      });
      window.addEventListener('focus', () => check(false));
      setInterval(() => {
        if (document.visibilityState === 'visible') check(true);
      }, POLL);
    }).catch(() => {
      // 登録に失敗してもエディタは普通に使える（オフライン対応がないだけ）
    });

    return { isStandalone };
  }

  root.KotobaPWA = { create, isStandalone, askPersist };
})(typeof window !== 'undefined' ? window : globalThis);
