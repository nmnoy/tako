// kotoba - 資料に貼る画像
//
// 構成:
//   prepare（DOM は使うが画面には出さない）: 貼られた画像を、保存してよい大きさに整える
//   create                                  : 紙の下の「画像の帯」、拡大表示、貼り付け・ドロップ・ボタンからの追加
//
// 画像を貼れるのは資料だけ。本文（原稿）は書き出して人に渡すものなので、画像は混ぜない。
//
// 縮小のルール（prepare）:
//   - 長辺が 1600px を超えるか、ファイルが 1.5MB を超えるときだけ作り直す。小さければ元のまま（GIF のアニメも残る）
//   - 作り直すとき、PNG（スクショ・イラスト）は PNG のまま（文字がにじまない・透明を保つ）。
//     それでも 2.5MB を超えたら JPEG にする。写真（JPEG など）は JPEG 品質 85%
//   - スマホの写真は 1枚 3〜8MB あるが、1600px の JPEG にすると 300〜600KB 程度になる
//
// 読み込みに <img> を使う理由:
//   createImageBitmap は SVG を読めないブラウザがある。<img> なら SVG も読め、写真の向き（EXIF）も反映される。
//   iPhone の HEIC は Chrome / Edge では読めないので、そのときは「JPEG にしてから」と伝える。

