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

const VERSION = 'ceac51b23647';
const CACHE = `kotoba-${VERSION}`;

// キャッシュに入れるファイル。ファイルを増やしたらここにも足す（stamp_sw.py が足し忘れを警告する）
const ASSETS = [
  'index.html',
  'style.css',
  'platform.js',
  'storage.js',
  'dictionary.js',
  'relations.js',
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
  'done.js',
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
  'licenses/Open-English-WordNet.txt',
];

// 転送（リダイレクト）を経て届いた応答の「転送された」印を外した、きれいな複製を作る。
// Cloudflare Workers は /index.html を / へ転送する。転送つきの応答をそのまま保存してページとして返すと、
// Chrome は「転送つきの応答はページに使えない」と弾いて ERR_FAILED になる（普通の再読み込みで開けなくなる。
// Shift+再読み込みは SW を通らないので開ける）。手元の python サーバーは転送しないので気づけなかった
async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (url) => {
      // cache: 'reload' … ブラウザの通常の HTTP キャッシュを通さず、必ずサーバーから取る。
      // そうしないと「新しい sw.js が、古い app.js を HTTP キャッシュから拾って保管する」ことがある
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`${url} を取れなかった（${res.status}）`);
      await cache.put(url, await clean(res));
    }));

    // 普段はここで skipWaiting() しない（開いている画面がある間は古い版のまま動かし、切り替えはユーザーに任せる）。
    // ただし古い版のキャッシュに「転送つきのページ」が入っていたら、古い版ではページが開けず「更新」も押せないので、
    // 待たずにすぐ入れ替わる（上のバグを踏んだ版からの自動回復）
    for (const key of await caches.keys()) {
      if (!key.startsWith('kotoba-') || key === CACHE) continue;
      const old = await (await caches.open(key)).match('index.html');
      if (old && old.redirected) { self.skipWaiting(); break; }
    }
  })());
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
  // 保存したものに転送の印が付いていたら（古い版のキャッシュなど）、ネットから取り直す。ネットもだめなら印を外して返す
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const hit = await caches.match('index.html', { cacheName: CACHE });
      if (hit && !hit.redirected) return hit;
      try {
        return await fetch(req);
      } catch (e) {
        if (hit) return clean(hit);
        throw e;
      }
    })());
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
