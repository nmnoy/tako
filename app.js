// kotoba - 類語辞典付きメモ（プロトタイプ）
// 設計の背景は SPEC.md を参照。

(async () => {
  'use strict';

  // 辞書は tools/build_dictionary.py が生成する。形は { groups, index, adjectives }（詳しくはスクリプト冒頭）
  const DICT = window.KOTOBA_DICTIONARY || {};
  const GROUPS = DICT.groups || [];
  const INDEX = DICT.index || {};
  const ADJECTIVES = DICT.adjectives || [];

  // 9万語ぶんのキーを持つ普通のオブジェクトなので、"constructor" や "toString" のような
  // 継承プロパティを語と取り違えないよう、in ではなく hasOwnProperty で調べる
  function hasWord(word) {
    return Object.prototype.hasOwnProperty.call(INDEX, word);
  }

  // 見出し語の類語を、意味グループごとの配列で返す。
  // 見出し語自身と、上のグループですでに出た語は除く（同じ候補が何度も並ばないように）
  function synonymsOf(word) {
    if (!hasWord(word)) return null;
    const shown = new Set([word]);
    const result = [];
    for (const gid of INDEX[word]) {
      const words = GROUPS[gid].filter((w) => !shown.has(w));
      words.forEach((w) => shown.add(w));
      if (words.length) result.push(words);
    }
    return result.length ? result : null;
  }

  // カーソルを置いただけで自動検出するか。
  // 選択ベースに切り替えたので既定は false。true にすると旧挙動も併用できる。
  const CARET_DETECT = false;

  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const SELECT_DELAY = 120; // Shift+矢印で選択を伸ばしている最中に連打しないための待ち(ms)
  const CARET_DELAY = 400;  // 自動検出: 打鍵が止まってから検出するまでの待ち(ms)
  const SAVE_DELAY = 1000;  // 最後の入力から保存までの待ち。保存は10万字だと数msかかるので、打鍵中には走らせない
  const IDLE_DELAY = 250;   // 文字数・メモ一覧のラベルの更新を、手が止まってからまとめてやるまでの待ち

  // 保存先のキーは storage.js にある（kotoba:v1 は閉じる瞬間の控えとして今も使う）
  const LEGACY_KEY = 'kotoba:text'; // 1枚メモ時代の保存先。初回だけ移行する

  // い形容詞の語幹の後ろに来うる文字（暑「か」った、暑「く」、暑「け」れば、暑「さ」、暑「そ」う）
  const ADJ_TAIL = 'かくけさそ';

  const app = document.getElementById('app');
  const memoList = document.getElementById('memoList');
  const crumb = document.getElementById('crumb');
  const crumbParent = document.getElementById('crumbParent');
  const addMainBtn = document.getElementById('addMain');

  // 資料を一覧の中でその場に開いたときの本文欄。1つだけ作っておき、開く行の下へ移動させて使い回す。
  const refBody = document.createElement('textarea');
  refBody.className = 'ref-body';
  refBody.spellcheck = false;
  refBody.placeholder = '（空）';
  const titleInput = document.getElementById('title');
  const editor = document.getElementById('editor');
  const count = document.getElementById('count');
  const settingButtons = document.querySelectorAll('.seg-btn[data-setting]');
  const sizeLabel = document.querySelector('.size-value');
  const sizeDown = document.querySelector('[data-size-step="-1"]');
  const sizeUp = document.querySelector('[data-size-step="1"]');

  // 選べる文字サイズ。1px 刻みだと違いが分からないので、大きくなるほど刻みを粗くする
  const FONT_SIZES = [13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28];
  const DEFAULT_FONT_SIZE = 17;
  const search = document.getElementById('search');
  const results = document.getElementById('results');

  // 自前のカーソルとタイプライタースクロール（caret.js）。
  // ミラーとカーソルは .sheet（本文を包む要素）の中に重ねて置く
  const caretEngine = window.KotobaCaret.create(editor, editor.parentElement);

  // 検索・置換（find.js）。設定を読み込んでから作るので、ここでは入れ物だけ用意する
  let find = null;
  // 資料の中の URL のリンク化（links.js）
  let links = null;
  // 書き出し（export.js）
  let exporter = null;
  // 資料の画像（images.js）
  let images = null;
  // 自動バックアップ（autobackup.js）
  let autobackup = null;
  // 完成（done.js）
  let done = null;

  // ちょっとしたお知らせを数秒だけ出す
  // action を渡すとボタン付きになり、押されるまで消えない（「新しい版があります［更新］」など）
  const toast = document.getElementById('toast');
  const toastText = toast.querySelector('.toast-text');
  const toastAction = toast.querySelector('.toast-action');
  let toastTimer = 0;
  let toastRun = null;
  function showToast(message, action) {
    toastText.textContent = message;
    toastRun = action ? action.run : null;
    toastAction.hidden = !action;
    toastAction.textContent = action ? action.label : '';
    toast.classList.toggle('has-action', !!action);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    if (!action) toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
  }
  toastAction.addEventListener('click', () => {
    const run = toastRun;
    toastRun = null;
    toast.classList.remove('show');
    if (run) run();
  });

  // ===============================================================
  // メモの保存・読み込み
  // ===============================================================

  // 保存するものは全部この1オブジェクトに入れて、まるごと JSON で書く。
  // 数十〜数百メモ程度ならこれで十分。重くなったら IndexedDB かファイル保存（Tauri）へ。
  // メインとサブは同じ配列にフラットに並べ、サブは parentId で親を指す。
  // 入れ子（children配列）にしないのは、IDで1発で探せる・付け替えが parentId の書き換えだけで済むから。
  // 階層は1段まで（サブのサブは作らない）。
  let store = {
    memos: [],        // { id, parentId, title, body, updatedAt }  parentId: null ならメイン
    activeId: null,   // エディタで開いているメモ（メインでもサブでもいい）
    pinnedId: null,   // 右パネルにピン留めしているサブ
    lastBackupAt: 0,  // 最後にバックアップを保存した時刻（この端末で。バックアップの中身には入れない）
    deleted: [],      // 消した原稿の印（墓標）{ id, at }。「新しい方で更新」で、消したことを別の端末に伝えるため
    settings: {
      font: 'sans', vertical: false, typewriter: false, fontSize: 17,
      find: { width: true, kana: false, conj: false }, // 検索のゆれの扱い
      export: { scope: 'main', format: 'txt' },          // 書き出しで前回選んだもの
    },
  };

  let saveTimer = null;

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function newMemo(body = '', parentId = null) {
    // createdAt … 作った日。完成のお祝いの「書き始めてから〇日」に使う（10/23 以前の原稿にはない）
    const now = Date.now();
    return { id: makeId(), parentId, title: '', body, createdAt: now, updatedAt: now };
  }

  function findMemo(id) {
    return store.memos.find((m) => m.id === id);
  }

  function activeMemo() {
    return findMemo(store.activeId);
  }

  // 今開いているメモが属するメイン（メインを開いていればそれ自身）
  function activeMain() {
    const memo = activeMemo();
    return memo && memo.parentId ? findMemo(memo.parentId) : memo;
  }

  function mains() {
    return store.memos.filter((m) => !m.parentId);
  }

  function subsOf(mainId) {
    return store.memos.filter((m) => m.parentId === mainId);
  }

  // 保存先（storage.js）。起動時に開く。IndexedDB が本命、localStorage は閉じる瞬間の控え
  let storage = null;

  // 起動時に、保存先から読んだもの（data）を store に入れる
  function loadStore(parsed) {
    try {
      if (parsed) {
        if (parsed && Array.isArray(parsed.memos)) {
          // サブ機能以前のデータには parentId がないので、全部メインとして扱う
          store.memos = parsed.memos.map((m) => ({ parentId: null, ...m }));
          store.activeId = parsed.activeId;
          store.pinnedId = parsed.pinnedId || null;
          store.lastBackupAt = Number(parsed.lastBackupAt) || 0;
          store.deleted = Array.isArray(parsed.deleted) ? parsed.deleted : [];
          store.settings = mergeSettings(store.settings, parsed.settings);
        }
      } else {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy) store.memos = [newMemo(legacy)];
      }
    } catch (_) {
      // 壊れたデータ / プライベートウィンドウ等。新規メモで始める
    }

    normalizeStore();
  }

  // 保存されていた設定（古い版のもの・バックアップのもの）を、今の版の形に揃える
  function mergeSettings(base, saved) {
    const s = saved && typeof saved === 'object' ? saved : {};
    const out = { ...base, ...s };
    out.find = { width: true, kana: false, conj: false, ...s.find };
    out.export = { scope: 'main', format: 'txt', ...s.export };
    // タイプライターはボタンを外したので、以前オンで保存されていても切っておく（仕組み自体は caret.js に残っている）
    out.typewriter = false;
    // バックアップは手で書き換えられるかもしれないので、ありえない値は既定に戻す
    if (!Number.isFinite(out.fontSize)) out.fontSize = DEFAULT_FONT_SIZE;
    out.fontSize = Math.min(Math.max(out.fontSize, FONT_SIZES[0]), FONT_SIZES[FONT_SIZES.length - 1]);
    if (out.font !== 'serif') out.font = 'sans';
    out.vertical = out.vertical === true;
    if (!['auto', 'light', 'dark'].includes(out.theme)) out.theme = 'auto';
    return out;
  }

  // 一覧のつじつまを合わせる（起動時と、バックアップから戻したとき）
  function normalizeStore() {
    // 親が消えているサブ（データ破損対策）は捨てる
    const ids = new Set(store.memos.map((m) => m.id));
    // 今ある原稿の墓標は持たない（消したあとバックアップから戻した場合など）。
    // 残っていると、別の端末に「消した」と伝わって、向こうでその原稿が消されてしまう。
    // 墓標は小さいが、無限に増えないよう新しい方から 5000 件まで
    store.deleted = (store.deleted || [])
      .filter((t) => t && typeof t.id === 'string' && Number.isFinite(t.at) && !ids.has(t.id))
      .sort((a, b) => b.at - a.at)
      .slice(0, 5000);
    store.memos = store.memos.filter((m) => !m.parentId || ids.has(m.parentId));

    if (mains().length === 0) store.memos.push(newMemo());
    if (!activeMemo()) store.activeId = mains()[0].id;
    const pinned = findMemo(store.pinnedId);
    if (!pinned || !pinned.parentId) store.pinnedId = null;
  }

  // エディタの本文は打鍵のたびには memo.body に写さない（10万字の文字列を毎回取り出すのは無駄）。
  // 「変わった」印だけ付けておき、保存・メモの切り替え・一覧の描画など、本当に要るときに1回だけ写す
  let bodyDirty = false;
  function syncBody() {
    if (!bodyDirty) return;
    const memo = activeMemo();
    if (memo) memo.body = editor.value;
    bodyDirty = false;
  }

  // 戻り値: 保存できたか。
  // localStorage は 5MB 前後でいっぱいになり、そのとき setItem は例外を投げる。
  // 黙って握りつぶすと「書いたのに次に開いたら消えていた」になるので、必ず知らせる（ただし1分に1回まで）
  //
  // 保存先が IndexedDB になったので、保存は非同期（戻り値は「保存できたか」の Promise）。
  // ただし store の中身は呼んだ瞬間に複製されるので、await しなくても「呼んだ時点の内容」が保存される。
  // 結果を待つ必要があるのは、バックアップから戻すときのように「保存できなかったら巻き戻す」場面だけ
  let lastSaveWarn = 0;
  function saveNow() {
    clearTimeout(saveTimer);
    syncBody();
    if (!storage) return Promise.resolve(false); // 起動前（読み込みが終わる前）は保存しない。空の状態で上書きしないため
    return storage.save(store).then(() => {
      if (autobackup) autobackup.changed(); // 保存できたら、自動バックアップにも「変わった」と伝える（書き出しは数分おき）
      return true;
    }, () => {
      if (Date.now() - lastSaveWarn > 60000) {
        lastSaveWarn = Date.now();
        showToast('保存できなかった（ブラウザの保存容量がいっぱい）。書き出し → バックアップを保存してね');
      }
      return false;
    });
  }

  // ページが隠れる・閉じる瞬間用。IndexedDB への保存も始めるが、終わる保証がないので
  // 同期で書ける localStorage にも控えを書く（次に開いたとき、新しい方が使われる）
  function saveOnLeave() {
    if (!storage) return;
    saveNow();
    storage.saveMirror(store);
    if (autobackup) autobackup.flush(); // 閉じる・隠すときは待たずに書き出しを始める（終わる保証はない）
  }

  // 中身のある原稿が1つもないか（新しく使い始めたとき・ブラウザのデータが消えたとき）
  function storeIsEmpty() {
    syncBody();
    return store.memos.every((m) => !m.title.trim() && !m.body.trim());
  }

  // 原稿が空っぽのときだけ、紙の下に「戻し方」の案内を出す
  const restoreHint = document.getElementById('restoreHint');
  function updateRestoreHint() {
    restoreHint.hidden = !storeIsEmpty();
  }

  // 手が止まって1秒たち、さらにブラウザが暇なとき（描画や入力処理の合間）に保存する
  const whenIdle = window.requestIdleCallback
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(fn, 0);

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => whenIdle(saveNow), SAVE_DELAY);
  }

  // ===============================================================
  // メモ一覧（右カラム下段：メインと、その下にぶら下がる資料）
  // ===============================================================

  // タイトルがあればタイトル、なければ本文の1行目、それもなければ「無題」
  function memoLabel(memo) {
    const title = memo.title.trim();
    if (title) return title;
    // 本文全体を split すると10万字ぶんの配列ができるので、先頭から1行ずつ見ていく
    const body = memo.body;
    let from = 0;
    while (from <= body.length) {
      let to = body.indexOf('\n', from);
      if (to === -1) to = body.length;
      const line = body.slice(from, to).trim();
      if (line) return line.slice(0, 20);
      from = to + 1;
    }
    return '無題';
  }

  // 一覧に出す文字数。本文が変わっていなければ前に数えた値を使う
  // （一覧は原稿を切り替えるたびに作り直すので、毎回全部を数え直すと長編が多いときに重い）
  const countCache = new Map(); // id → { body, n }
  function memoCount(memo) {
    const c = countCache.get(memo.id);
    if (c && c.body === memo.body) return c.n;
    const n = countChars(memo.body);
    countCache.set(memo.id, { body: memo.body, n });
    return n;
  }
  function updateItemCount(memo) {
    if (!memo) return;
    const text = memoCount(memo).toLocaleString();
    for (const el of document.querySelectorAll(`[data-count-for="${memo.id}"]`)) {
      if (el.textContent !== text) el.textContent = text;
    }
  }

  // 一覧の1行を作る。actions は行の右端の小さいボタン（開いて見る・削除）
  function makeItem({ memo, classes, onOpen, actions = [] }) {
    // 行を <button> にすると中にボタンを入れられない（button の入れ子は HTML 的に不正）。
    // 外側は div にして role と tabindex で補う。
    const item = document.createElement('div');
    item.className = ['memo-item', ...classes].join(' ');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    if (classes.includes('active')) item.setAttribute('aria-current', 'true');

    // 資料の行には「カード」のアイコンを付けて、本文と見分けやすくする
    if (memo.parentId) {
      const icon = document.createElement('span');
      icon.className = 'memo-icon';
      icon.setAttribute('aria-hidden', 'true');
      item.appendChild(icon);
    }

    const label = document.createElement('span');
    label.className = 'memo-label';
    label.textContent = memoLabel(memo);
    // 打鍵ごとに一覧を作り直さず、ラベルだけ差し替えられるよう目印を付ける
    label.dataset.labelFor = memo.id;
    item.appendChild(label);

    // 完成した作品の印
    if (memo.completed && !memo.parentId) {
      const badge = document.createElement('span');
      badge.className = 'memo-done';
      badge.textContent = '完成';
      badge.title = `${new Date(memo.completed.at).toLocaleDateString()} に完成`;
      item.appendChild(badge);
    }

    // 文字数（ラベルと同じく、打っている間は手が止まったときにだけ差し替える）
    const cnt = document.createElement('span');
    cnt.className = 'memo-count';
    cnt.dataset.countFor = memo.id;
    cnt.textContent = memoCount(memo).toLocaleString();
    cnt.title = '文字数（改行は数えない）';
    item.appendChild(cnt);

    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'memo-act ' + (a.className || '');
      btn.textContent = a.text;
      btn.title = a.title;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation(); // 行のクリック（＝エディタで開く）まで伝わらないように
        a.onClick();
      });
      item.appendChild(btn);
    }

    item.addEventListener('click', onOpen);
    item.addEventListener('keydown', (ev) => {
      if (ev.target === item && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        onOpen();
      }
    });
    return item;
  }

  function renderList() {
    syncBody();
    const main = activeMain();
    // 一覧を作り直すと refBody も DOM から外れるので、スクロール位置だけ覚えておく
    const scroll = memoList.scrollTop;
    memoList.textContent = '';

    for (const m of mains()) {
      const isCurrent = m.id === main.id;
      memoList.appendChild(makeItem({
        memo: m,
        classes: [
          'main',
          m.id === store.activeId ? 'active' : '',
          isCurrent && m.id !== store.activeId ? 'current-parent' : '',
        ].filter(Boolean),
        onOpen: () => openMemo(m.id),
        actions: [
          {
            className: 'done-act',
            text: '✓',
            title: m.completed ? '完成した作品（確認・完成時の版に戻す・取り消し）' : '完成にする（書き上げたら押す）',
            onClick: () => done.toggle(m.id),
          },
          { text: '×', title: 'この原稿を削除', onClick: () => deleteMemo(m.id) },
        ],
      }));

      for (const s of subsOf(m.id)) {
        const pinned = s.id === store.pinnedId;
        memoList.appendChild(makeItem({
          memo: s,
          classes: [
            'sub',
            s.id === store.activeId ? 'active' : '',
            pinned ? 'pinned' : '',
          ].filter(Boolean),
          onOpen: () => openMemo(s.id),
          actions: [
            {
              className: 'toggle',
              text: pinned ? '▾' : '▸',
              title: pinned ? '閉じる' : 'ここで開いて見る（本文を書きながら参照）',
              onClick: () => (pinned ? unpin() : pin(s.id)),
            },
            { text: '×', title: 'この資料を削除', onClick: () => deleteMemo(s.id) },
          ],
        }));

        // ピン中の資料は、その行のすぐ下に本文欄を差し込む
        if (pinned) {
          if (refBody.dataset.id !== s.id) {
            refBody.value = s.body;
            refBody.dataset.id = s.id;
          }
          memoList.appendChild(refBody);
        }
      }

      // 「＋ 資料」は今のメインの下にだけ出す（全部に出すとうるさい）
      if (isCurrent) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'memo-add-sub';
        add.textContent = '+ 資料';
        add.title = 'キャラ設定・世界観などの資料を追加';
        add.addEventListener('click', addSub);
        memoList.appendChild(add);
      }
    }

    if (!findMemo(store.pinnedId)) refBody.dataset.id = '';
    memoList.scrollTop = scroll;
  }

  // 打つたびに一覧全体を作り直すのは無駄なので、そのメモのラベルだけ差し替える
  function updateLabel(memo) {
    const next = memoLabel(memo);
    for (const el of document.querySelectorAll(`[data-label-for="${memo.id}"]`)) {
      if (el.textContent !== next) el.textContent = next;
    }
  }

  // 原稿ごとのカーソル位置とスクロール位置（このページを開いている間だけ覚える。保存はしない）。
  // 本文と資料を Esc やパンくずで行き来するたびに先頭に飛ばされると、どこを書いていたか見失う
  const viewState = new Map(); // id → { start, end, top, left }
  function rememberView() {
    if (!store.activeId) return;
    viewState.set(store.activeId, {
      start: editor.selectionStart, end: editor.selectionEnd, top: editor.scrollTop, left: editor.scrollLeft,
    });
  }

  function openMemo(id) {
    const memo = findMemo(id);
    if (!memo) return;
    syncBody(); // 切り替える前に、今のメモの本文を確定させる
    if (id !== store.activeId) rememberView();

    store.activeId = id;

    // その場で開いている資料をエディタで開いたら、そっちは閉じる。
    // 同じメモを2か所で同時に編集できると、どちらの入力が正なのか分からなくなるので。
    if (store.pinnedId === id) store.pinnedId = null;
    // 別のメインに移ったら、前のメインの資料も閉じる
    const pinned = findMemo(store.pinnedId);
    if (pinned && pinned.parentId !== activeMain().id) store.pinnedId = null;

    titleInput.value = memo.title;
    titleInput.placeholder = memo.parentId ? '資料のタイトル' : 'タイトル';

    // 資料を開いているときは、紙の色を「資料用の紙」に変え、どの作品の資料かを上に出す。
    // 視界で一番広い面積（紙）が変わるので、本文ではなく資料を書いていることが意識しなくても分かる
    const parent = memo.parentId ? findMemo(memo.parentId) : null;
    app.classList.toggle('is-sub', !!parent);
    // 完成した作品は、紙の上端に朱色の帯を出す
    app.classList.toggle('is-done', !parent && !!memo.completed);
    crumb.hidden = !parent;
    if (parent) {
      crumbParent.textContent = memoLabel(parent);
      crumbParent.dataset.id = parent.id;
    }
    // 注意: value を代入するとブラウザの Undo 履歴がリセットされる。
    // ここではそれが正解。リセットされないと、Ctrl+Z で別のメモの文章が復活してしまう。
    editor.value = memo.body;
    const view = viewState.get(id);
    if (view && view.end <= memo.body.length) {
      editor.setSelectionRange(view.start, view.end);
      editor.scrollTop = view.top;
      editor.scrollLeft = view.left;
    } else {
      editor.setSelectionRange(0, 0);
      editor.scrollTop = 0;
      editor.scrollLeft = 0;
    }
    bodyDirty = false;
    caretEngine.schedule({ text: true, center: true });
    if (find) find.refresh(); // 検索バーが開いていれば、新しいメモで探し直す
    if (images) images.show(memo); // 資料なら紙の下に画像の帯を出す（本文では隠す）
    if (links) links.refresh(); // 資料なら URL に下線を引く（本文では消す）

    target = null; // 前のメモで選んでいた置換対象は無効
    origin = null;

    renderList();
    totalCache = null;
    updateCount();
    scheduleSave();
    editor.focus({ preventScroll: true });
    // focus でスクロール位置が動くブラウザがあるので、覚えていた位置をもう一度当てる
    if (view && view.end <= memo.body.length) {
      editor.scrollTop = view.top;
      editor.scrollLeft = view.left;
    }
  }

  function addMain() {
    const memo = newMemo();
    store.memos.push(memo);
    openMemo(memo.id);
    titleInput.focus(); // 新規メモはタイトルから書き始める
  }

  function addSub() {
    const memo = newMemo('', activeMain().id);
    // 末尾に足すと別のメインの資料の後ろに並ぶことがあるので、そのメインの最後の資料の直後に入れる
    const siblings = subsOf(memo.parentId);
    const anchor = siblings.length ? siblings[siblings.length - 1] : findMemo(memo.parentId);
    store.memos.splice(store.memos.indexOf(anchor) + 1, 0, memo);
    openMemo(memo.id);
    titleInput.focus();
  }

  function deleteMemo(id) {
    syncBody();
    const memo = findMemo(id);
    if (!memo) return;

    const subs = memo.parentId ? [] : subsOf(id);
    const isEmpty = (m) => !m.title.trim() && !m.body.trim();

    // 空のメモ（資料も全部空）は確認なしで消す。中身があるときだけ確認
    if (!isEmpty(memo) || subs.some((s) => !isEmpty(s))) {
      const extra = subs.length ? `\n付いている資料${subs.length}件も一緒に削除される。` : '';
      if (!confirm(`「${memoLabel(memo)}」を削除する？${extra}`)) return;
    }

    // 消す前に、開いているメモが巻き添えになるか判定しておく
    const removeIds = new Set([id, ...subs.map((s) => s.id)]);
    const wasActive = removeIds.has(store.activeId);

    // 開き直す先：メインならとなりのメイン、資料なら親の本文
    let nextId = null;
    if (wasActive) {
      if (memo.parentId) {
        nextId = memo.parentId;
      } else {
        const list = mains();
        const i = list.findIndex((m) => m.id === id);
        const neighbor = list[i + 1] || list[i - 1];
        nextId = neighbor ? neighbor.id : null;
      }
    }

    store.memos = store.memos.filter((m) => !removeIds.has(m.id));
    if (removeIds.has(store.pinnedId)) store.pinnedId = null;
    // 消した印を残す（資料も一緒に）。別の端末で「新しい方で更新」したとき、向こうでも消せるように
    const at = Date.now();
    store.deleted = [...[...removeIds].map((id) => ({ id, at })), ...(store.deleted || [])];
    // 消した資料に貼ってあった画像も消す（残すと、もう見えないのに容量だけ食い続ける）
    storage.deleteImagesOf([...removeIds]).catch(() => {});

    if (mains().length === 0) {
      const fresh = newMemo();
      store.memos.push(fresh);
      nextId = fresh.id;
    }

    if (nextId) {
      openMemo(nextId);
    } else {
      renderList();
      scheduleSave();
    }
  }

  // ===============================================================
  // 資料をその場で開く（本文を書きながら設定を見る）
  // ===============================================================

  function pin(id) {
    const memo = findMemo(id);
    if (!memo || !memo.parentId) return;

    store.pinnedId = id;
    app.classList.remove('panel-hidden');

    if (store.activeId === id) {
      // エディタで開いている資料を「その場で開く」にしたら、エディタは本文に戻す
      openMemo(memo.parentId);
    } else if (memo.parentId !== activeMain().id) {
      // 別の作品の資料を開いたら、エディタもその作品の本文に移る
      openMemo(memo.parentId);
      store.pinnedId = id; // openMemo が「別のメイン」と判定して外すので付け直す
      renderList();
    } else {
      renderList();
      scheduleSave();
    }
  }

  function unpin() {
    store.pinnedId = null;
    renderList();
    scheduleSave();
    editor.focus();
  }

  // ===============================================================
  // 文字数
  // ===============================================================

  // 「👨‍👩‍👧」みたいな絵文字は length だと 8 とかになるので、見た目の1文字単位で数える
  const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('ja', { granularity: 'grapheme' })
    : null;

  // 結合文字・異体字セレクタ・絵文字（サロゲートペア）を含むときだけ、重い Segmenter で数える。
  // 普通の日本語だけなら length から改行の数を引くだけで正しい（10万字でも一瞬）
  const NEEDS_SEGMENTER = /[\uD800-\uDFFF\u200D\uFE0E\uFE0F\u0300-\u036F\u3099\u309A]/;

  function countChars(text) {
    let newlines = 0;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) newlines++;
    if (!NEEDS_SEGMENTER.test(text)) return text.length - newlines; // 改行は数えない。全角スペースは数える
    const t = text.replace(/\r?\n/g, '');
    if (!graphemes) return [...t].length;
    let n = 0;
    for (const _ of graphemes.segment(t)) n++;
    return n;
  }

  // 全体の文字数は本文が変わったときだけ数え直す（選択が変わっただけなら使い回す）
  let totalCache = null;

  function updateCount() {
    if (totalCache === null) totalCache = countChars(editor.value);
    const total = totalCache.toLocaleString();
    const { selectionStart: s, selectionEnd: e } = editor;
    if (s !== e && document.activeElement === editor) {
      const selected = countChars(editor.value.slice(s, e)).toLocaleString();
      count.textContent = `${selected} / ${total}字`;
    } else {
      count.textContent = `${total}字`;
    }
  }

  // 打鍵ごとには何もせず、手が IDLE_DELAY 止まったら文字数とメモ一覧のラベルをまとめて更新する。
  // 打っている最中に数字やラベルがチラチラ変わらないので、目にもうるさくない
  let idleTimer = 0;
  function scheduleIdleWork() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      syncBody();
      updateLabel(activeMemo());
      updateItemCount(activeMemo());
      updateCount();
    }, IDLE_DELAY);
  }

  // ===============================================================
  // 表示設定（フォント・縦書き・タイプライター）
  // ===============================================================

  // --- 表示の明るさ（自動 / ライト / ダーク） ---
  const THEMES = {
    auto: { mark: '◐', label: '自動（OS に合わせる）' },
    light: { mark: '☀\uFE0E', label: 'ライト' },   // \uFE0E … 絵文字ではなく文字として描かせる（色付きの太陽にならないように）
    dark: { mark: '☾', label: 'ダーク' },
  };
  const THEME_ORDER = ['auto', 'light', 'dark'];
  const themeBtn = document.getElementById('themeBtn');
  const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')];
  const themeMetaDefaults = themeMetas.map((m) => m.content);

  function applyTheme() {
    const t = store.settings.theme || 'auto';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    // 次に開いたとき、画面を描く前に当てられるよう localStorage にも控える（index.html の頭のスクリプトが読む）
    try { localStorage.setItem('tako:theme', t); } catch (_) { /* 何もしない */ }
    // アプリとして開いたときのタイトルバーの色。自動なら OS に合わせた2つの値に戻す
    themeMetas.forEach((m, i) => {
      m.content = t === 'auto' ? themeMetaDefaults[i] : t === 'dark' ? '#161614' : '#f1efea';
    });
    themeBtn.textContent = THEMES[t].mark;
    themeBtn.title = `表示：${THEMES[t].label}（押すと切り替え）`;
    themeBtn.setAttribute('aria-label', `表示の明るさ：${THEMES[t].label}`);
  }

  function applySettings() {
    applyTheme();
    const { font, vertical, typewriter, fontSize } = store.settings;
    // 文字サイズは CSS 変数で渡す。1行の幅（--column）もこの変数から計算されるので、一緒に伸び縮みする
    app.style.setProperty('--text-size', fontSize + 'px');
    sizeLabel.textContent = fontSize;
    sizeDown.disabled = fontSize <= FONT_SIZES[0];
    sizeUp.disabled = fontSize >= FONT_SIZES[FONT_SIZES.length - 1];
    app.classList.toggle('font-serif', font === 'serif');
    app.classList.toggle('vertical', vertical);
    app.classList.toggle('typewriter', typewriter);
    // 2択を両方並べて、今選ばれている方に印を付ける（aria-checked が CSS の見た目も兼ねる）
    for (const btn of settingButtons) {
      const on = String(store.settings[btn.dataset.setting]) === btn.dataset.value;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1; // Tab で来たときは選ばれている方にフォーカス（ラジオボタンの作法）
    }
    // フォント・書字方向・余白が変わるとカーソルの位置の計算が全部変わるので、測り直す
    // （setTypewriter の中で余白を入れ直してから layout する）
    caretEngine.setTypewriter(typewriter);
  }

  // 文字サイズを1段階ずつ変える。保存値がリストにない数（手で書き換えた等）でも、近い段から動かす
  function stepFontSize(dir) {
    const cur = store.settings.fontSize;
    const next = dir > 0
      ? FONT_SIZES.find((s) => s > cur)
      : [...FONT_SIZES].reverse().find((s) => s < cur);
    if (next === undefined) return;
    store.settings.fontSize = next;
    applySettings();
    scheduleSave();
  }

  function resetFontSize() {
    store.settings.fontSize = DEFAULT_FONT_SIZE;
    applySettings();
    scheduleSave();
  }

  // data-value は文字列なので、真偽値の設定は 'true' / 'false' を戻してから入れる
  function setSetting(key, raw) {
    const value = raw === 'true' ? true : raw === 'false' ? false : raw;
    if (store.settings[key] === value) return; // 選ばれている方を押しても何もしない
    store.settings[key] = value;
    applySettings();
    scheduleSave();
  }

  // ===============================================================
  // 辞書インデックス
  // ===============================================================

  // い形容詞の語幹 → 見出し語。「暑かった」の「暑」から「暑い」を引くため。
  // 「〜い」で終わる語を全部形容詞扱いすると「思い」「違い」まで語幹にされるので、
  // 辞書側で形容詞と分かっている語だけを使う。
  const stemIndex = new Map();
  for (const adj of ADJECTIVES) {
    stemIndex.set(adj.slice(0, -1), adj);
  }
  const ADJ_SET = new Set(ADJECTIVES);

  // 一番長い見出し語の長さ（選択範囲から語を探すループの上限）。
  // Math.max(...keys) は9万個の引数を一度に渡すことになり、ブラウザによっては
  // 「引数が多すぎる」で落ちるので、普通にループで数える。12字で打ち止め。
  let maxKeyLength = 1;
  for (const key in INDEX) {
    if (key.length > maxKeyLength) maxKeyLength = Math.min(key.length, 12);
  }

  // 動詞（活用のルールは verb.js）。辞書の verbs はよく使う順に並んでいるので、その順位も持っておく
  const Verb = window.KotobaVerb;
  const VERB_RANK = new Map((DICT.verbs || []).map((v, i) => [v, i]));
  const isVerb = (v) => VERB_RANK.has(v);
  const verbRank = (v) => (VERB_RANK.has(v) ? VERB_RANK.get(v) : Infinity);

  // ===============================================================
  // 類語パネルの状態
  // ===============================================================

  // パネルに表示する内容の唯一の出どころは query。
  // 選択・自動検出は「検索ボックスに勝手に入力してくれる機能」として扱う。
  let query = '';

  // 候補を押したときに置き換える本文中の範囲。
  //   mode: 'exact' = その語をまるごと置換
  //         'stem'  = 形容詞の語幹だけ置換（暑|かった → 蒸し暑|かった）
  //         'verb'  = 動詞を同じ活用形にして置換（佇んで → 立ち止まって）
  //   form / next : 動詞の活用形と、置換範囲の直後の文字（verb.js の conjugate に渡す）
  //   word        : 今その範囲に入っている語の辞書形（パネルで「今これが入っている」を示す）
  let target = null; // { start, end, text, mode, form, next, word }

  // 選択した瞬間の語。何度差し替えても、これを押せば元に戻せる
  let origin = null; // { key, text }

  let isComposing = false;
  let detectTimer = null;

  // ===============================================================
  // 選択範囲から語を引く
  // ===============================================================

  // 選択した文字列を辞書の見出し語に寄せる。上から順に試す。
  //   「今日」       → 今日（そのまま）
  //   「暑かった」   → 暑い（形容詞の語幹＋活用。置換は語幹「暑」だけ）
  //   「佇んでいた」 → 佇む（動詞の活用。置換は「佇んで」まで）
  //   「今日は」     → 今日（先頭から辞書にある一番長い語）
  function lookupSelection(text, start, end) {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const word = raw.trim();
    if (!word) return null;

    const s = start + lead;
    const e = s + word.length;
    const nextOf = (pos) => text.slice(pos, pos + 3);

    // 動詞として読めるか（「佇ん」だけ選んでも「佇んで」まで見たいので、選択より1字先まで探す）
    const verbHit = Verb && Verb.deinflect(text, s, word.length + 1, isVerb, verbRank)
      .find((h) => hasWord(h.verb));
    const asVerb = () => ({
      start: s, end: verbHit.end, text: text.slice(s, verbHit.end), key: verbHit.verb,
      mode: 'verb', form: verbHit.form, next: nextOf(verbHit.end),
    });

    if (hasWord(word)) {
      // 「眺め」は名詞としても辞書にあるが、本文が「眺めて」「眺めます」なら動詞として扱いたい。
      // 選択の直後が活用の続き（て・た・ます 等）のときだけ動詞を優先する
      const verbContinues = verbHit && (verbHit.end > e ||
        /^(ま[すせし]|たい|たく|たかっ|ながら|ない|なかっ|なく)/.test(nextOf(verbHit.end)));
      if (verbContinues) return asVerb();
      return { start: s, end: e, text: word, key: word, mode: 'exact' };
    }

    // 形容詞：選択の先頭から語幹を探す。長い語幹を優先。
    for (let len = Math.min(word.length, maxKeyLength); len >= 1; len--) {
      const stem = word.slice(0, len);
      if (!stemIndex.has(stem)) continue;

      const next = text[s + len] || '';
      if (ADJ_TAIL.includes(next)) {
        return { start: s, end: s + len, text: stem, key: stemIndex.get(stem), mode: 'stem' };
      }
    }

    // 動詞の活用形
    if (verbHit) return asVerb();

    // ダブルクリックだと「今日は」のように助詞まで選ばれがち。
    // 先頭から辞書に載っている一番長い語を探して、そこだけを置換対象にする（2字以上に限る）
    for (let len = Math.min(word.length - 1, maxKeyLength); len >= 2; len--) {
      const head = word.slice(0, len);
      if (hasWord(head)) {
        return { start: s, end: s + len, text: head, key: head, mode: 'exact' };
      }
    }

    return { start: s, end: e, text: word, key: word, mode: 'exact', notFound: true };
  }

  // カーソルを含む部分文字列のうち、辞書に載っている最長のものを探す（自動検出用）。
  // Intl.Segmenter だと「暑かった」が「暑|か|っ|た」に割れるので、辞書側から当てに行く。
  function findWordAt(text, caret) {
    let best = null;
    const from = Math.max(0, caret - maxKeyLength);

    for (let start = from; start <= caret; start++) {
      const limit = Math.min(text.length, start + maxKeyLength);
      for (let end = Math.max(caret, start + 1); end <= limit; end++) {
        const s = text.slice(start, end);
        let hit = null;

        if (hasWord(s)) {
          hit = { start, end, text: s, key: s, mode: 'exact' };
        } else if (stemIndex.has(s) && ADJ_TAIL.includes(text[end] || '')) {
          hit = { start, end, text: s, key: stemIndex.get(s), mode: 'stem' };
        }

        if (hit && (!best || hit.text.length > best.text.length ||
            (hit.text.length === best.text.length && hit.mode === 'exact'))) {
          best = hit;
        }
      }
    }
    return best;
  }

  // 選択（or 自動検出）で語が見つかった：置換対象と「元の語」を記録してパネルを更新
  function startTarget(hit) {
    target = { ...hit, word: hit.key };
    origin = { key: hit.key, text: hit.text };
    setQuery(hit.key);
  }

  function detect() {
    if (isComposing) return;
    // 予約してから実行されるまでの間に検索ボックスへ移っていたら何もしない。
    // textarea は フォーカスを失っても選択範囲を覚えているので、これがないと
    // 手で打った検索語が本文の選択範囲の語で上書きされる
    if (document.activeElement !== editor) return;
    const { selectionStart: s, selectionEnd: e, value } = editor;

    if (s !== e) {
      // 置換直後に自分で選択し直した範囲には反応しない
      // （反応すると、パネルが「本日」の類語に切り替わって元の候補が消える）
      if (target && target.start === s && target.end === e && targetIsValid()) return;

      const hit = lookupSelection(value, s, e);
      if (!hit) return;

      if (hit.notFound) {
        target = null;
        origin = null;
        setQuery(hit.key);
      } else {
        startTarget(hit);
      }
      return;
    }

    if (!CARET_DETECT) return;

    const hit = findWordAt(value, s);
    if (!hit) return; // 見つからなければパネルは前の状態のまま（チカチカ防止）
    startTarget(hit);
  }

  function scheduleDetect(delay) {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(detect, delay);
  }

  // ===============================================================
  // パネル描画
  // ===============================================================

  function setQuery(q) {
    query = q;
    if (search.value !== q) search.value = q;
    render();
  }

  // 置換モードに応じて、候補の辞書形 → 本文に入れる文字列 を作る。入れられない候補は null
  function surfaceFor(word, t) {
    if (!t) return word;
    if (t.mode === 'stem') {
      // 形容詞の類語グループに「〜い」で終わる名詞（思い・違い等）が混ざることはまずないので、
      // 辞書の形容詞リストにない複合語（生暑い 等）は「い」で終わるかどうかで拾う
      return ADJ_SET.has(word) || word.endsWith('い') ? word.slice(0, -1) : null;
    }
    if (t.mode === 'verb') {
      // 動詞を名詞（散策）に置き換えると文が壊れるので、活用できる動詞だけ
      return isVerb(word) || word.endsWith('する') ? Verb.conjugate(word, t.form, t.next) : null;
    }
    return word;
  }

  function makeCandidate(label, onPick, { className = '', title = '' } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'candidate ' + className;
    btn.textContent = label;
    if (title) btn.title = title;
    // click だと押した瞬間に本文のフォーカスと選択が外れるので pointerdown で拾う
    btn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      onPick();
    });
    // キーボード(Tab→Enter/Space)操作用
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onPick();
      }
    });
    return btn;
  }

  function render() {
    results.textContent = '';
    const q = query.trim();
    if (!q) return;

    const live = targetIsValid() ? target : null;

    // --- 元の語（選んだときの語）。押すと元に戻る ---
    if (live && origin && origin.key === q) {
      const row = document.createElement('div');
      row.className = 'group origin-row';
      const isCurrent = live.text === origin.text;
      row.appendChild(makeCandidate(origin.key, restoreOrigin, {
        className: 'origin' + (isCurrent ? ' current' : ''),
        title: isCurrent ? '選んだときの語（今これが入っている）' : `元に戻す（${origin.text}）`,
      }));
      results.appendChild(row);
    }

    const groups = synonymsOf(q);
    let shown = 0;

    for (const words of groups || []) {
      const group = document.createElement('div');
      group.className = 'group';
      for (const word of words) {
        const surface = surfaceFor(word, live);
        if (surface === null) continue;
        const isCurrent = live && live.word === word;
        group.appendChild(makeCandidate(word, () => applyCandidate(word), {
          className: isCurrent ? 'current' : '',
          // 活用させて入れるときは、実際に入る形をツールチップで見せる
          title: surface !== word ? `→ ${surface}` : '',
        }));
      }
      if (group.childElementCount) {
        results.appendChild(group);
        shown++;
      }
    }

    if (!shown) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = groups ? 'この形に活用できる候補がない' : '見つからなかった';
      results.appendChild(p);
    }
  }

  // ===============================================================
  // 置換
  // ===============================================================

  // 記録してある範囲が、今も同じ文字列のままか（他の場所を編集してズレていないか）
  function targetIsValid() {
    return !!target && editor.value.slice(target.start, target.end) === target.text;
  }

  function applyCandidate(word) {
    if (targetIsValid()) {
      // 1. 選択（or 自動検出）で決まった置換対象があれば、そこを同じ形で差し替える
      const insert = surfaceFor(word, target);
      if (insert === null) return;
      replaceTarget(insert, word);
      return;
    }

    // 2. 手動検索中でも、本文に選択範囲があればそこ / 3. なければカーソル位置に挿入
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    replaceRange(start, end, word);
    target = { start, end: start + word.length, text: word, mode: 'exact', word };
    editor.setSelectionRange(start, start + word.length);
    updateCount();
  }

  // 元の語に戻す（活用形も選んだときの文字列そのものに戻す）
  function restoreOrigin() {
    if (!origin || !targetIsValid()) return;
    replaceTarget(origin.text, origin.key);
  }

  function replaceTarget(insert, word) {
    const { start, end } = target;
    replaceRange(start, end, insert);

    // 置換後の語を選択状態にして、次の置換対象にする。
    // 選択が見えているので「今どこが変わったか」が分かり、続けて別の候補も試せる。
    // 活用形（form/next）は置換範囲の外側が変わらないので、そのまま引き継げる。
    const newEnd = start + insert.length;
    target = { ...target, end: newEnd, text: insert, word };
    editor.setSelectionRange(start, newEnd);
    updateCount();
    // パネルは元の語の候補のまま。「今これが入っている」の印だけ付け直す
    render();
  }

  function replaceRange(start, end, text) {
    editor.focus();
    editor.setSelectionRange(start, end);
    // execCommand はブラウザの Undo 履歴に乗る。Ctrl+Z で戻せる。
    // 非推奨扱いだが、textarea で Undo を保ったまま挿入する現実的な手段がこれ。
    // （input イベントも発火するので、メモへの反映と保存はそちらで行われる）
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      // 念のためのフォールバック（こちらは Undo 履歴に乗らない）
      editor.setRangeText(text, start, end, 'end');
      editor.dispatchEvent(new Event('input'));
    }
  }

  // ===============================================================
  // イベント
  // ===============================================================

  // --- 本文 ---

  editor.addEventListener('compositionstart', () => {
    isComposing = true;
    clearTimeout(detectTimer);
  });
  editor.addEventListener('compositionend', () => {
    isComposing = false;
    // 変換中は下の input で重い処理を止めていたので、確定したここでまとめてやる
    scheduleIdleWork();
    scheduleSave();
    if (CARET_DETECT) scheduleDetect(CARET_DELAY);
  });

  // 打鍵ごとの処理は「変わった」印を付けるだけ。ここが重いとそのまま入力遅延になる
  editor.addEventListener('input', () => {
    bodyDirty = true;
    totalCache = null;
    if (!restoreHint.hidden) restoreHint.hidden = true; // 書き始めたら「戻し方」の案内は引っ込める
    activeMemo().updatedAt = Date.now();
    // 日本語の変換中は1文字ごとに input が飛んでくるので、確定するまで何もしない
    if (isComposing) return;
    scheduleIdleWork();
    scheduleSave();
    if (CARET_DETECT) scheduleDetect(CARET_DELAY);
  });

  // マウスで選び終わった瞬間（ドラッグ・ダブルクリック）は待たずに即反応
  editor.addEventListener('mouseup', () => {
    updateCount();
    scheduleDetect(0);
  });

  editor.addEventListener('keyup', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    // 選択範囲の文字数だけ更新（全体の文字数はキャッシュを使うので軽い）。
    // ただし打鍵中は全体の数え直しを待たせたいので、本文が変わった直後は手が止まるまで待つ
    if (totalCache !== null) updateCount();
    if (e.shiftKey || e.key === 'Shift') {
      // Shift+矢印 / Shift+Home などで選択を伸ばしている
      scheduleDetect(SELECT_DELAY);
    } else if (CARET_DETECT) {
      scheduleDetect(CARET_DELAY);
    }
  });

  // Cmd/Ctrl+A などキーボードでの全選択系は keyup の shiftKey で拾えないので念のため
  editor.addEventListener('select', () => {
    updateCount();
    scheduleDetect(SELECT_DELAY);
  });

  editor.addEventListener('blur', updateCount);

  // --- タイトル ---

  titleInput.addEventListener('input', () => {
    if (!restoreHint.hidden) restoreHint.hidden = true;
    const memo = activeMemo();
    memo.title = titleInput.value;
    memo.updatedAt = Date.now();
    updateLabel(memo);
    scheduleSave();
  });

  // タイトルで Enter → 本文へ（変換確定の Enter は無視）
  titleInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      editor.focus();
    }
  });

  // --- その場で開いた資料 ---

  // 一覧の中でも書き足せる（本文を書きながら思いついた設定をメモする用）
  let refCountTimer = 0;
  refBody.addEventListener('input', () => {
    const memo = findMemo(store.pinnedId);
    if (!memo) return;
    memo.body = refBody.value;
    memo.updatedAt = Date.now();
    updateLabel(memo);
    clearTimeout(refCountTimer);
    refCountTimer = setTimeout(() => updateItemCount(memo), IDLE_DELAY);
    scheduleSave();
  });

  // --- メモ一覧 ---

  addMainBtn.addEventListener('click', addMain);
  crumbParent.addEventListener('click', () => openMemo(crumbParent.dataset.id));

  // --- ステータスのボタン ---

  // 候補ボタンと同じ理由で、押した瞬間に本文のフォーカスと選択を奪わないようにする。
  // pointerdown で preventDefault してもその後の click は発火するので、処理は click に書ける。
  for (const btn of settingButtons) {
    btn.addEventListener('pointerdown', (ev) => ev.preventDefault());
    btn.addEventListener('click', () => setSetting(btn.dataset.setting, btn.dataset.value));
  }
  for (const btn of [sizeDown, sizeUp, sizeLabel]) {
    btn.addEventListener('pointerdown', (ev) => ev.preventDefault());
  }
  themeBtn.addEventListener('pointerdown', (ev) => ev.preventDefault()); // 押しても本文のフォーカスを奪わない
  themeBtn.addEventListener('click', () => {
    const cur = store.settings.theme || 'auto';
    store.settings.theme = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    applyTheme();
    scheduleSave();
    showToast(`表示：${THEMES[store.settings.theme].label}`);
  });
  sizeDown.addEventListener('click', () => stepFontSize(-1));
  sizeUp.addEventListener('click', () => stepFontSize(1));
  sizeLabel.addEventListener('click', resetFontSize);

  // --- 検索 ---

  search.addEventListener('input', () => {
    if (search.isComposing) return;
    target = null; // 手動検索に切り替えたら選択由来の置換対象は破棄
    origin = null;
    query = search.value;
    render();
  });
  search.addEventListener('compositionend', () => {
    query = search.value;
    render();
  });

  // --- ショートカット ---

  // JISキーボード対策。Macの日本語配列だと「¥」キーは e.key が '¥' になり、'\\' と比較しても一致しない。
  // e.code（物理キーの位置）も見て、US配列の \ / JISの ¥ / JISの ろ のどれでも反応させる。
  function isBackslashKey(e) {
    return e.key === '\\' || e.key === '¥' ||
      e.code === 'Backslash' || e.code === 'IntlYen' || e.code === 'IntlRo';
  }

  document.addEventListener('keydown', (e) => {
    // IME 変換中のキーは一切拾わない（変換確定の Enter 誤爆を防ぐ）
    if (e.isComposing || e.keyCode === 229) return;
    // ダイアログ（書き出しなど）が開いている間は、アプリのショートカットは全部お休み。
    // でないと「Esc で本文に戻る」がダイアログの Esc を横取りして、ダイアログが閉じなくなる
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;

    // --- 検索・置換 ---
    // Ctrl+F / ⌘F：検索。Ctrl+H / ⌘⌥F：置換。
    // Mac の Ctrl+H は textarea で「1文字削除」（emacs 風の操作）なので、Mac では奪わない
    // 文字キーは配列で e.key が変わることがあるので、物理キーの e.code で判定する
    const isFind = mod && !e.altKey && !e.shiftKey && e.code === 'KeyF';
    const isReplace = IS_MAC ? (e.metaKey && e.altKey && e.code === 'KeyF') : (e.ctrlKey && e.code === 'KeyH');
    if (isFind || isReplace) {
      e.preventDefault();
      find.open({ replace: isReplace });
      return;
    }
    if (find.isOpen() && ((mod && e.code === 'KeyG') || e.key === 'F3')) {
      e.preventDefault();
      if (e.shiftKey) find.prev(); else find.next();
      return;
    }
    if (find.isOpen() && e.key === 'Escape' && document.activeElement === editor) {
      e.preventDefault();
      find.close();
      return;
    }

    // --- ⌘S / Ctrl+S ---
    // 物書きは癖で押すが、そのままだとブラウザの「ページを保存」が開く。自動保存しているので、そう伝えるだけにする
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      saveNow();
      showToast('自動で保存されてるよ。ファイルにするなら右下の「書き出し」から');
      return;
    }

    // --- 文字サイズ：Ctrl/⌘ と ＋ − 0 ---
    // ブラウザの拡大縮小と同じキーだが、このアプリでは本文の文字サイズを変える方が役に立つので横取りする。
    // JIS 配列の「＋」は Shift+; なので e.key で '+' ';' '=' のどれでも受ける（テンキーも）
    if (mod && !e.altKey) {
      if (['+', '=', ';'].includes(e.key) || e.code === 'NumpadAdd') { e.preventDefault(); stepFontSize(1); return; }
      if (e.key === '-' || e.code === 'NumpadSubtract') { e.preventDefault(); stepFontSize(-1); return; }
      if (e.key === '0' || e.code === 'Numpad0') { e.preventDefault(); resetFontSize(); return; }
    }

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      app.classList.remove('panel-hidden');
      search.focus();
      search.select();
    } else if (mod && isBackslashKey(e)) {
      e.preventDefault();
      app.classList.toggle('panel-hidden');
      editor.focus();
    } else if (e.key === 'Escape' && document.activeElement !== editor) {
      // 検索ボックスや一覧にいるとき：入力欄に戻る
      e.preventDefault();
      editor.focus();
    } else if (e.key === 'Escape' && activeMemo().parentId) {
      // 資料を書いているとき：その作品の本文に戻る（パンくずの作品名を押すのと同じ）
      e.preventDefault();
      openMemo(activeMemo().parentId);
    } else if (e.key === 'ArrowDown' && document.activeElement === search) {
      // 検索ボックスから↓で最初の候補へ
      const first = results.querySelector('.candidate');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // --- 保存の取りこぼし防止 ---

  // デバウンス中（最後の入力から500ms以内）にタブを閉じると、最後の数文字が消える。
  // ページが隠れる・閉じる瞬間に即保存する。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveOnLeave();
  });
  window.addEventListener('pagehide', saveOnLeave);

  // ===============================================================
  // 起動
  // ===============================================================

  // 保存先を開いて読み込むまでは非同期。その間に打たれた文字が、読み込んだ原稿で上書きされて消えないよう、
  // 読み込みが終わるまで入力欄を読み取り専用にしておく（普通は一瞬で終わる）
  editor.readOnly = true;
  titleInput.readOnly = true;
  storage = await window.KotobaStorage.create();
  const loaded = await storage.load();
  loadStore(loaded.data); // 何もなければ、1枚メモ時代のデータ（さらに古い形式）を探して引き継ぐ
  editor.readOnly = false;
  titleInput.readOnly = false;

  find = window.KotobaFind.create({
    editor,
    layer: editor.parentElement,
    caret: caretEngine,
    replaceRange,
    lex: { isVerb, isAdjective: (w) => ADJ_SET.has(w), Verb },
    options: store.settings.find,
    onOptionsChange: scheduleSave,
  });
  links = window.KotobaLinks.create({
    editor,
    layer: editor.parentElement,
    caret: caretEngine,
    // リンクにするのは資料だけ。本文に下線が出ると、書いている最中に目に入る
    isActive: () => { const m = activeMemo(); return !!(m && m.parentId); },
    isMac: IS_MAC,
  });
  exporter = window.KotobaExport.create({
    // 書き出すのは「今開いている作品」。資料を開いているときに押しても、親の作品が丸ごと対象
    getParts: (withRefs) => {
      syncBody(); // 打ったばかりの文字も含める
      const main = activeMain();
      const parts = [{ kind: 'main', id: main.id, title: main.title.trim(), body: main.body }];
      if (withRefs) {
        for (const s of subsOf(main.id)) parts.push({ kind: 'ref', id: s.id, title: memoLabel(s), body: s.body });
      }
      return parts;
    },
    getStyle: () => ({ serif: store.settings.font === 'serif', vertical: store.settings.vertical }),
    options: store.settings.export,
    onOptionsChange: scheduleSave,
    getImages: (memoId) => storage.imagesOf(memoId),
  });
  document.getElementById('exportBtn').addEventListener('click', () => exporter.open());

  images = window.KotobaImages.create({
    storage,
    getMemo: activeMemo,
    makeId,
    notify: showToast,
    onChange: () => { if (autobackup) autobackup.changed(); },
  });
  editor.addEventListener('paste', (e) => images.handlePaste(e));

  // バックアップから戻す。保存に失敗したら（容量オーバー）、戻す前の状態に巻き戻す。
  // 画面だけ新しくなって保存されていない、が一番たちが悪い（次に開いたとき何が残っているか分からない）
  //
  // 注意: store や store.settings のオブジェクトを丸ごと差し替えないこと。
  // find.js は store.settings.find を、export.js は store.settings.export を「参照で」握っているので、
  // 差し替えると、そっちでの設定変更が古いオブジェクトに書かれて保存されなくなる。中身だけ書き換える
  const DISPLAY_KEYS = ['font', 'vertical', 'fontSize']; // バックアップから戻す設定は見た目のものだけ

  function snapshot() {
    return {
      memos: store.memos,
      activeId: store.activeId,
      pinnedId: store.pinnedId,
      deleted: store.deleted,
      display: Object.fromEntries(DISPLAY_KEYS.map((k) => [k, store.settings[k]])),
    };
  }
  function restoreSnapshot(snap) {
    store.memos = snap.memos;
    store.activeId = snap.activeId;
    store.pinnedId = snap.pinnedId;
    store.deleted = snap.deleted;
    Object.assign(store.settings, snap.display);
  }

  async function commitOrRollback(change) {
    syncBody();
    const before = snapshot(); // memos は配列ごと差し替えるので、元の配列をそのまま取っておけば戻せる
    change();
    normalizeStore();
    const ok = await saveNow();
    if (!ok) {
      restoreSnapshot(before);
      normalizeStore();
    }
    applySettings();
    openMemo(store.activeId);
    updateRestoreHint(); // 戻したら案内は消える
    return ok;
  }

  const backupUi = window.KotobaBackup.create({
    getStore: () => { syncBody(); return store; },
    // 自動バックアップが動いていれば、その時刻も「前回のバックアップ」として数える（オンなのに「まだ一度も」と出ると不安になるので）
    getLastBackupAt: () => Math.max(store.lastBackupAt || 0, autobackup ? autobackup.info().lastAt || 0 : 0),
    onBackedUp: (t) => { store.lastBackupAt = t; saveNow(); },
    replaceWith: (data) => commitOrRollback(() => {
      store.memos = data.memos;
      store.activeId = data.activeId;
      store.pinnedId = data.pinnedId;
      store.deleted = data.deleted || [];
      if (data.settings) {
        const merged = mergeSettings(store.settings, data.settings);
        for (const k of DISPLAY_KEYS) store.settings[k] = merged[k];
      }
    }),
    mergeWith: (result) => commitOrRollback(() => {
      store.memos = result.memos;
      if (result.deleted) store.deleted = result.deleted;
      // 取り込んだら、こちらに残っている空っぽの原稿（新しい端末で最初にできる「無題」）は片付ける。
      // 全部が空っぽなら1つは残す（原稿が0件にはしない）
      const isEmpty = (m) => !m.parentId && !m.title.trim() && !m.body.trim() && !store.memos.some((x) => x.parentId === m.id);
      if (store.memos.some((m) => !m.parentId && !isEmpty(m))) store.memos = store.memos.filter((m) => !isEmpty(m));
      if (result.firstAddedMainId) store.activeId = result.firstAddedMainId; // 足したものが見えるように
    }),
    makeId,
    notify: showToast,
    storage,
    onImagesChanged: () => images.refresh(),
    onDropFiles: (files) => images.addFiles(files),
    onDropWeb: (dt) => images.addFromDrop(dt),
    // 前回選んだ戻し方（追加 / 新しい方で更新）。引き継ぎで毎回使う人が、毎回選び直さなくていいように
    // 手動のバックアップも、自動バックアップのフォルダがあればそこへ（置き場所を1か所にまとめる）
    folder: {
      name: () => (autobackup ? autobackup.folderName() : ''),
      ensure: () => autobackup.ensureFolder(),
      write: (name, blob) => autobackup.saveToFolder(name, blob),
    },
    getMode: () => store.settings.restoreMode,
    setMode: (m) => { store.settings.restoreMode = m; scheduleSave(); },
  });
  // --- 自動バックアップ ---
  const autoEls = {
    status: document.getElementById('autoStatus'),
    note: document.getElementById('autoNote'),
    setup: document.getElementById('autoSetup'),
    stop: document.getElementById('autoStop'),
    paused: document.getElementById('autoPaused'),
  };
  function renderAuto({ status, folder, lastAt, errorText, supported }) {
    const ago = lastAt ? window.KotobaBackup.ago(lastAt) : '';
    const text = {
      unsupported: 'このブラウザでは使えない',
      off: 'オフ',
      active: `オン（${folder}）`,
      paused: '停止中',
      error: '止まっている',
    }[status];
    autoEls.status.textContent = text;
    autoEls.status.className = 'auto-status' + (status === 'active' ? ' on' : status === 'paused' || status === 'error' ? ' warn' : '');
    autoEls.note.textContent = {
      unsupported: 'パソコンの Chrome / Edge で使える。このブラウザでは、ときどき上の「バックアップを保存」を押してね。',
      // デスクトップ・ホームなど「大事な場所そのもの」は Chrome が選ばせてくれない（「このフォルダを開けません」）。
      // 中に作ったフォルダなら選べるので、選ぶ前に一言そう伝える
      off: '選んだフォルダに、書いている途中で自動的にバックアップを書き出す。ブラウザのデータが消えても、そのファイルをドロップすれば戻せる。オンにしておくのがおすすめ。フォルダを選ぶときは、デスクトップや「書類」そのものではなく、その中に「タコエディタのバックアップ」などのフォルダを作って選んでね（選ぶ画面の「新規フォルダ」で作れる）。',
      // フォルダの場所（パス）はブラウザが教えてくれない（ユーザー名やフォルダ構成が分かってしまうため）。名前で探してもらう
      active: `数分おきに「${folder}」に書き出している（1日ごとの控えも14日分）。上の「バックアップを保存」も同じフォルダに入る。${ago ? `最後の書き出し：${ago}。` : ''}フォルダの場所（パス）はブラウザの仕組みで表示できないので、見失ったらフォルダ名で検索してね。`,
      paused: `「${folder}」への書き込みの許可が切れている（ブラウザを開き直すと切れることがある）。「再開する」を押して許可してね。`,
      error: `${errorText}。フォルダを選び直してね。`,
    }[status];
    autoEls.setup.hidden = status === 'unsupported';
    autoEls.setup.textContent = status === 'paused' ? '再開する' : status === 'active' || status === 'error' ? 'フォルダを変える' : 'フォルダを選んで始める';
    autoEls.stop.hidden = !(status === 'active' || status === 'paused' || status === 'error');
    // 右下の「停止中」は、許可切れ・エラーのときだけ（普段は何も出さない）
    autoEls.paused.hidden = !(status === 'paused' || status === 'error');
    autoEls.paused.textContent = status === 'error' ? '自動バックアップが止まっている' : '自動バックアップ停止中';
    document.getElementById('restoreFromFolder').hidden = !supported;
    if (backupUi) backupUi.refresh(); // 手動バックアップの「保存先」の表示も合わせる
  }

  autobackup = window.KotobaAutoBackup.create({
    storage,
    makeBlob: backupUi.makeBlob,
    isEmpty: storeIsEmpty,
    notify: showToast,
    onStatus: renderAuto,
  });
  // どれもクリックの中で呼ぶ（フォルダ選択・許可のダイアログはクリックがないと出せない）
  autoEls.setup.addEventListener('click', () => (autobackup.info().status === 'paused' ? autobackup.resume() : autobackup.choose()));
  autoEls.stop.addEventListener('click', () => { autobackup.stop(); showToast('自動バックアップを止めた。'); });
  autoEls.paused.addEventListener('click', () => {
    if (autobackup.info().status === 'error') { autobackup.choose(); return; }
    autobackup.resume().then((ok) => { if (ok) showToast('自動バックアップを再開した。'); });
  });
  document.getElementById('restoreFromFolder').addEventListener('click', async () => {
    const file = await autobackup.chooseForRestore();
    if (file === undefined) return; // キャンセル
    if (!file) { showToast('このフォルダにはタコエディタのバックアップが見つからなかった。'); return; }
    backupUi.openFile(file);
  });
  autobackup.init();

  window.KotobaAbout.create({ isMac: IS_MAC });

  done = window.KotobaDone.create({
    getMemo: (id) => { syncBody(); return findMemo(id); },
    countChars,
    // 完成の印が変わった・完成時の版に戻した、など。一覧と紙の帯を描き直して保存する
    commit: ({ reopen = false } = {}) => {
      if (reopen) {
        bodyDirty = false; // 原稿を直接書き換えたので、エディタの中身で上書きし返さない
        openMemo(store.activeId);
      } else {
        const m = activeMemo();
        app.classList.toggle('is-done', !!(m && !m.parentId && m.completed));
        renderList();
      }
      scheduleSave();
    },
    openExport: () => exporter.open(),
    notify: showToast,
    settings: store.settings,
    label: memoLabel,
  });

  window.KotobaPWA.create({
    installButton: document.getElementById('installBtn'),
    // 新しい版が届いた。勝手に読み直すと書いている最中の人が困るので、押してもらう
    onUpdateReady: (apply) => showToast('新しい版があります', { label: '更新', run: apply }),
    beforeReload: saveNow,
  });
  applySettings();
  openMemo(store.activeId);
  updateRestoreHint();
})();