(function (root) {
  'use strict';

  const MAX_SIDE = 1600;
  const KEEP_MAX_BYTES = 1.5 * 1024 * 1024;
  const PNG_MAX_BYTES = 2.5 * 1024 * 1024;
  const MAX_INPUT_BYTES = 50 * 1024 * 1024; // これより大きいものは読み込みでブラウザが固まりかねないので断る

  class ImageError extends Error {}

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new ImageError('この形式の画像は読めなかった（iPhone の HEIC など）。JPEG か PNG にしてから試してね。')); };
      img.src = url;
    });
  }

  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  // 戻り値: { blob, type, width, height }
  async function prepare(file) {
    if (!file || !/^image\//.test(file.type)) throw new ImageError('画像ファイルではないみたい。');
    if (file.size > MAX_INPUT_BYTES) throw new ImageError('画像が大きすぎる（50MB まで）。');

    const img = await loadImage(file);
    const w = img.naturalWidth || 800; // SVG は大きさを持たないことがある
    const h = img.naturalHeight || 600;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));

    if (scale === 1 && file.size <= KEEP_MAX_BYTES && file.type !== 'image/svg+xml') {
      return { blob: file, type: file.type, width: w, height: h };
    }

    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';

    const lossless = ['image/png', 'image/gif', 'image/svg+xml', 'image/webp'].includes(file.type);
    if (lossless) {
      ctx.drawImage(img, 0, 0, cw, ch);
      const png = await toBlob(canvas, 'image/png');
      if (png && png.size <= PNG_MAX_BYTES) return { blob: png, type: 'image/png', width: cw, height: ch };
    }
    // JPEG は透明を持てない。透明な部分が黒くならないよう、先に白で塗る
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const jpeg = await toBlob(canvas, 'image/jpeg', 0.85);
    if (!jpeg) throw new ImageError('画像を縮小できなかった。');
    return { blob: jpeg, type: 'image/jpeg', width: cw, height: ch };
  }

  const isImageFile = (f) => f && /^image\//.test(f.type);

  function formatBytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }

  // ===============================================================
  // 画面（DOM あり）
  // ===============================================================

  // onChange … 画像を足した・消したときに呼ぶ（自動バックアップに「変わった」と伝えるため）
  function create({ storage, getMemo, makeId, notify, onCountChange, onChange = () => {} }) {
    const bar = document.getElementById('attach');
    const list = document.getElementById('attachList');
    const addBtn = document.getElementById('attachAdd');
    const fileInput = document.getElementById('attachFile');

    const viewer = document.getElementById('imageViewer');
    const viewerImg = viewer.querySelector('.viewer-img');
    const viewerInfo = viewer.querySelector('.viewer-info');

    let memoId = null;    // 今、帯に出している資料
    let records = [];     // その資料の画像
    let urls = new Map(); // 画像 id → 表示用の URL（blob:）。使い終わったら revoke しないとメモリに残り続ける
    let viewIndex = -1;
    let busy = Promise.resolve(); // 追加・削除を順番に処理する（連打やまとめて貼ったときに順番が入れ替わらないように）

    const enabled = storage.hasImages;

    function revokeAll() {
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls = new Map();
    }
    function urlOf(r) {
      let u = urls.get(r.id);
      if (!u) { u = URL.createObjectURL(r.blob); urls.set(r.id, u); }
      return u;
    }

    function render() {
      list.textContent = '';
      records.forEach((r, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'attach-thumb';
        b.title = `${r.name || '画像'}（クリックで大きく表示）`;
        const img = document.createElement('img');
        img.src = urlOf(r);
        img.alt = r.name || '';
        img.decoding = 'async';
        b.appendChild(img);
        b.addEventListener('click', () => openViewer(i));
        list.appendChild(b);
      });
      bar.classList.toggle('empty', records.length === 0);
      if (onCountChange && memoId) onCountChange(memoId, records.length);
    }

    // 資料を開いたとき・閉じたときに呼ぶ。本文（原稿）のときは帯を隠す
    async function show(memo) {
      const id = memo && memo.parentId ? memo.id : null;
      bar.hidden = !id;
      if (id === memoId) return;
      memoId = id;
      revokeAll();
      records = [];
      list.textContent = '';
      if (!id) return;
      const loaded = enabled ? await storage.imagesOf(id).catch(() => []) : [];
      if (memoId !== id) return; // 読み込んでいる間に別の原稿に切り替わった
      records = loaded;
      render();
    }

    async function refresh() {
      const id = memoId;
      memoId = null;
      await show(getMemo());
      return id;
    }

    // ファイルを受け取って、縮小して保存し、帯に足す
    function addFiles(files) {
      const memo = getMemo();
      const images = Array.from(files || []).filter(isImageFile);
      if (!images.length) return false;
      if (!memo || !memo.parentId) {
        notify('画像は資料に貼れる。資料を開いてから貼ってね。');
        return true;
      }
      if (!enabled) {
        notify('このブラウザでは画像を保存できない。');
        return true;
      }
      busy = busy.then(async () => {
        let added = 0;
        for (const f of images) {
          try {
            const p = await prepare(f);
            const rec = {
              id: makeId(), memoId: memo.id, blob: p.blob, type: p.type, width: p.width, height: p.height,
              name: f.name && f.name !== 'image.png' ? f.name : '', size: p.blob.size, createdAt: Date.now() + added,
            };
            await storage.putImages([rec]);
            if (memoId === memo.id) { records.push(rec); render(); }
            added++;
            onChange();
          } catch (e) {
            notify(e instanceof ImageError ? e.message
              : e && e.name === 'QuotaExceededError' ? '保存できなかった（ディスクの空きが足りない）。'
                : '画像を保存できなかった。');
          }
        }
        if (added > 1) notify(`画像を ${added} 枚追加した。`);
      });
      return true;
    }

    // ------------------------------------------------------------
    // 拡大表示
    // ------------------------------------------------------------
    function openViewer(i) {
      viewIndex = i;
      paintViewer();
      if (!viewer.open) viewer.showModal();
    }
    function paintViewer() {
      const r = records[viewIndex];
      if (!r) { viewer.close(); return; }
      viewerImg.src = urlOf(r);
      viewerImg.alt = r.name || '';
      viewerInfo.textContent = [
        r.name, `${r.width}×${r.height}`, formatBytes(r.size), records.length > 1 ? `${viewIndex + 1} / ${records.length}` : '',
      ].filter(Boolean).join('　');
      viewer.querySelector('[data-act=prev]').disabled = viewIndex <= 0;
      viewer.querySelector('[data-act=next]').disabled = viewIndex >= records.length - 1;
    }
    function step(d) {
      const n = viewIndex + d;
      if (n < 0 || n >= records.length) return;
      viewIndex = n;
      paintViewer();
    }

    // 削除は確認ダイアログを出さず、「元に戻す」付きのお知らせにする（確認は毎回出ると読まずに押す癖がつく）
    function removeCurrent() {
      const r = records[viewIndex];
      if (!r) return;
      records.splice(viewIndex, 1);
      busy = busy.then(() => storage.deleteImage(r.id)).then(onChange).catch(() => {});
      if (viewIndex >= records.length) viewIndex = records.length - 1;
      render();
      if (records.length) paintViewer(); else viewer.close();
      notify('画像を削除した。', {
        label: '元に戻す',
        run: () => {
          busy = busy.then(async () => {
            await storage.putImages([r]);
            onChange();
            if (memoId === r.memoId) {
              records.push(r);
              records.sort((a, b) => a.createdAt - b.createdAt);
              render();
            }
          }).catch(() => notify('元に戻せなかった。'));
        },
      });
    }

    viewer.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'prev') step(-1);
        else if (a === 'next') step(1);
        else if (a === 'delete') removeCurrent();
        else if (a === 'close') viewer.close();
        return;
      }
      if (e.target === viewer) viewer.close(); // 画像の外（暗いところ）を押したら閉じる
    });
    viewer.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeCurrent(); }
    });
    viewer.addEventListener('close', () => { viewerImg.removeAttribute('src'); });

    // ------------------------------------------------------------
    // 追加の入口：ボタン・貼り付け・ドロップ
    // ------------------------------------------------------------
    addBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      fileInput.value = ''; // 同じファイルをもう一度選んでも change が来るように
      addFiles(files);
    });

    // 貼り付け：画像だけが入っているときに受け取る。
    // Word などからのコピーは「文字＋画像」が一緒に入っていることがあり、そのときは文字の貼り付けを優先する
    function handlePaste(e) {
      const dt = e.clipboardData;
      if (!dt) return;
      const files = Array.from(dt.files || []).filter(isImageFile);
      if (!files.length) return;
      if (dt.getData('text/plain')) return;
      e.preventDefault();
      addFiles(files);
    }

    return { show, refresh, addFiles, handlePaste, isImageFile, get memoId() { return memoId; } };
  }

  root.KotobaImages = { prepare, create, isImageFile, formatBytes, ImageError };
})(typeof window !== 'undefined' ? window : globalThis);
