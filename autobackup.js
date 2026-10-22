// タコエディタ - 自動バックアップ（選んだフォルダに、裏でバックアップファイルを書き出す）
//
// 考え方:
//   原稿の本体は今まで通りブラウザの中（IndexedDB）。ブラウザのデータ削除（「Cookie と他のサイトデータ」）で
//   消えたときの保険として、パソコンの普通のフォルダにバックアップを書き出しておく。
//   消えたら、そのファイルをウィンドウにドロップすれば戻る（backup.js の「戻す」）。
//
// 書き出すファイル（選んだフォルダの中）:
//   タコエディタ_自動バックアップ.json（画像があれば .zip）
//     … 変更があれば数分おきと、ページを閉じる・隠すときに上書き
//   タコエディタ_自動バックアップ_2026-10-22.json
//     … 1日1つ（その日最初の書き出しのとき）。14日分残して古いものは消す。
//       うっかり大事な原稿を消した・おかしな状態で上書きされた、というときに前の日へ戻れるように
//
// 仕組み: File System Access API（Chrome / Edge のパソコン版だけ）。フォルダの「取っ手」を IndexedDB に覚えておく。
//   書き込みの許可は、ブラウザを開き直すと切れることがある。許可を求めるにはユーザーのクリックが必要なので、
//   切れているときは右下に「自動バックアップ停止中」のボタンを出し、押してもらって再開する。
//
// ★ 安全装置: 原稿が空っぽ（中身のある原稿が1つもない）のときは書き出さない。
//   ブラウザのデータが消えて空っぽで開いた瞬間に、空の状態で「最新のバックアップ」を上書きしてしまうのを防ぐ。

