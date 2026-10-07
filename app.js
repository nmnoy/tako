// kotoba - 類語辞典付きメモ（プロトタイプ）
// 設計の背景は SPEC.md を参照。

(() => {
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

  const STORE_KEY = 'kotoba:v1';
  const LEGACY_KEY = 'kotoba:text'; // 1枚メモ時代の保存先。初回だけ移行する

  // い形容詞の語幹の後ろに来うる文字（暑「か」った、暑「く」、暑「け」れば、暑「さ」、暑「そ」う）
  const ADJ_TAIL = 'かくけさそ';

  const app = document.getElementById('app');
  const memoList = document.getElementById('memoList');
  const addMainBtn = document.getElementById('addMain');

  // 資料を一覧の中でその場に開いたときの本文欄。1つだけ作っておき、開く行の下へ移動させて使い回す。
  const refBody = document.createElement('textarea');
  refBody.className = 'ref-body';
  refBody.spellcheck = false;
  refBody.placeholder = '（空）';
  const titleInput = document.getElementById('title');
  const editor = document.getElementById('editor');
  const count = document.getElementById('count');
  const fontToggle = document.getElementById('fontToggle');
  const dirToggle = document.getElementById('dirToggle');
  const twToggle = document.getElementById('twToggle');
  const search = document.getElementById('search');
  const results = document.getElementById('results');

  // 自前のカーソルとタイプライタースクロール（caret.js）。
  // ミラーとカーソルは .sheet（本文を包む要素）の中に重ねて置く
  const caretEngine = window.KotobaCaret.create(editor, editor.parentElement);

  // 検索・置換（find.js）。設定を読み込んでから作るので、ここでは入れ物だけ用意する
  let find = null;

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
    settings: {
      font: 'sans', vertical: false, typewriter: false,
      find: { width: true, kana: false, conj: false }, // 検索のゆれの扱い
    },
  };

  let saveTimer = null;

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function newMemo(body = '', parentId = null) {
    return { id: makeId(), parentId, title: '', body, updatedAt: Date.now() };
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

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.memos)) {
          // サブ機能以前のデータには parentId がないので、全部メインとして扱う
          store.memos = parsed.memos.map((m) => ({ parentId: null, ...m }));
          store.activeId = parsed.activeId;
          store.pinnedId = parsed.pinnedId || null;
          store.settings = { ...store.settings, ...parsed.settings };
          store.settings.find = { width: true, kana: false, conj: false, ...(parsed.settings && parsed.settings.find) };
        }
      } else {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy) store.memos = [newMemo(legacy)];
      }
    } catch (_) {
      // 壊れたデータ / プライベートウィンドウ等。新規メモで始める
    }

    // 親が消えているサブ（データ破損対策）は捨てる
    const ids = new Set(store.memos.map((m) => m.id));
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

  function saveNow() {
    clearTimeout(saveTimer);
    syncBody();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (_) {
      // 容量オーバー等。プロトタイプなので黙って諦める（SPEC.md の既知の課題参照）
    }
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

  // 一覧の1行を作る。actions は行の右端の小さいボタン（開いて見る・削除）
  function makeItem({ memo, classes, onOpen, actions = [] }) {
    // 行を <button> にすると中にボタンを入れられない（button の入れ子は HTML 的に不正）。
    // 外側は div にして role と tabindex で補う。
    const item = document.createElement('div');
    item.className = ['memo-item', ...classes].join(' ');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    if (classes.includes('active')) item.setAttribute('aria-current', 'true');

    const label = document.createElement('span');
    label.className = 'memo-label';
    label.textContent = memoLabel(memo);
    // 打鍵ごとに一覧を作り直さず、ラベルだけ差し替えられるよう目印を付ける
    label.dataset.labelFor = memo.id;
    item.appendChild(label);

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
        actions: [{ text: '×', title: 'このメモを削除', onClick: () => deleteMemo(m.id) }],
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

  function openMemo(id) {
    const memo = findMemo(id);
    if (!memo) return;
    syncBody(); // 切り替える前に、今のメモの本文を確定させる

    store.activeId = id;

    // その場で開いている資料をエディタで開いたら、そっちは閉じる。
    // 同じメモを2か所で同時に編集できると、どちらの入力が正なのか分からなくなるので。
    if (store.pinnedId === id) store.pinnedId = null;
    // 別のメインに移ったら、前のメインの資料も閉じる
    const pinned = findMemo(store.pinnedId);
    if (pinned && pinned.parentId !== activeMain().id) store.pinnedId = null;

    titleInput.value = memo.title;
    titleInput.placeholder = memo.parentId ? '資料のタイトル（例：主人公、世界観）' : 'タイトル';
    // 注意: value を代入するとブラウザの Undo 履歴がリセットされる。
    // ここではそれが正解。リセットされないと、Ctrl+Z で別のメモの文章が復活してしまう。
    editor.value = memo.body;
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
    editor.scrollLeft = 0;
    bodyDirty = false;
    caretEngine.schedule({ text: true, center: true });
    if (find) find.refresh(); // 検索バーが開いていれば、新しいメモで探し直す

    target = null; // 前のメモで選んでいた置換対象は無効
    origin = null;

    renderList();
    updateCount();
    scheduleSave();
    editor.focus();
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
      updateCount();
    }, IDLE_DELAY);
  }

  // ===============================================================
  // 表示設定（フォント・縦書き・タイプライター）
  // ===============================================================

  function applySettings() {
    const { font, vertical, typewriter } = store.settings;
    app.classList.toggle('font-serif', font === 'serif');
    app.classList.toggle('vertical', vertical);
    app.classList.toggle('typewriter', typewriter);
    // ボタンには「今の状態」を出す。押すと反対に切り替わる
    fontToggle.textContent = font === 'serif' ? '明朝' : 'ゴシック';
    dirToggle.textContent = vertical ? '縦書き' : '横書き';
    twToggle.textContent = typewriter ? 'タイプライター' : '通常スクロール';
    twToggle.setAttribute('aria-pressed', String(typewriter));
    // フォント・書字方向・余白が変わるとカーソルの位置の計算が全部変わるので、測り直す
    caretEngine.layout();
    caretEngine.setTypewriter(typewriter);
  }

  function toggleTypewriter() {
    store.settings.typewriter = !store.settings.typewriter;
    applySettings();
    scheduleSave();
  }

  function toggleFont() {
    store.settings.font = store.settings.font === 'serif' ? 'sans' : 'serif';
    applySettings();
    scheduleSave();
  }

  function toggleDirection() {
    store.settings.vertical = !store.settings.vertical;
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
  refBody.addEventListener('input', () => {
    const memo = findMemo(store.pinnedId);
    if (!memo) return;
    memo.body = refBody.value;
    memo.updatedAt = Date.now();
    updateLabel(memo);
    scheduleSave();
  });

  // --- メモ一覧 ---

  addMainBtn.addEventListener('click', addMain);

  // --- ステータスのボタン ---

  // 候補ボタンと同じ理由で、押した瞬間に本文のフォーカスと選択を奪わないようにする。
  // pointerdown で preventDefault してもその後の click は発火するので、処理は click に書ける。
  for (const btn of [fontToggle, dirToggle, twToggle]) {
    btn.addEventListener('pointerdown', (ev) => ev.preventDefault());
  }
  fontToggle.addEventListener('click', toggleFont);
  dirToggle.addEventListener('click', toggleDirection);
  twToggle.addEventListener('click', toggleTypewriter);

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
      e.preventDefault();
      editor.focus();
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
    if (document.visibilityState === 'hidden') saveNow();
  });
  window.addEventListener('pagehide', saveNow);

  // ===============================================================
  // 起動
  // ===============================================================

  loadStore();
  find = window.KotobaFind.create({
    editor,
    layer: editor.parentElement,
    caret: caretEngine,
    replaceRange,
    lex: { isVerb, isAdjective: (w) => ADJ_SET.has(w), Verb },
    options: store.settings.find,
    onOptionsChange: scheduleSave,
  });
  applySettings();
  openMemo(store.activeId);
})();
