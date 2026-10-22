// kotoba - ブラウザ（やアプリの外側）に頼る処理の窓口
//
// なぜ分けるのか:
//   いずれ Tauri でデスクトップアプリにすると、中身は同じ HTML/JS のまま、外側がブラウザから
//   OS の WebView（Mac は Safari の中身、Windows は Edge の中身）に変わる。
//   ほとんどの処理はそのまま動くが、「ファイルを保存する」「外部の URL を開く」「印刷する」は
//   ブラウザとアプリで作法が違う（アプリでは <a download> も window.open も素直には動かない）。
//   そういう処理だけをここに集めておけば、アプリ化のときはこのファイルを差し替えるだけで済む。

(function (root) {
  'use strict';

  const browser = {
    name: 'browser',

    // ファイルとして保存する（ブラウザ：ダウンロードフォルダへ）
    // アプリ化したら：Tauri の dialog.save() で保存先を選ばせ、fs.writeFile() で書く
    async saveFile(name, blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // すぐに解放するとダウンロードが始まる前に URL が消えることがあるので、少し待つ
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },

    // 外部の URL を開く（ブラウザ：新しいタブ）
    // アプリ化したら：Tauri の opener プラグインで、いつも使っているブラウザで開く
    openExternal(url) {
      if (!/^https?:\/\//.test(url)) return; // http/https 以外は開かない
      window.open(url, '_blank', 'noopener,noreferrer');
    },

    // 印刷（ブラウザ：印刷ダイアログ → 「PDF として保存」）
    // アプリ化したら：WebView の印刷が使えるか要確認。だめなら PDF を作る別の手段に差し替える
    print() {
      window.print();
    },
  };

  root.KotobaPlatform = browser;
})(typeof window !== 'undefined' ? window : globalThis);
