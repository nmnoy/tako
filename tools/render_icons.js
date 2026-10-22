// アイコンの PNG を SVG から作り直す。
//   使い方: node tools/render_icons.js   （Playwright が必要: npm i -D playwright）
//   元絵: icons/icon.svg（普通のアイコン）と tools/icons/icon-maskable.svg（OS が丸く切り抜く用。中身を中央 80% に収める）
// 自分で描いた PNG を使うなら、このスクリプトは使わずに icons/ の同じ名前のファイルを差し替えればいい。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const jobs = [
  ['icons/icon.svg', 'icons/icon-192.png', 192],
  ['icons/icon.svg', 'icons/icon-512.png', 512],
  ['tools/icons/icon-maskable.svg', 'icons/icon-maskable-512.png', 512],
  ['icons/icon.svg', 'icons/apple-touch-icon.png', 180],
  ['icons/icon.svg', 'icons/favicon-32.png', 32],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [src, out, size] of jobs) {
    const svg = fs.readFileSync(path.join(root, src));
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${svg.toString('base64')}" width="${size}" height="${size}">`);
    await page.locator('img').screenshot({ path: path.join(root, out), omitBackground: true });
    console.log(out);
  }
  await browser.close();
})();
