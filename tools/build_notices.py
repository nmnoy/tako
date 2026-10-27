#!/usr/bin/env python3
"""THIRD_PARTY_NOTICES.md と licenses/ から、アプリ内で表示する notices.js を作る。

使い方（ライセンス表記を直したら毎回）:
    python3 tools/build_notices.py

なぜ生成するのか:
    「このアプリについて」の画面に出すライセンス表記と、配布物に同梱する THIRD_PARTY_NOTICES.md を
    手で二重に管理すると、片方だけ直して食い違う。元は THIRD_PARTY_NOTICES.md の1つだけにして、そこから作る。
    file:// でも動くように fetch ではなく script で読ませる（dictionary.js と同じ理由）。

読み取る形（THIRD_PARTY_NOTICES.md）:
    ## 名前
    - 配布元: URL
    - 用途: …
    - ライセンス: …
    - 全文: `licenses/xxx.txt`      ← あればその全文も入れる
    ``` 著作権表示 ```              ← あればそのまま表示
    > で始まる行は開発者向けのメモなので、アプリには出さない
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'THIRD_PARTY_NOTICES.md'
OUT = ROOT / 'notices.js'


def main() -> int:
    text = SRC.read_text(encoding='utf-8')
    sections = re.split(r'^## ', text, flags=re.M)[1:]
    items = []
    texts = {}
    for sec in sections:
        lines = sec.split('\n')
        item = {'name': lines[0].strip()}
        body = '\n'.join(lines[1:])
        for key, field in (('配布元', 'url'), ('用途', 'use'), ('ライセンス', 'license')):
            m = re.search(rf'^- {key}: (.+)$', body, flags=re.M)
            if m:
                item[field] = m.group(1).strip()
        m = re.search(r'^- 全文: `([^`]+)`', body, flags=re.M)
        if m:
            path = m.group(1)
            item['fullText'] = path
            if path not in texts:
                f = ROOT / path
                if not f.is_file():
                    print(f'{path} が見つからない', file=sys.stderr)
                    return 1
                texts[path] = f.read_text(encoding='utf-8')
        m = re.search(r'```\n(.*?)\n```', body, flags=re.S)
        if m:
            item['notice'] = m.group(1).rstrip()
        else:
            # コードブロックがなければ、著作権表示らしい行（Copyright で始まる - 行）を拾う
            m = re.search(r'^- (Copyright .+)$', body, flags=re.M)
            if m:
                item['notice'] = m.group(1).strip()
        items.append(item)

    data = {'items': items, 'texts': texts}
    OUT.write_text(
        '// 自動生成（tools/build_notices.py）。手で編集しない。元は THIRD_PARTY_NOTICES.md と licenses/\n'
        f'window.KOTOBA_NOTICES = {json.dumps(data, ensure_ascii=False, indent=1)};\n',
        encoding='utf-8')
    print(f'notices.js を作った（{len(items)} 件、全文 {len(texts)} 件）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
