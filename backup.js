// kotoba - バックアップ（全原稿を1ファイルに保存・そこから戻す）
//
// 構成:
//   build / parse / unzip / merge / syncMerge / mergeImages（DOM なし）: node だけでテストできる
//   create: 書き出しダイアログの「バックアップ」欄と、「戻す」ダイアログ
//
// 形式（version）:
//   1 … .json 1枚。文章だけ。中身が見えるので、kotoba が動かなくてもメモ帳で本文を救い出せる
//   2 … .zip。画像を貼っているときだけこちら。中身は backup.json（version 2）と images/ フォルダ。
//       zip を展開すれば、画像もふつうの画像ファイルとして取り出せる（kotoba が無くても困らない）
//   画像がなければ今まで通り version 1 の .json を出す。読むときは 1 も 2 も読める。
//   自分より新しい version は読まない（知らない項目を黙って捨てると、戻したつもりで欠ける）。
//
// 戻し方（3つ）:
//   追加する          … 今の原稿は書き換えない。同じ中身のものは飛ばす
//   新しい方で更新    … 別の端末からの引き継ぎ用。原稿ごとに新しい方を残す。両方で書き換えていたら両方残す
//   入れ替える        … 全部バックアップの中身にする（前の状態は自動でダウンロードしておく）

(function (root) {
  'use strict';

  // 中身の目印。アプリの名前を「タコエディタ」に変えたあとも 'kotoba' のまま（変えると今までのバックアップが読めなくなる）
  const APP = 'kotoba';
  const KIND = 'backup';
  const VERSION = 2;                          // 読める一番新しい版
  const MAX_JSON = 100 * 1024 * 1024;         // 文章だけで 100MB はまず届かない。壊れた巨大ファイルで固まらないための上限
  const MAX_ZIP = 1024 * 1024 * 1024;         // 画像込みで 1GB まで
  const JSON_NAME = 'backup.json';

  // ===============================================================
  // 作る
  // ===============================================================

  // images（画像の情報。中身は zip の別ファイル）があれば version 2、なければ version 1
  function build(store, now = new Date(), images = null) {
    const out = {
      app: APP,
      kind: KIND,
      version: images && images.length ? 2 : 1,
      exportedAt: now.toISOString(),
      memos: store.memos.map((m) => ({
        id: m.id, parentId: m.parentId || null, title: m.title, body: m.body, updatedAt: m.updatedAt,
        // base … この原稿を最後に別の端末とやりとりしたときの版（「新しい方で更新」で、両方で書き換えたかを見分ける）
        ...(Number.isFinite(m.base) ? { base: m.base } : {}),
      })),
      activeId: store.activeId,
      pinnedId: store.pinnedId,
      settings: store.settings,
      // 消した原稿の印（墓標）。「新しい方で更新」で、別の端末にも消したことを伝える
      deleted: (store.deleted || []).map((t) => ({ id: t.id, at: t.at })),
    };
    if (images && images.length) out.images = images;
    return out;
  }

  const pad = (n) => String(n).padStart(2, '0');

  // タコエディタ_バックアップ_2026-10-08-2330.json（ファイル名順に並べると日付順になるように、年から書く）
  // どのファイルがバックアップかは中身（app: 'kotoba'）で判定するので、ファイル名を変えても前のバックアップは読める
  function fileName(now = new Date(), suffix = '', ext = 'json') {
    const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    return `タコエディタ_バックアップ_${d}${suffix}.${ext}`;
  }

  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
  const extOf = (type) => EXT[type] || 'bin';

  // ===============================================================
  // 読む
  // ===============================================================

  // 戻り値: { ok: true, data, counts } または { ok: false, error }
  // 多少おかしなところ（型の違い・親が見つからない資料）は直して読む。読めないものだけ断る。
  // バックアップから戻すのは「困っているとき」なので、細かい不備で全部を断るより、救えるものを救う
  function parse(text, makeId, { inZip = false } = {}) {
    if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'ファイルが空っぽ。' };
    if (text.length > MAX_JSON) return { ok: false, error: 'ファイルが大きすぎる（100MB まで）。' };

    let raw;
    try {
      raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // BOM 付きで保存し直された場合
    } catch (_) {
      return { ok: false, error: 'JSON として読めなかった。タコエディタのバックアップファイルを選んでね。' };
    }
    if (!raw || typeof raw !== 'object' || raw.app !== APP || raw.kind !== KIND) {
      return { ok: false, error: 'タコエディタのバックアップファイルではないみたい。' };
    }
    if (typeof raw.version !== 'number' || raw.version > VERSION) {
      return { ok: false, error: 'もっと新しいタコエディタで作られたバックアップなので、この版では読めない。タコエディタを更新してから試してね。' };
    }
    if (raw.version >= 2 && !inZip) {
      return { ok: false, error: '画像つきのバックアップは .zip のまま選んでね（展開した中の backup.json だけでは画像が戻せない）。' };
    }
    if (!Array.isArray(raw.memos)) return { ok: false, error: '原稿の一覧が見つからなかった。' };

    const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
    const seen = new Set();
    const memos = [];
    for (const m of raw.memos) {
      if (!m || typeof m !== 'object') continue;
      let id = typeof m.id === 'string' && m.id ? m.id : makeId();
      if (seen.has(id)) id = makeId(); // 同じ id が2つ（手で編集した等）→ 片方に新しい id
      seen.add(id);
      memos.push({
        id,
        parentId: typeof m.parentId === 'string' && m.parentId ? m.parentId : null,
        title: str(m.title),
        body: str(m.body),
        updatedAt: Number.isFinite(m.updatedAt) ? m.updatedAt : Date.now(),
        ...(Number.isFinite(m.base) ? { base: m.base } : {}),
      });
    }

    // 親が見つからない資料・資料にぶら下がった資料は、捨てずに作品（親なし）として残す。
    // 順番が大事: 先に「親がいない」ものを作品に格上げしてから作品の一覧を作る。
    // 逆にすると、格上げされた作品にぶら下がっている資料まで「親が作品じゃない」扱いになる
    const allIds = new Set(memos.map((m) => m.id));
    for (const m of memos) {
      if (m.parentId && !allIds.has(m.parentId)) m.parentId = null;
    }
    const mainIds = new Set(memos.filter((m) => !m.parentId).map((m) => m.id));
    for (const m of memos) {
      if (m.parentId && !mainIds.has(m.parentId)) m.parentId = null;
    }

    if (memos.length === 0) return { ok: false, error: 'バックアップの中に原稿が1つもない。' };

    // 画像の情報（中身は zip から parseFile が後で付ける）。原稿が見つからない画像は捨てる
    const images = [];
    if (Array.isArray(raw.images)) {
      for (const im of raw.images) {
        if (!im || typeof im !== 'object' || typeof im.path !== 'string' || !allIds.has(im.memoId)) continue;
        images.push({
          id: typeof im.id === 'string' && im.id ? im.id : makeId(),
          memoId: im.memoId,
          path: im.path,
          type: str(im.type) || 'application/octet-stream',
          width: Number(im.width) || 0,
          height: Number(im.height) || 0,
          name: str(im.name),
          createdAt: Number.isFinite(im.createdAt) ? im.createdAt : Date.now(),
        });
      }
    }

    // 墓標。今バックアップの中にある原稿の墓標は捨てる（矛盾するので）
    const deleted = Array.isArray(raw.deleted)
      ? raw.deleted.filter((t) => t && typeof t.id === 'string' && Number.isFinite(t.at) && !allIds.has(t.id)).map((t) => ({ id: t.id, at: t.at }))
      : [];

    const exportedAt = Date.parse(raw.exportedAt);
    return {
      ok: true,
      data: {
        memos,
        images,
        deleted,
        activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
        pinnedId: typeof raw.pinnedId === 'string' ? raw.pinnedId : null,
        settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
        exportedAt: Number.isFinite(exportedAt) ? exportedAt : null,
      },
      counts: {
        mains: memos.filter((m) => !m.parentId).length,
        refs: memos.filter((m) => m.parentId).length,
        images: images.length,
      },
    };
  }

  // ---------------------------------------------------------------
  // zip を読む
  // ---------------------------------------------------------------
  // 書くのは export.js の zip()（無圧縮）。読む側は、ユーザーが展開して zip し直した場合（圧縮あり）にも
  // 対応する。圧縮（deflate）の展開はブラウザの DecompressionStream に任せる。
  // 戻り値: Map（ファイル名 → Uint8Array）
  async function unzip(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // 終端レコードは末尾にある（後ろにコメントが付くことがあるので、後ろから探す）
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip の終わりが見つからない');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip の目次が壊れている');
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue; // フォルダ
      // 中身の位置はローカルヘッダの後ろ。ローカルヘッダの extra の長さは目次と違うことがあるので、そちらを読む
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = u8.subarray(start, start + compSize);
      if (method === 0) {
        out.set(name, raw);
      } else if (method === 8 && typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
      }
      // それ以外の圧縮方式は飛ばす（kotoba の zip では使わない）
    }
    return out;
  }

  const isZip = (u8) => u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04; // "PK.."

  // ファイル（.json / .zip）を読む。zip なら画像の中身（Blob）も付ける
  async function parseFile(file, makeId) {
    if (file.size > MAX_ZIP) return { ok: false, error: 'ファイルが大きすぎる（1GB まで）。' };
    let u8;
    try {
      u8 = new Uint8Array(await file.arrayBuffer());
    } catch (_) {
      return { ok: false, error: 'ファイルを読めなかった。' };
    }
    if (!isZip(u8)) {
      if (u8.length > MAX_JSON) return { ok: false, error: 'ファイルが大きすぎる（100MB まで）。' };
      return parse(new TextDecoder().decode(u8), makeId);
    }

    let entries;
    try {
      entries = await unzip(u8);
    } catch (_) {
      return { ok: false, error: 'zip を開けなかった（壊れているかも）。' };
    }
    // 展開して zip し直すと「フォルダ名/backup.json」になることがあるので、末尾で探す
    const jsonName = [...entries.keys()].find((k) => k === JSON_NAME || k.endsWith('/' + JSON_NAME));
    if (!jsonName) return { ok: false, error: 'zip の中に backup.json が見つからなかった。タコエディタのバックアップを選んでね。' };
    const prefix = jsonName.slice(0, -JSON_NAME.length);
    const result = parse(new TextDecoder().decode(entries.get(jsonName)), makeId, { inZip: true });
    if (!result.ok) return result;

    let missing = 0;
    result.data.images = result.data.images.filter((im) => {
      const bytes = entries.get(prefix + im.path);
      if (!bytes) { missing++; return false; }
      im.blob = new Blob([bytes], { type: im.type });
      im.size = bytes.length;
      delete im.path;
      return true;
    });
    result.counts.images = result.data.images.length;
    result.missingImages = missing;
    return result;
  }

  // 空っぽの原稿（タイトルも本文もなく、資料もぶら下がっていない）。新しい端末で最初に開いたときにできるもの。
  // これを持ち込むと、取り込むたびに「無題」が増えていくので、足す対象から外す
  function isEmptyMemo(m, all) {
    return !m.title.trim() && !m.body.trim() && !all.some((x) => x.parentId === m.id);
  }

  // ===============================================================
  // 今の原稿に足す（追加する）
  // ===============================================================

  // 同じバックアップを2回読み込んでも原稿が倍にならないよう、中身（タイトル・本文・どの作品の資料か）が
  // まったく同じ原稿がすでにあれば飛ばす。id では比べない（1回目に足したコピーは別の id になっているので、
  // id で比べると2回目も「新しい」と判定されてしまう）。
  // 足すものの id が今の原稿とぶつかったら（＝同じ原稿の、別の時点の版）、新しい id にして、
  // 見分けがつくようにタイトルの後ろに copySuffix（「（10/8 のバックアップ）」など）を付ける。
  // 今ある原稿は書き換えない（追加で今の原稿が変わったら「追加」の意味がない）。
  // 戻り値: { memos（足したあとの全部）, added, skipped, firstAddedMainId, idMap }
  // localDeleted … こちらの墓標。消した原稿を「追加」で救い出したときは、更新時刻を今にする。
  //   救い出すのは「消したあとに手を加えた」のと同じこと。古い時刻のままだと、次に「新しい方で更新」したとき
  //   別の端末の墓標（消した時刻）より古いと判定されて、また消されてしまう
  function merge(current, incoming, makeId, copySuffix = '', localDeleted = []) {
    const resurrect = new Set(localDeleted.map((t) => t.id));
    const now = Date.now();
    const usedIds = new Set(current.map((m) => m.id));
    const sig = (m, parentId) => JSON.stringify([parentId || null, m.title, m.body]);
    const bySig = new Map(current.map((m) => [sig(m, m.parentId), m.id]));
    const idMap = new Map(); // バックアップ内の id → 実際に使う id
    const toAdd = [];
    let skipped = 0;

    // 作品を先に処理する（資料の parentId を付け替えるのに、親の行き先が要る）
    const ordered = [...incoming.filter((m) => !m.parentId), ...incoming.filter((m) => m.parentId)]
      .filter((m) => !isEmptyMemo(m, incoming));
    for (const m of ordered) {
      const parentId = m.parentId ? idMap.get(m.parentId) : null;
      // 前に同じバックアップから足したコピーは、タイトルに印が付いているので、印付きでも比べる
      const same = bySig.get(sig(m, parentId)) || (copySuffix && !parentId && bySig.get(sig({ ...m, title: m.title + copySuffix }, null)));
      if (same) {
        idMap.set(m.id, same);
        skipped++;
        continue;
      }
      const clash = usedIds.has(m.id);
      const id = clash ? makeId() : m.id;
      usedIds.add(id);
      idMap.set(m.id, id);
      const memo = {
        ...m, id, parentId,
        title: clash && !parentId && copySuffix ? m.title + copySuffix : m.title,
        base: m.updatedAt, // 「この版を受け取った」印。あとで「新しい方で更新」するときの基準になる
        ...(resurrect.has(m.id) ? { updatedAt: Math.max(m.updatedAt, now) } : {}),
      };
      bySig.set(sig(m, parentId), id); // バックアップの中に同じものが2つあっても1つだけ足す
      toAdd.push(memo);
    }

    const firstMain = toAdd.find((m) => !m.parentId);
    return {
      memos: [...current, ...toAdd],
      added: toAdd.length,
      skipped,
      firstAddedMainId: firstMain ? firstMain.id : (toAdd[0] ? toAdd[0].parentId : null),
      idMap,
    };
  }

  // ===============================================================
  // 新しい方で更新（別の端末からの引き継ぎ）
  // ===============================================================
  //
  // 「新しい方を残す」だけだと、両方の端末で書き換えていたとき、古い方の書き足しが黙って消える。
  // それを見分けるために、原稿ごとに base（最後に別の端末とやりとりした版の updatedAt）を持たせる。
  //
  //   共通の版 = max(こちらの base, 向こうの base)
  //   向こうが共通の版から変わっていない → こちらのまま
  //   こちらが共通の版から変わっていない → 向こうの版で上書き
  //   両方変わっている                   → こちらはそのまま、向こうの版をタイトルに印を付けて足す（どちらも消さない）
  //
  // base がない（一度もやりとりしていない）原稿は、中身が違えば「両方変わっている」扱い（安全側）。
  //
  // 消した原稿（墓標 { id, at }）:
  //   向こうで消した原稿 … こちらで消したあとに書き換えていなければ、こちらでも消す。
  //                          書き換えていたら消さずに残す（書き足しを守る方が安全）。
  //                          作品を消すとき、こちらにしかない資料がぶら下がっていたら、作品も残す（資料が迷子になるので）
  //   こちらで消した原稿 … 向こうから来ても、消したあとに書き換えられていなければ足し直さない
  //
  // 戻り値: { memos, updated, added, conflicts, same, removed, keptDeleted, stayDeleted, deleted, idMap }
  // current の原稿オブジェクトは書き換えない（保存に失敗したときに巻き戻せるよう、書き換えるものは複製する）
  function syncMerge(current, incoming, makeId, conflictSuffix = '（別の端末の版）', { localDeleted = [], incomingDeleted = [] } = {}) {
    const out = current.map((m) => m);
    const localDel = new Map(localDeleted.map((t) => [t.id, t.at]));
    let stayDeleted = 0;
    const indexOf = new Map(out.map((m, i) => [m.id, i]));
    const idMap = new Map();
    let updated = 0;
    let added = 0;
    let conflicts = 0;
    let same = 0;
    const NONE = -Infinity;

    const ordered = [...incoming.filter((m) => !m.parentId), ...incoming.filter((m) => m.parentId)]
      .filter((m) => !isEmptyMemo(m, incoming));
    for (const m of ordered) {
      const parentId = m.parentId ? (idMap.get(m.parentId) || m.parentId) : null;
      const i = indexOf.get(m.id);
      idMap.set(m.id, m.id); // 最後に、結果に残らなかった原稿の分は外す（画像の付け替え先にしないため）

      if (i === undefined) {
        // こちらで消した原稿で、消したあとに向こうで書き換えられていない → 足し直さない
        if (localDel.has(m.id) && m.updatedAt <= localDel.get(m.id)) { stayDeleted++; continue; }
        // こちらにない原稿 → 足す
        out.push({ ...m, parentId, base: m.updatedAt });
        indexOf.set(m.id, out.length - 1);
        added++;
        continue;
      }

      const c = out[i];
      if (c.title === m.title && c.body === m.body) {
        // 中身が同じ。次回のために「ここまでは同じ」と印だけ付ける
        const base = Math.max(c.updatedAt, m.updatedAt);
        if (c.base !== base) out[i] = { ...c, base };
        same++;
        continue;
      }

      const common = Math.max(Number.isFinite(c.base) ? c.base : NONE, Number.isFinite(m.base) ? m.base : NONE);
      const theirsChanged = m.updatedAt > common;
      const oursChanged = c.updatedAt > common;

      if (!theirsChanged) {
        same++; // 向こうは古い版のまま。こちらを残す
      } else if (!oursChanged) {
        out[i] = { ...c, title: m.title, body: m.body, parentId: parentId || c.parentId || null, updatedAt: m.updatedAt, base: m.updatedAt };
        updated++;
      } else {
        // 両方で書き換えている。どちらも消さない（向こうの版を印付きで足す）。
        // 同じファイルをもう一度取り込んだときに同じコピーが増えないよう、まったく同じコピーがあれば飛ばす。
        // ※ ここで base を進めてはいけない。進めると、次に向こうがまた書いたとき、
        //    こちらの書き足しが「変わっていない」と判定されて上書きされる（＝消える）
        const title = m.title + conflictSuffix;
        if (out.some((x) => x.title === title && x.body === m.body && (x.parentId || null) === parentId)) { same++; continue; }
        out.push({ ...m, id: makeId(), parentId, title, base: m.updatedAt });
        conflicts++;
      }
    }

    // 向こうで消した原稿をこちらでも消す
    const removing = new Set();
    let keptDeleted = 0;
    for (const t of incomingDeleted) {
      const c = out.find((m) => m.id === t.id);
      if (!c) continue;
      if (c.updatedAt > t.at) { keptDeleted++; continue; } // 消されたあとに、こちらで書き換えている
      removing.add(c.id);
    }
    // 作品を消すなら、その資料も全部消える予定でないといけない（こちらにしかない資料があれば作品を残す）
    for (const id of [...removing]) {
      const m = out.find((x) => x.id === id);
      if (m && !m.parentId && out.some((x) => x.parentId === id && !removing.has(x.id))) {
        removing.delete(id);
        keptDeleted++;
      }
    }
    const memos = out.filter((m) => !removing.has(m.id));
    // 結果に残らなかった原稿（足し直さなかった・消した）は、画像の付け替え先から外す。
    // 外さないと、持ち主のいない画像だけが保存されて、見えないまま容量を食い続ける
    const alive = new Set(memos.map((m) => m.id));
    for (const [from, to] of [...idMap]) if (!alive.has(to)) idMap.delete(from);
    // 親が見つからない資料は作品にする（消された作品の資料を、向こうで書き換えていた場合など）。迷子で捨てない
    const ids = new Set(memos.map((m) => m.id));
    for (let k = 0; k < memos.length; k++) {
      if (memos[k].parentId && !ids.has(memos[k].parentId)) memos[k] = { ...memos[k], parentId: null };
    }
    // 墓標は両方を合わせて、同じ原稿なら新しい方の時刻。今ある原稿の墓標は持たない
    const del = new Map();
    for (const t of [...localDeleted, ...incomingDeleted]) {
      if (!ids.has(t.id) && (!del.has(t.id) || del.get(t.id) < t.at)) del.set(t.id, t.at);
    }
    for (const id of removing) {
      const t = incomingDeleted.find((x) => x.id === id);
      if (t) del.set(id, t.at);
    }
    return {
      memos, updated, added, conflicts, same, idMap,
      removed: [...removing], keptDeleted, stayDeleted,
      deleted: [...del].map(([id, at]) => ({ id, at })),
    };
  }

  // ===============================================================
  // 画像を足す（追加する・新しい方で更新 で共通）
  // ===============================================================
  // 原稿の id の付け替え（idMap）に合わせて画像の memoId も付け替える。
  // 同じ資料に、同じ大きさ・同じ寸法・同じ形式の画像がすでにあれば同じものとみなして飛ばす
  // （中身を1バイトずつ比べるのは重いので、この3つで十分とする）
  function mergeImages(existing, incoming, idMap, makeId) {
    const sig = (im, memoId) => `${memoId}|${im.size}|${im.width}x${im.height}|${im.type}`;
    const have = new Set(existing.map((im) => sig(im, im.memoId)));
    const usedIds = new Set(existing.map((im) => im.id));
    const out = [];
    for (const im of incoming) {
      const memoId = idMap.get(im.memoId);
      if (!memoId) continue;
      const s = sig(im, memoId);
      if (have.has(s)) continue;
      have.add(s);
      const id = usedIds.has(im.id) ? makeId() : im.id;
      usedIds.add(id);
      out.push({ ...im, id, memoId });
    }
    return out;
  }

  // 「3日前」など。前回のバックアップがどれくらい前かを、ざっくり見せる
  function ago(then, now = Date.now()) {
    const min = Math.floor((now - then) / 60000);
    if (min < 1) return 'たった今';
    if (min < 60) return `${min}分前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}時間前`;
    const d = Math.floor(h / 24);
    if (d < 60) return `${d}日前`;
    return `${Math.floor(d / 30)}か月前`;
  }

  function formatDate(t) {
    const d = new Date(t);
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ===============================================================
  // 画面（DOM あり）
  // ===============================================================

  const STALE_DAYS = 14; // これ以上バックアップしていなければ、前回の日付を目立たせる

  function create({
    getStore, getLastBackupAt, onBackedUp, replaceWith, mergeWith, makeId, notify,
    storage, onImagesChanged, onDropFiles, getMode, setMode,
    folder = null, // { name(), ensure(), write(name, blob) } … 自動バックアップのフォルダ（あれば手動の保存もそこへ）
  }) {
    const exportDialog = document.getElementById('exportDialog');
    const lastEl = document.getElementById('backupLast');
    const saveBtn = document.getElementById('backupSave');
    const loadBtn = document.getElementById('backupLoad');
    const fileInput = document.getElementById('backupFile');
    const destEl = document.getElementById('backupDest');

    const dialog = document.getElementById('restoreDialog');
    const form = dialog.querySelector('form');
    const summary = dialog.querySelector('.restore-summary');
    const note = dialog.querySelector('.restore-note');

    let pending = null; // 読み込んで、確認待ちのバックアップ

    function showLast() {
      const t = getLastBackupAt();
      lastEl.textContent = t ? `前回：${ago(t)}` : 'まだ一度も保存していない';
      lastEl.classList.toggle('stale', !t || Date.now() - t > STALE_DAYS * 86400000);
      // 保存先をはっきり書く。手動と自動で置き場所が違うと、消えたときに探せない
      destEl.textContent = folder && folder.name()
        ? `保存先：「${folder.name()}」フォルダ（自動バックアップと同じ場所）`
        : '保存先：ダウンロードフォルダ（下の自動バックアップでフォルダを選ぶと、手動の保存もそこに入る）';
    }

    // バックアップの中身を作る（手動の「バックアップを保存」と、自動バックアップ（autobackup.js）で共通）。
    // 戻り値: { blob, ext: 'json' | 'zip' }
    async function makeBlob(now = new Date()) {
      const store = getStore();
      const ids = new Set(store.memos.map((m) => m.id));
      const imgs = storage && storage.hasImages ? (await storage.allImages().catch(() => [])).filter((r) => ids.has(r.memoId)) : [];

      if (!imgs.length) {
        // 改行を入れておくと、メモ帳で開いたときに読める
        return { ext: 'json', blob: new Blob([JSON.stringify(build(store, now), null, 1)], { type: 'application/json' }) };
      }
      {
        const meta = imgs.map((r) => ({
          id: r.id, memoId: r.memoId, path: `images/${r.id}.${extOf(r.type)}`,
          type: r.type, width: r.width, height: r.height, name: r.name || '', createdAt: r.createdAt,
        }));
        const files = { [JSON_NAME]: JSON.stringify(build(store, now, meta), null, 1) };
        for (let i = 0; i < imgs.length; i++) files[meta[i].path] = new Uint8Array(await imgs[i].blob.arrayBuffer());
        return { ext: 'zip', blob: new Blob([root.KotobaExport.zip(files, now)], { type: 'application/zip' }) };
      }
    }

    // 保存先: 自動バックアップのフォルダを選んでいればそこ、なければダウンロード（folder は app.js が渡す）。
    // 戻り値: { name, where }（where は「『〇〇』フォルダ」か「ダウンロードフォルダ」。お知らせに使う）
    async function save(suffix = '') {
      // 先に書き込みの許可を確かめる（許可のダイアログはクリックの直後にしか出せない。中身を作ってからだと間に合わないことがある）
      const useFolder = folder && folder.name() ? await folder.ensure() : false;
      const now = new Date();
      const { blob, ext } = await makeBlob(now);
      const name = fileName(now, suffix, ext);
      let where = 'ダウンロードフォルダ';
      if (useFolder) {
        try {
          await folder.write(name, blob);
          where = `「${folder.name()}」フォルダ`;
        } catch (_) {
          await root.KotobaPlatform.saveFile(name, blob); // フォルダに書けなかったらダウンロードに逃がす（保存しないよりいい）
        }
      } else {
        await root.KotobaPlatform.saveFile(name, blob);
      }
      onBackedUp(now.getTime());
      showLast();
      return { name, where };
    }

    const NOTES = {
      merge: ['追加する', '今ある原稿はそのまま残して、バックアップの原稿を一覧に足す。まったく同じ原稿がすでにあれば飛ばす。'],
      update: ['更新する', '別の端末で書いた続きを取り込む用。原稿ごとに新しい方を残す。両方の端末で書き換えていた原稿は、どちらも消さずに「（別の端末の版）」を足す。別の端末で消した原稿は、こちらでも消す（消したあとにこちらで書き換えていたら残す）。'],
      replace: ['入れ替える', '今の原稿はすべて消えて、バックアップの中身に入れ替わる。念のため、入れ替える前の状態を「…_入れ替え前」としてバックアップの保存先に残しておく。'],
    };
    function syncNote() {
      const [label, text] = NOTES[form.elements.mode.value] || NOTES.merge;
      note.textContent = text;
      form.querySelector('.export-ok').textContent = label;
    }

    // ファイルを読んで、確認ダイアログを出す（ボタンからでも、ドロップからでも）
    async function openFile(file) {
      if (!file) return;
      const result = await parseFile(file, makeId);
      if (!result.ok) { notify(result.error); return; }

      pending = result.data;
      const { mains, refs, images } = result.counts;
      const when = result.data.exportedAt ? `（${formatDate(result.data.exportedAt)} に保存）` : '';
      summary.textContent = `作品 ${mains}・資料 ${refs}${images ? `・画像 ${images}` : ''}${when}`;
      if (result.missingImages) summary.textContent += `　※ 画像 ${result.missingImages} 枚は zip の中に見つからなかった`;
      // 前回選んだ戻し方から始める。ただし「入れ替える」は毎回選び直してもらう（取り消せないので）
      const last = getMode && getMode();
      form.elements.mode.value = last === 'update' ? 'update' : 'merge';
      syncNote();
      if (exportDialog.open) exportDialog.close();
      dialog.showModal();
    }

    // 画像を保存する。失敗しても原稿の方は戻っているので、その旨だけ伝える
    async function putImages(records) {
      if (!records.length) return 0;
      if (!storage || !storage.hasImages) return -records.length;
      try {
        await storage.putImages(records);
        return records.length;
      } catch (_) {
        return -records.length;
      }
    }
    const imageNote = (n) => (n > 0 ? `画像 ${n} 枚も戻した。` : n < 0 ? `画像 ${-n} 枚は保存できなかった（容量不足かも）。` : '');
    const FAIL = '保存できなかったので、元のままにした（ブラウザの保存容量がいっぱい）。';

    async function apply(mode) {
      const data = pending;
      pending = null;
      if (!data) return;
      if (setMode && mode !== 'replace') setMode(mode);

      if (mode === 'replace') {
        // 入れ替えは取り消せないので、消える前の状態を必ずファイルに残す
        const before = await save('_入れ替え前');
        // 入れ替えた原稿は「この版を受け取った」印（base）を付けておく。あとで「新しい方で更新」できるように
        const ok = await replaceWith({ ...data, memos: data.memos.map((m) => ({ ...m, base: m.updatedAt })) });
        if (!ok) { notify(FAIL); return; }
        let n = 0;
        if (storage && storage.hasImages) {
          await storage.clearImages().catch(() => {});
          n = await putImages(data.images.map((im) => ({ ...im })));
        }
        onImagesChanged();
        notify(`バックアップの中身に入れ替えた。前の状態は${before.where}に保存してある。` + imageNote(n));
        return;
      }

      const current = getStore().memos;
      const existingImages = storage && storage.hasImages ? await storage.allImages().catch(() => []) : [];

      if (mode === 'update') {
        const r = syncMerge(current, data.memos, makeId, undefined, { localDeleted: getStore().deleted || [], incomingDeleted: data.deleted || [] });
        const newImages = mergeImages(existingImages, data.images, r.idMap, makeId);
        const changed = r.updated + r.added + r.conflicts + r.removed.length;
        // 変わったものがなくても保存はする（「ここまでは同じ」の印 base や墓標を残すため）
        const ok = await mergeWith({ memos: r.memos, firstAddedMainId: null, deleted: r.deleted });
        if (!ok && changed) { notify(FAIL); return; }
        // 消した原稿の画像も消す
        if (ok && r.removed.length && storage && storage.hasImages) await storage.deleteImagesOf(r.removed).catch(() => {});
        const n = await putImages(newImages);
        if (n || r.removed.length) onImagesChanged();
        if (!changed && !n && !r.keptDeleted) { notify('こちらの方が新しいか同じだったので、何も変えていない。'); return; }
        const parts = [];
        if (r.updated) parts.push(`${r.updated} 件を新しい版にした`);
        if (r.added) parts.push(`${r.added} 件を足した`);
        if (r.removed.length) parts.push(`${r.removed.length} 件を消した（別の端末で消されていたので）`);
        if (r.keptDeleted) parts.push(`${r.keptDeleted} 件は別の端末で消されていたけど、こちらで書き換えていたので残した`);
        if (r.conflicts) parts.push(`${r.conflicts} 件は両方の端末で書き換えていたので、「（別の端末の版）」として両方残した`);
        notify((parts.join('、') || '原稿は変わっていない') + '。' + imageNote(n));
        return;
      }

      // 追加する
      const d = data.exportedAt ? new Date(data.exportedAt) : null;
      const r = merge(current, data.memos, makeId, d ? `（${d.getMonth() + 1}/${d.getDate()} のバックアップ）` : '（バックアップ）', getStore().deleted || []);
      const newImages = mergeImages(existingImages, data.images, r.idMap, makeId);
      if (r.added === 0 && newImages.length === 0) { notify('全部すでにある原稿だったので、何も足していない。'); return; }
      if (r.added && !(await mergeWith(r))) { notify(FAIL); return; }
      const n = await putImages(newImages);
      if (n) onImagesChanged();
      const head = r.added === 0 ? '原稿は全部すでにあった。'
        : r.skipped ? `${r.added} 件を足した（同じものが ${r.skipped} 件あったので飛ばした）。` : `${r.added} 件を足した。`;
      notify(head + imageNote(n));
    }

    // ------------------------------------------------------------
    // イベント
    // ------------------------------------------------------------
    exportDialog.addEventListener('toggle', () => { if (exportDialog.open) showLast(); });
    // showModal() は toggle を出さないブラウザもあるので、開く操作の直後にも更新する
    document.getElementById('exportBtn').addEventListener('click', () => setTimeout(showLast));

    saveBtn.addEventListener('click', () => {
      save().then(({ name, where }) => notify(`${where}に保存した${name.endsWith('.zip') ? '（画像があるので zip）' : ''}。`));
    });
    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      fileInput.value = ''; // 同じファイルをもう一度選んでも change が来るように
      openFile(file);
    });

    form.addEventListener('change', syncNote);
    form.addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'cancel') { pending = null; return; }
      e.preventDefault();
      const mode = form.elements.mode.value;
      dialog.close();
      apply(mode);
    });
    dialog.addEventListener('close', () => { pending = null; });

    // ファイルをウィンドウに落としたとき。何もしないとブラウザがそのファイルを開いて、エディタから離れてしまう。
    // .json / .zip はバックアップとして読み、画像は資料に貼る（onDropFiles）。それ以外は受け付けない
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (document.querySelector('dialog[open]')) return;
      const files = Array.from(e.dataTransfer.files);
      const file = files[0];
      if (file && /\.(json|zip)$/i.test(file.name)) openFile(file);
      else if (!(onDropFiles && onDropFiles(files))) notify('ここに落とせるのは、タコエディタのバックアップか、資料に貼る画像だけ。');
    });

    return { save, openFile, makeBlob, refresh: showLast };
  }

  root.KotobaBackup = { VERSION, build, fileName, parse, parseFile, unzip, merge, syncMerge, mergeImages, ago, create };
})(typeof window !== 'undefined' ? window : globalThis);