(function (root) {
  'use strict';

  const MAIN = 'タコエディタ_自動バックアップ';
  const KEEP_DAYS = 14;
  const INTERVAL = 3 * 60 * 1000;   // 書き出しの間隔（変更があっても、これより短い間隔では書かない）
  const FIRST_DELAY = 10 * 1000;    // 開いてから最初の書き出しまでの待ち（打ち始めにいきなり書かない）

  const pad = (n) => String(n).padStart(2, '0');
  const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const DAILY_RE = new RegExp(`^${MAIN}_(\\d{4}-\\d{2}-\\d{2})\\.(json|zip)$`);

  async function exists(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch (_) { return false; }
  }
  async function remove(dir, name) {
    try { await dir.removeEntry(name); } catch (_) { /* なければ何もしない */ }
  }
  // createWritable は一時ファイルに書いてから close で差し替える。途中で閉じられても、元のファイルは壊れない
  async function writeFile(dir, name, blob) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  // フォルダの中から、戻すのに使うバックアップを探す（一番新しいもの）。
  // 自動バックアップ・日ごとの控え・手動のバックアップ（タコエディタ_バックアップ_…）のどれでもいい
  async function findLatest(dir) {
    let best = null;
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !/^タコエディタ_.*\.(json|zip)$/.test(name)) continue;
      const f = await h.getFile();
      if (!best || f.lastModified > best.lastModified) best = f;
    }
    return best;
  }

  function create({ storage, makeBlob, isEmpty, notify, onStatus }) {
    const supported = typeof root.showDirectoryPicker === 'function';
    let dir = null;
    let status = supported ? 'off' : 'unsupported'; // off / active / paused / error / unsupported
    let errorText = '';
    let lastAt = 0;
    let dirty = false;
    let timer = 0;
    let writing = null;
    let dailyDone = '';
    const startedAt = Date.now();

    function setStatus(s, text = '') {
      status = s;
      errorText = text;
      onStatus(info());
    }
    function info() {
      return { status, folder: dir ? dir.name : '', lastAt, errorText, supported };
    }

    async function init() {
      if (!supported) { onStatus(info()); return; }
      dir = (await storage.getValue('backupDir').catch(() => null)) || null;
      lastAt = (await storage.getValue('backupLastAt').catch(() => 0)) || 0;
      if (!dir) { setStatus('off'); return; }
      let perm = 'prompt';
      try { perm = await dir.queryPermission({ mode: 'readwrite' }); } catch (_) { /* 古い形式など */ }
      setStatus(perm === 'granted' ? 'active' : 'paused');
      if (status === 'active') { dirty = true; schedule(); }
    }

    // ------------------------------------------------------------
    // 書き出し
    // ------------------------------------------------------------
    async function writeNow() {
      if (status !== 'active' || !dir) return false;
      if (isEmpty()) return false; // ★ 空っぽの状態でバックアップを上書きしない
      if (writing) { dirty = true; return writing; } // 書いている途中に頼まれたら、終わってからもう一度
      dirty = false;
      writing = (async () => {
        try {
          const now = new Date();
          const { blob, ext } = await makeBlob(now);
          const other = ext === 'json' ? 'zip' : 'json';
          await writeFile(dir, `${MAIN}.${ext}`, blob);
          await remove(dir, `${MAIN}.${other}`); // 画像を貼った・全部消したで形式が変わったら、古い方を消す（どっちが新しいか迷わないように）

          // 日ごとの控え：その日の最初の書き出しのときだけ
          const d = today(now);
          if (dailyDone !== d) {
            if (!(await exists(dir, `${MAIN}_${d}.json`)) && !(await exists(dir, `${MAIN}_${d}.zip`))) {
              await writeFile(dir, `${MAIN}_${d}.${ext}`, blob);
            }
            dailyDone = d;
            await prune();
          }
          lastAt = now.getTime();
          storage.setValue('backupLastAt', lastAt).catch(() => {});
          setStatus('active');
          return true;
        } catch (e) {
          if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) setStatus('paused');
          else if (e && e.name === 'NotFoundError') setStatus('error', 'フォルダが見つからない（移動か削除された？）');
          else if (e && e.name === 'QuotaExceededError') setStatus('error', 'ディスクの空きが足りない');
          else setStatus('error', '書き出せなかった');
          dirty = true;
          return false;
        } finally {
          writing = null;
        }
      })();
      const ok = await writing;
      if (dirty && status === 'active') schedule();
      return ok;
    }

    // 古い日ごとの控えを消す（新しい方から KEEP_DAYS 個を残す）
    async function prune() {
      const dailies = [];
      for await (const [name, h] of dir.entries()) {
        const m = h.kind === 'file' && name.match(DAILY_RE);
        if (m) dailies.push({ name, date: m[1] });
      }
      dailies.sort((a, b) => (a.date < b.date ? 1 : -1));
      for (const x of dailies.slice(KEEP_DAYS)) await remove(dir, x.name);
    }

    function schedule() {
      if (status !== 'active' || timer) return;
      const now = Date.now();
      const due = lastAt && lastAt > startedAt ? lastAt + INTERVAL : startedAt + FIRST_DELAY;
      timer = setTimeout(() => { timer = 0; if (dirty) writeNow(); }, Math.max(0, due - now));
    }

    // 原稿・画像が変わったときに呼ぶ（app.js の保存のあと、images.js の追加・削除のあと）
    function changed() {
      dirty = true;
      schedule();
    }

    // ページを閉じる・隠すとき。終わる保証はないが、始めておく
    function flush() {
      if (dirty && status === 'active') {
        clearTimeout(timer);
        timer = 0;
        writeNow();
      }
    }

    // ------------------------------------------------------------
    // 設定（ボタンから。どれもクリックの中で呼ぶこと。許可のダイアログはクリックがないと出せない）
    // ------------------------------------------------------------
    async function pick() {
      // id を付けると、次に選ぶときも同じ場所から始まる。最初は「書類」フォルダから
      return root.showDirectoryPicker({ id: 'tako-backup', mode: 'readwrite', startIn: 'documents' });
    }

    async function choose() {
      let d;
      try {
        d = await pick();
      } catch (_) {
        return false; // キャンセル
      }
      dir = d;
      await storage.setValue('backupDir', dir).catch(() => {});
      dailyDone = '';
      setStatus('active');
      const wrote = await writeNow();
      notify(wrote ? `自動バックアップを始めた（${dir.name} に保存）。` : `自動バックアップを始めた（${dir.name}）。原稿を書くと保存される。`);
      return true;
    }

    async function resume() {
      if (!dir) return choose();
      let perm = 'denied';
      try { perm = await dir.requestPermission({ mode: 'readwrite' }); } catch (_) { /* 何もしない */ }
      if (perm !== 'granted') { setStatus('paused'); return false; }
      setStatus('active');
      dirty = true;
      await writeNow();
      return true;
    }

    async function stop() {
      clearTimeout(timer);
      timer = 0;
      dir = null;
      await storage.setValue('backupDir', undefined).catch(() => {});
      setStatus('off');
    }

    // 戻す用：フォルダを選んでもらい、その中の一番新しいバックアップを返す。
    // ついでにそのフォルダを自動バックアップの保存先にする（データが消えて設定も消えていることが多いので）。
    // ここでは書き出さない（まだ空っぽなので。戻したあとに isEmpty が false になってから書かれる）
    // 戻り値: File（見つかった）/ null（フォルダにバックアップがない）/ undefined（キャンセル）
    async function chooseForRestore() {
      let d;
      try {
        d = await pick();
      } catch (_) {
        return undefined;
      }
      const file = await findLatest(d).catch(() => null);
      dir = d;
      await storage.setValue('backupDir', dir).catch(() => {});
      dailyDone = '';
      setStatus('active');
      return file;
    }

    // ------------------------------------------------------------
    // 手動のバックアップも同じフォルダに置く（置き場所が分かれていると、消えたときに探せない）
    // ------------------------------------------------------------
    // 書き込みの許可を確かめ、切れていれば求める。許可のダイアログはクリックの直後にしか出せないので、
    // バックアップの中身を作る（画像が多いと時間がかかる）より先に呼ぶこと。戻り値: このフォルダに書けるか
    async function ensureFolder() {
      if (!dir) return false;
      let perm = 'prompt';
      try { perm = await dir.queryPermission({ mode: 'readwrite' }); } catch (_) { /* 何もしない */ }
      if (perm !== 'granted') {
        try { perm = await dir.requestPermission({ mode: 'readwrite' }); } catch (_) { perm = 'denied'; }
      }
      if (perm === 'granted' && status === 'paused') setStatus('active');
      return perm === 'granted';
    }
    async function saveToFolder(name, blob) {
      await writeFile(dir, name, blob);
    }
    const folderName = () => (dir ? dir.name : '');

    return { init, changed, flush, writeNow, choose, resume, stop, chooseForRestore, info, supported, ensureFolder, saveToFolder, folderName };
  }

  root.KotobaAutoBackup = { create, findLatest, MAIN, KEEP_DAYS, today };
})(typeof window !== 'undefined' ? window : globalThis);
