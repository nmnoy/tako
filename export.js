// kotoba - 書き出し（テキスト / Word / PDF）
//
// 構成:
//   前半（DOM なし）: ファイルの中身を作る。node だけでテストできる
//     buildText  : .txt の文字列
//     buildDocx  : .docx のバイト列（Uint8Array）
//     zip        : ZIP の組み立て（.docx の正体は「XML ファイル数枚を ZIP で固めたもの」）
//   後半（create）: 書き出しダイアログ、ダウンロード、印刷（PDF）
//
// なぜ PDF だけ印刷経由なのか:
//   日本語の PDF をブラウザで直接作るには、数 MB あるフォントを丸ごと埋め込む必要があり現実的でない。
//   印刷用のレイアウトだけこちらで整え、「PDF として保存」は OS とブラウザに任せる。縦書きもそのまま出る。
//
// なぜ Word にライブラリを使わないのか:
//   このアプリは index.html を開くだけで動く（ビルドなし・ネットなし）ので、npm のライブラリは持ち込めない。
//   必要な XML は5枚だけなので、自前で組み立てる。

(function (root) {
  'use strict';

  // ===============================================================
  // 書き出す中身（DOM なし）
  // ===============================================================

  // parts: [{ kind: 'main' | 'ref', title, body, images? }]  先頭が本文、残りが資料
  //   images: [{ bytes: Uint8Array, type, width, height, name }]（資料に貼った画像。Word / zip に入れるとき）

  // ファイル名に使えない文字を「_」に。空なら「無題」
  function fileNameOf(title, suffix = '') {
    let base = (title || '').trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') // Windows / Mac でファイル名に使えない文字
      .slice(0, 80)
      .replace(/[. ]+$/, '');                    // Windows は末尾のピリオド・空白を勝手に消す
    // Windows では CON・PRN・NUL・COM1 などはファイル名にできない（拡張子が付いていてもだめ）
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base += '_';
    return (base || '無題') + suffix;
  }

  // ---------------------------------------------------------------
  // テキスト
  // ---------------------------------------------------------------
  const RULE = '――――――――――――――――';

  function buildText(parts) {
    const out = [];
    parts.forEach((p, i) => {
      if (p.kind === 'main') {
        out.push(p.title || '無題', '', p.body);
      } else {
        // 資料は罫線と見出しで区切る。メモ帳で開いても本文と資料の境目が分かるように
        out.push('', '', RULE, `資料：${p.title || '無題'}`, RULE, '', p.body);
      }
      if (i === parts.length - 1) out.push('');
    });
    return out.join('\n');
  }

  // ---------------------------------------------------------------
  // Word（.docx）
  // ---------------------------------------------------------------
  // XML に入れられない制御文字（タブ・改行以外）を取り除いてからエスケープする。
  // これを忘れると、コピペで紛れ込んだ見えない文字1つで Word が「ファイルが壊れています」と言う
  const INVALID_XML = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu;
  function esc(s) {
    return String(s).replace(INVALID_XML, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  // 画像を入れるときに要る名前空間（図の配置 wp と、画像ファイルへの参照 r）
  const DOC_NS = W_NS +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

  // Word がそのまま表示できる画像の形式。これ以外（WebP・SVG など）は書き出す前に PNG にしておく（create 側）
  const DOCX_IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' };

  // 画像の大きさは EMU（English Metric Unit、1px = 9525 EMU @96dpi）で書く。
  // A4・余白30mm の本文の幅（8504 twip ≒ 15cm）に収め、縦はページの7割まで
  const EMU_PER_PX = 9525;
  const MAX_CX = 8504 * 635;
  const MAX_CY = Math.round(13436 * 635 * 0.7);

  // 1枚の画像を1段落に入れる（文字と同じ流れに置く「行内」配置。回り込みはしない）
  function imagePara(img, n, rId) {
    const scale = Math.min(1, MAX_CX / (img.width * EMU_PER_PX), MAX_CY / (img.height * EMU_PER_PX));
    const cx = Math.max(1, Math.round(img.width * EMU_PER_PX * scale));
    const cy = Math.max(1, Math.round(img.height * EMU_PER_PX * scale));
    const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
    return '<w:p><w:r><w:drawing>' +
      `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${n}" name="画像${n}" descr="${esc(img.name || '')}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks ${A} noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic ${A}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      `<pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }
  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  // 1段落。本文は1行＝1段落（Word では改行ではなく段落で区切るのが作法）
  function para(text, { style = null, pageBreakBefore = false } = {}) {
    const pPr = (style || pageBreakBefore)
      ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pageBreakBefore ? '<w:pageBreakBefore/>' : ''}</w:pPr>`
      : '';
    if (!text) return `<w:p>${pPr}</w:p>`;
    // 行頭の全角スペース（字下げ）や連続する空白を消さないよう xml:space="preserve"
    return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  }

  // media: 画像ファイルの一覧を受け取る配列（ここで中身を足していく）。[{ file, rId, bytes, type }]
  function documentXml(parts, { vertical }, media = []) {
    const body = [];
    for (const p of parts) {
      if (p.kind === 'main') {
        body.push(para(p.title || '無題', { style: 'Title' }));
      } else {
        // 資料はそれぞれ新しいページから。見出し1にしておくと Word のナビゲーションに並ぶ
        body.push(para(`資料：${p.title || '無題'}`, { style: 'Heading1', pageBreakBefore: true }));
      }
      for (const line of p.body.split('\n')) body.push(para(line));
      // 資料の画像は本文の後ろに、1枚ずつ段落にして並べる
      for (const img of p.images || []) {
        const ext = DOCX_IMAGE_EXT[img.type];
        if (!ext || !img.width || !img.height) continue;
        const n = media.length + 1;
        const rId = `rIdImg${n}`; // rId1 は styles.xml が使っているので、別の名前にする
        media.push({ file: `media/image${n}.${ext}`, rId, bytes: img.bytes, type: img.type });
        body.push(imagePara(img, n, rId));
      }
    }
    // A4・余白 30mm（1mm ≒ 56.7 twip）。縦書きの設定なら Word でも縦書き（右から左へ行が進む）で開く
    const sect = '<w:sectPr>' +
      '<w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1701" w:right="1701" w:bottom="1701" w:left="1701" w:header="851" w:footer="851" w:gutter="0"/>' +
      (vertical ? '<w:textDirection w:val="tbRl"/>' : '') +
      '</w:sectPr>';
    return `${XML_HEAD}<w:document ${DOC_NS}><w:body>${body.join('')}${sect}</w:body></w:document>`;
  }

  function stylesXml({ serif }) {
    // 游明朝・游ゴシックは Windows にも Mac にも入っている
    const face = serif ? '游明朝' : '游ゴシック';
    const fonts = `<w:rFonts w:ascii="${face}" w:hAnsi="${face}" w:eastAsia="${face}" w:cs="${face}"/>`;
    return `${XML_HEAD}<w:styles ${W_NS}>` +
      `<w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="ja-JP" w:eastAsia="ja-JP"/></w:rPr></w:rPrDefault>` +
      '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:spacing w:after="480"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:keepNext/><w:spacing w:after="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>' +
      '</w:styles>';
  }

  function coreXml(title) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${esc(title || '無題')}</dc:title><dc:creator>タコエディタ</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      '</cp:coreProperties>';
  }

  function buildDocxFiles(parts, { serif = false, vertical = false } = {}) {
    const media = [];
    const document = documentXml(parts, { vertical }, media);
    // 画像の形式ごとに「この拡張子は画像」と宣言しておく（ないと Word が「ファイルが壊れています」と言う）
    const exts = [...new Set(media.map((m) => m.file.split('.').pop()))];
    const files = {
      '[Content_Types].xml': `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        exts.map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('') +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '</Types>',
      '_rels/.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>',
      'word/_rels/document.xml.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        media.map((m) => `<Relationship Id="${m.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.file}"/>`).join('') +
        '</Relationships>',
      'word/document.xml': document,
      'word/styles.xml': stylesXml({ serif }),
      'docProps/core.xml': coreXml(parts[0] && parts[0].title),
    };
    for (const m of media) files[`word/${m.file}`] = m.bytes;
    return files;
  }

  function buildDocx(parts, opts) {
    return zip(buildDocxFiles(parts, opts));
  }

  // ---------------------------------------------------------------
  // 本文と資料を1つずつ別のファイルにして、zip にまとめる
  // ---------------------------------------------------------------
  // 何個もダウンロードさせると、Chrome が「このサイトが複数のファイルをダウンロードしようとしています」と
  // 止めてくる（2個目以降が許可待ちになる）。1つの zip にまとめれば1回のダウンロードで済み、
  // 展開すると作品名のフォルダの中に並ぶ。Windows も Mac も、zip はダブルクリックで開ける。
  //
  //   銀河の果て/
  //     銀河の果て.txt
  //     資料01_人物.txt
  //     資料01_人物_画像01.jpg   ← テキストのときは、資料の画像を隣に並べる（Word のときは docx の中に入れる）
  //     資料02_世界観.txt
  //
  // 資料に番号を振るのは、ファイル一覧で kotoba の一覧と同じ順に並ぶように（名前順だと「世界観」が先に来る）。
  // 戻り値: { 'フォルダ/ファイル名': 中身（文字列 or Uint8Array） }
  const IMAGE_FILE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };

  function buildSeparateFiles(parts, format, style = {}) {
    const ext = format === 'docx' ? '.docx' : '.txt';
    const folder = fileNameOf(parts[0] && parts[0].title);
    const used = new Set();
    const unique = (name) => {
      let n = name;
      for (let i = 2; used.has(n.toLowerCase()); i++) n = `${name} (${i})`; // Windows は大文字小文字を区別しない
      used.add(n.toLowerCase());
      return n;
    };
    const width = String(parts.length - 1).length < 2 ? 2 : String(parts.length - 1).length;

    const files = {};
    let refNo = 0;
    for (const p of parts) {
      // 1ファイルの中では、資料も「見出し＋本文」の普通の文書として書く（罫線や「資料：」は付けない）
      const one = [{ kind: 'main', title: p.title, body: p.body }];
      const base = p.kind === 'main'
        ? fileNameOf(p.title)
        : `資料${String(++refNo).padStart(width, '0')}_${fileNameOf(p.title)}`;
      const uniqueBase = unique(base);
      const name = `${folder}/${uniqueBase}${ext}`;
      if (format === 'docx') {
        files[name] = buildDocx([{ ...one[0], images: p.images }], style);
      } else {
        files[name] = buildText(one);
        (p.images || []).forEach((img, i) => {
          const imgExt = IMAGE_FILE_EXT[img.type] || 'bin';
          files[`${folder}/${unique(`${uniqueBase}_画像${String(i + 1).padStart(2, '0')}`)}.${imgExt}`] = img.bytes;
        });
      }
    }
    return files;
  }

  // ---------------------------------------------------------------
  // ZIP（無圧縮）
  // ---------------------------------------------------------------
  // .docx に必要なのは「ZIP として正しいこと」だけで、圧縮は必須ではない。
  // 圧縮（deflate）まで自前で書くのは大仕事なので、無圧縮（stored）で固める。文章だけなら数百 KB に収まる
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(files, date = new Date()) {
    const enc = new TextEncoder();
    // ZIP の日時は MS-DOS 形式（2秒単位）
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

    const chunks = [];
    const central = [];
    let offset = 0;

    for (const [name, content] of Object.entries(files)) {
      const nameBytes = enc.encode(name);
      const data = typeof content === 'string' ? enc.encode(content) : content;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);  // ローカルファイルヘッダの目印
      local.setUint16(4, 20, true);          // 展開に必要なバージョン
      local.setUint16(6, 0x0800, true);      // ファイル名は UTF-8
      local.setUint16(8, 0, true);           // 無圧縮
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);    // 中央ディレクトリの目印
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, dosTime, true);
      cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, offset, true);       // このファイルのローカルヘッダの位置
      central.push(new Uint8Array(cen.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);      // 終端レコードの目印
    end.setUint16(8, Object.keys(files).length, true);
    end.setUint16(10, Object.keys(files).length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    const all = [...chunks, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
    let pos = 0;
    for (const c of all) { out.set(c, pos); pos += c.length; }
    return out;
  }

  // ===============================================================
  // 書き出しダイアログ（DOM あり）
  // ===============================================================

  // 保存・印刷は platform.js に任せる（アプリ化のときに差し替える場所を1か所にするため）
  const download = (name, blob) => root.KotobaPlatform.saveFile(name, blob);

  // PDF：印刷用の要素に中身を流し込み、ブラウザの印刷（→ PDF として保存）を呼ぶ
  // 資料の画像（images[].url）も本文の後ろに並べる。画像の読み込みが終わってから印刷を呼ぶ
  // （読み込む前に印刷画面を開くと、画像のところが空白のまま PDF になる）
  async function printParts(parts, { serif, vertical }) {
    const area = document.getElementById('printArea');
    area.textContent = '';
    area.className = 'print-area' + (serif ? ' serif' : '');
    // 縦書きは文書全体（html 要素）を縦書きにする。印刷の改ページは「ページの縦方向」にしか効かないので、
    // 中の要素だけ縦書きにすると、資料の前の改ページが効かず、長い原稿も次のページへ送られない
    document.documentElement.classList.toggle('print-vertical', !!vertical);
    for (const p of parts) {
      const sec = document.createElement('section');
      sec.className = p.kind === 'main' ? 'print-main' : 'print-ref';
      const h = document.createElement(p.kind === 'main' ? 'h1' : 'h2');
      h.textContent = p.kind === 'main' ? (p.title || '無題') : `資料：${p.title || '無題'}`;
      const body = document.createElement('div');
      body.className = 'print-body';
      body.textContent = p.body; // pre-wrap で改行・字下げをそのまま出す
      sec.append(h, body);
      if (p.images && p.images.length) {
        const box = document.createElement('div');
        box.className = 'print-images';
        for (const img of p.images) {
          const el = document.createElement('img');
          el.src = img.url;
          el.alt = img.name || '';
          box.appendChild(el);
        }
        sec.appendChild(box);
      }
      area.appendChild(sec);
    }
    await Promise.all([...area.querySelectorAll('img')].map((el) => el.decode().catch(() => {})));

    // 「PDF として保存」のファイル名はページのタイトルになるので、一時的に作品名にする
    const prevTitle = document.title;
    document.title = fileNameOf(parts[0] && parts[0].title);
    const done = () => {
      document.title = prevTitle;
      document.documentElement.classList.remove('print-vertical');
      area.textContent = '';
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    root.KotobaPlatform.print();
  }

  // Word に入れられない形式（WebP・SVG など）を PNG にする。Word が読めない画像は「壊れたファイル」の元になる
  async function toDocxImage(rec) {
    if (DOCX_IMAGE_EXT[rec.type]) return { bytes: new Uint8Array(await rec.blob.arrayBuffer()), type: rec.type, width: rec.width, height: rec.height, name: rec.name };
    const url = URL.createObjectURL(rec.blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = rec.width || img.naturalWidth || 800;
      c.height = rec.height || img.naturalHeight || 600;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/png', width: c.width, height: c.height, name: rec.name };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // getImages(memoId) … その資料の画像（storage の記録 { blob, type, width, height, name }）。なければ []
  function create({ getParts, getStyle, options, onOptionsChange, getImages = async () => [] }) {
    const dialog = document.getElementById('exportDialog');
    const form = dialog.querySelector('form');
    const note = dialog.querySelector('.export-note');

    const syncNote = () => {
      const fmt = form.elements.format.value;
      note.textContent = fmt === 'pdf'
        ? '印刷の画面が開くので、送信先で「PDF として保存」を選んで保存してください。'
        : fmt === 'docx'
          ? '游明朝 / 游ゴシックで書き出します。縦書きの設定なら Word でも縦書きで開きます。'
          : '文字コードは UTF-8 です。';
      // 本文＋資料のとき：PDF は1冊にまとめ、それ以外は1つずつ別のファイルにして zip で渡す
      if (form.elements.scope.value === 'all') {
        note.textContent += fmt === 'pdf'
          ? '本文と資料は1つの PDF にまとめ、資料はそれぞれ新しいページから始めます。'
          : '本文と資料を1つずつ別のファイルにして、zip にまとめてダウンロードします。';
        note.textContent += '資料に貼った画像も入れます。';
      }
    };

    function open() {
      form.elements.scope.value = options.scope || 'main';
      form.elements.format.value = options.format || 'txt';
      syncNote();
      dialog.showModal();
    }

    async function run() {
      const scope = form.elements.scope.value;
      const format = form.elements.format.value;
      options.scope = scope;
      options.format = format;
      onOptionsChange();

      const parts = getParts(scope === 'all');
      const style = getStyle();
      const name = fileNameOf(parts[0].title, scope === 'all' ? '_資料つき' : '');

      // 資料の画像を集める（本文には画像がないので、本文＋資料のときだけ）
      const urls = [];
      if (scope === 'all') {
        for (const p of parts) {
          if (p.kind !== 'ref' || !p.id) continue;
          const recs = await getImages(p.id).catch(() => []);
          if (!recs.length) continue;
          if (format === 'pdf') {
            p.images = recs.map((r) => { const url = URL.createObjectURL(r.blob); urls.push(url); return { url, name: r.name }; });
          } else if (format === 'docx') {
            p.images = await Promise.all(recs.map(toDocxImage));
          } else {
            p.images = await Promise.all(recs.map(async (r) => ({ bytes: new Uint8Array(await r.blob.arrayBuffer()), type: r.type, name: r.name })));
          }
        }
      }

      if (scope === 'all' && format !== 'pdf') {
        const files = buildSeparateFiles(parts, format, style);
        download(name + '.zip', new Blob([zip(files)], { type: 'application/zip' }));
      } else if (format === 'txt') {
        download(name + '.txt', new Blob([buildText(parts)], { type: 'text/plain;charset=utf-8' }));
      } else if (format === 'docx') {
        download(name + '.docx', new Blob([buildDocx(parts, style)], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }));
      } else {
        // ダイアログを閉じてから印刷を呼ぶ（開いたままだとダイアログも印刷されることがある）
        dialog.close();
        await new Promise((r) => setTimeout(r, 50));
        await printParts(parts, style);
        // 印刷画面が閉じたら画像の URL を片付ける（印刷中に消すと PDF から画像が抜ける）
        window.addEventListener('afterprint', () => urls.forEach((u) => URL.revokeObjectURL(u)), { once: true });
        return;
      }
      dialog.close();
    }

    form.addEventListener('change', syncNote);
    form.addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return; // method="dialog" がそのまま閉じる
      e.preventDefault();
      run();
    });

    return { open };
  }

  root.KotobaExport = { fileNameOf, buildText, buildDocxFiles, buildDocx, buildSeparateFiles, zip, crc32, create };
})(typeof window !== 'undefined' ? window : globalThis);
