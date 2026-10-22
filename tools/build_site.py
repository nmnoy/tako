#!/usr/bin/env python3
"""公開用のファイルだけを dist/ に集める（Cloudflare Pages のビルドで実行する）。

使い方:
    python3 tools/build_site.py
    → dist/ に、アプリの動作に必要なファイルだけが入る

Cloudflare Pages の設定:
    ビルドコマンド:      python3 tools/build_site.py
    ビルド出力ディレクトリ: dist

なぜ必要か:
    リポジトリをまるごと公開すると、SPEC.md（開発メモ）や tools/ のスクリプトまで URL で見られてしまう。
    公開するのは sw.js の ASSETS に書いてあるファイル（＝オフラインでも動くのに必要なもの）と sw.js だけにする。
    ついでに sw.js の VERSION を書き換える（stamp_sw.py）。公開のたびに自動で走るので、書き換え忘れがなくなる。
"""
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / 'dist'


def main() -> int:
    # 1. sw.js の VERSION を中身から決め直す（ASSETS の書き忘れ・存在しないファイルもここで止まる）
    r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'stamp_sw.py')])
    if r.returncode != 0:
        return r.returncode

    # 2. ASSETS を読む
    src = (ROOT / 'sw.js').read_text(encoding='utf-8')
    block = re.search(r'const ASSETS = \[(.*?)\];', src, re.S)
    assets = re.findall(r"'([^']+)'", block.group(1))

    # 3. dist/ を作り直してコピー
    if DIST.exists():
        shutil.rmtree(DIST)
    for rel in [*assets, 'sw.js']:
        dst = DIST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)

    total = sum(p.stat().st_size for p in DIST.rglob('*') if p.is_file())
    print(f'dist/ に {len(assets) + 1} ファイル（{total / 1024 / 1024:.1f}MB）を用意した')
    return 0


if __name__ == '__main__':
    sys.exit(main())
