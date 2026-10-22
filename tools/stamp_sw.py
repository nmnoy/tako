#!/usr/bin/env python3
"""sw.js の VERSION を、アプリのファイルの中身から作ったハッシュに書き換える。

使い方（公開する前に毎回）:
    python3 tools/stamp_sw.py

なぜ必要か:
    ブラウザは「sw.js が1バイトでも変わったか」で新しい版の有無を判断する。
    app.js だけ直して sw.js をそのままにすると、利用者の手元では古いキャッシュが出続ける。
    手で VERSION を書き換えると必ずいつか忘れるので、中身から自動で決める。
    ファイルが1文字でも変われば VERSION が変わり、何も変えていなければ同じ値のまま（無駄な更新通知が出ない）。

ついでに、ASSETS に書き忘れているファイルがないかも確かめる。
"""
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SW = ROOT / 'sw.js'

# 配信するけれどキャッシュに入れなくていいもの・配信しないもの
IGNORE_DIRS = {'tools', '.git', 'node_modules'}
IGNORE_FILES = {'sw.js', 'SPEC.md', '.gitignore', '.DS_Store'}


def main() -> int:
    src = SW.read_text(encoding='utf-8')
    block = re.search(r'const ASSETS = \[(.*?)\];', src, re.S)
    if not block:
        print('sw.js の ASSETS が見つからない', file=sys.stderr)
        return 1
    assets = re.findall(r"'([^']+)'", block.group(1))

    missing = [a for a in assets if not (ROOT / a).is_file()]
    if missing:
        print('ASSETS に書いてあるのに存在しないファイル（このままだとインストールが失敗する）:', file=sys.stderr)
        for m in missing:
            print('  ', m, file=sys.stderr)
        return 1

    # ASSETS に入っていない配信ファイル（入れ忘れるとオフラインで欠ける）
    listed = set(assets)
    for path in sorted(ROOT.rglob('*')):
        rel = path.relative_to(ROOT)
        if not path.is_file() or rel.parts[0] in IGNORE_DIRS or path.name in IGNORE_FILES:
            continue
        if rel.as_posix() not in listed:
            print(f'注意: {rel.as_posix()} が ASSETS に入っていない', file=sys.stderr)

    h = hashlib.sha256()
    for a in assets:
        h.update(a.encode())
        h.update((ROOT / a).read_bytes())
    version = h.hexdigest()[:12]

    new_src, n = re.subn(r"const VERSION = '[^']*';", f"const VERSION = '{version}';", src, count=1)
    if n != 1:
        print('sw.js の VERSION 行が見つからない', file=sys.stderr)
        return 1
    if new_src != src:
        SW.write_text(new_src, encoding='utf-8')
        print(f'VERSION を {version} にした')
    else:
        print(f'変更なし（VERSION = {version}）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
