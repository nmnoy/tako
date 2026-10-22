// kotoba - Service Worker（オフラインで開けるようにする裏方）
//
// やっていること:
//   1. インストール時に、アプリに必要なファイルを全部キャッシュ（ブラウザ内の保管庫）に入れる
//   2. 以後の読み込みは「キャッシュにあればそれを返す」。ネットが無くても起動できる
//   3. 新しい版が出たら裏で取ってきて待機させ、画面側（pwa.js）に「更新があります」と知らせる。
//      切り替えるのはユーザーが「更新」を押したときだけ。書いている途中で勝手に再読み込みしない
//
// ★ 更新を配るときは VERSION を必ず変えること（tools/stamp_sw.py が自動で書き換える）。
//   ブラウザは「sw.js の中身が1バイトでも変わったか」で更新を判断する。
//   VERSION を変え忘れると、style.css や app.js を直しても、利用者の手元では古いキャッシュが出続ける。
//   これが PWA で一番よくある事故。

const VERSION = '9d364d6b00de';
const CACHE = `kotoba-${VERSION}`;

// キャッシュに入れるファイル。ファイルを増やしたらここにも足す（stamp_sw.py が足し忘れを警告する）
const ASSETS = [
  'index.html',
  'style.css',
  'platform.js',
  'storage.js',
  'dictionary.js',
  'verb.js',
  'caret.js',
  'find.js',
  'links.js',
  'images.js',
  'export.js',
  'backup.js',
  'autobackup.js',
  'notices.js',
  'about.js',
  'pwa.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'THIRD_PARTY_NOTICES.md',
  'licenses/Apache-2.0.txt',
  'licenses/Japanese-WordNet.txt',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache: 'reload' … ブラウザの通常の HTTP キャッシュを通さず、必ずサーバーから取る。
      // そうしないと「新しい sw.js が、古い app.js を HTTP キャッシュから拾って保管する」ことがある
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  // ここで skipWaiting() はしない。開いている画面がある間は古い版のまま動かし、切り替えはユーザーに任せる
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 古い版のキャッシュを消す（kotoba- で始まるものだけ。同じドメインの他のアプリのは触らない）
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('kotoba-') && k !== CACHE).map((k) => caches.delete(k)));
    // 初回インストール直後の画面も、再読み込みなしでこの SW の管理下に入れる
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部（リンク先など）には口を出さない

  // ページそのもの（/ や /index.html?x=1）は、どの URL で来ても index.html を返す
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html', { cacheName: CACHE }).then((hit) => hit || fetch(req))
    );
    return;
  }

  // それ以外はキャッシュ優先。無ければネットへ（キャッシュに無い = ASSETS の書き忘れ）
  event.respondWith(
    caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((hit) => hit || fetch(req))
  );
});

// 画面側で「更新」が押されたら、待機中のこの SW を有効にする
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
