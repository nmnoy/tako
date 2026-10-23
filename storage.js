// kotoba - 保存先（IndexedDB）
//
// なぜ localStorage から移したか:
//   localStorage は全部で 5MB 前後しか入らず、画像を2〜3枚貼ればいっぱいになる。
//   IndexedDB はディスクの空きに応じて数百MB〜GB 単位で入り、画像（Blob）もそのまま入れられる。
//
// 置き場（object store）:
//   state  … 原稿・設定など、今まで localStorage に入れていたものをまるごと1件（key: 'main'）
//   images … 資料に貼った画像。1枚1件 { id, memoId, blob, type, width, height, name, size, createdAt }
//
// 閉じる瞬間の保険（mirror）:
//   IndexedDB の書き込みは非同期なので、タブを閉じる瞬間（pagehide）に始めた書き込みが
//   最後まで終わる保証はない。閉じる瞬間だけは、同期で書ける localStorage にも文章の控えを書く。
//   起動時は両方の savedAt を比べて新しい方を使う。控えは文章だけ（画像は入れない）なので 5MB でも普通は足りる。
//
// IndexedDB が使えないとき（古いブラウザ・一部のプライベートモード）は localStorage だけで動く（画像はなし）。

(function (root) {
  'use strict';

  // アプリの名前は「タコエディタ」に変えたが、保存先の名前は kotoba のまま。変えると今までの原稿が見つからなくなる
  const DB_NAME = 'kotoba';
  const DB_VERSION = 1;
  const MIRROR_KEY = 'kotoba:v1'; // 以前の保存先と同じキー。移行前のデータもここにある

  // IndexedDB の「イベントで結果が返ってくる」書き方を Promise にする小さな道具
  const req = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('aborted', 'AbortError'));
  });

  function openDb() {
    return new Promise((resolve) => {
      let r;
      try {
        r = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (_) {
        resolve(null);
        return;
      }
      // 初回（またはバージョンを上げたとき）だけ呼ばれる。置き場の形をここで作る
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('images')) {
          const s = db.createObjectStore('images', { keyPath: 'id' });
          s.createIndex('memoId', 'memoId'); // 「この資料の画像」を速く引くための索引
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      // 別のタブが古い版で開いたままだと、版の更新が待たされる。待ち続けて固まらないよう、諦めて null
      r.onblocked = () => resolve(null);
    });
  }

  function readMirror() {
    try {
      const raw = localStorage.getItem(MIRROR_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  async function create() {
    const db = 'indexedDB' in root ? await openDb() : null;

    // 別のタブで新しい版の kotoba が開かれて DB の版が上がるとき、こちらは閉じて道を譲る
    if (db) db.onversionchange = () => db.close();

    async function load() {
      const mirror = readMirror();
      if (!db) return { data: mirror, source: mirror ? 'localStorage' : 'none' };

      const rec = await req(db.transaction('state').objectStore('state').get('main')).catch(() => null);
      if (!rec) {
        // 初回：localStorage にある以前のデータを IndexedDB へ引っ越す（localStorage 側は控えとして残す）
        if (mirror) await save(mirror).catch(() => {});
        return { data: mirror, source: mirror ? 'migrated' : 'none' };
      }
      // 閉じる瞬間の控えの方が新しければそっちを使う（IndexedDB の書き込みが間に合わなかった）
      if (mirror && (mirror.savedAt || 0) > (rec.savedAt || 0)) return { data: mirror, source: 'mirror' };
      return { data: rec.data, source: 'indexedDB' };
    }

    // 戻り値は Promise。put の時点で中身が複製されるので、呼んだ直後に store を書き換えても大丈夫
    async function save(state) {
      const savedAt = Date.now();
      if (!db) {
        localStorage.setItem(MIRROR_KEY, JSON.stringify({ ...state, savedAt })); // 容量オーバーなら例外がそのまま出る
        return;
      }
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put({ id: 'main', savedAt, data: state });
      await done(tx);
    }

    // 閉じる瞬間用。同期で書けるのは localStorage だけ。失敗しても（容量オーバー）黙る。IndexedDB 側が本命
    function saveMirror(state) {
      try {
        localStorage.setItem(MIRROR_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
      } catch (_) { /* 何もしない */ }
    }

    // ------------------------------------------------------------
    // 画像
    // ------------------------------------------------------------
    const noImages = () => Promise.reject(new Error('この環境では画像を保存できません（IndexedDB が使えません）'));

    async function imagesOf(memoId) {
      if (!db) return [];
      const list = await req(db.transaction('images').objectStore('images').index('memoId').getAll(memoId));
      return list.sort((a, b) => a.createdAt - b.createdAt);
    }

    async function allImages() {
      if (!db) return [];
      return req(db.transaction('images').objectStore('images').getAll());
    }

    async function putImages(records) {
      if (!db) return noImages();
      const tx = db.transaction('images', 'readwrite');
      const s = tx.objectStore('images');
      for (const r of records) s.put(r);
      await done(tx);
    }

    async function deleteImage(id) {
      if (!db) return;
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').delete(id);
      await done(tx);
    }

    // 資料を消したときに、その資料の画像もまとめて消す
    async function deleteImagesOf(memoIds) {
      if (!db || !memoIds.length) return;
      const tx = db.transaction('images', 'readwrite');
      const index = tx.objectStore('images').index('memoId');
      for (const memoId of memoIds) {
        const keys = await new Promise((resolve, reject) => {
          const r = index.getAllKeys(memoId);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        for (const k of keys) tx.objectStore('images').delete(k);
      }
      await done(tx);
    }

    async function clearImages() {
      if (!db) return;
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').clear();
      await done(tx);
    }

    // 小さな設定を1件しまう（自動バックアップのフォルダなど）。原稿とは別の行に置くので、バックアップの中身には入らない。
    // フォルダの「取っ手」（FileSystemDirectoryHandle）は JSON にできないが、IndexedDB にはそのまま入れられる
    async function getValue(key) {
      if (!db) return undefined;
      const rec = await req(db.transaction('state').objectStore('state').get(`kv:${key}`)).catch(() => null);
      return rec ? rec.value : undefined;
    }
    async function setValue(key, value) {
      if (!db) return;
      const tx = db.transaction('state', 'readwrite');
      if (value === undefined) tx.objectStore('state').delete(`kv:${key}`);
      else tx.objectStore('state').put({ id: `kv:${key}`, value });
      await done(tx);
    }

    return {
      hasImages: !!db,
      load, save, saveMirror, getValue, setValue,
      imagesOf, allImages, putImages, deleteImage, deleteImagesOf, clearImages,
    };
  }

  root.KotobaStorage = { create };
})(typeof window !== 'undefined' ? window : globalThis);
