#!/usr/bin/env python3
"""アプリのアイコン一式を、作者が描いた元絵（tools/icons/icon-source.png）から作る。

使い方（元絵を差し替えたら）:
    python3 tools/build_icons.py

元絵: 1024×1024 の PNG（背景は透明）。クリスタで描いたもの

出力（icons/）:
    icon-512.png / icon-192.png  … manifest の普通のアイコン（背景は透明のまま）
    icon-maskable-512.png        … OS が丸や角丸に切り抜く用。背景を白で塗る（透明だと切り抜いたときに変な色が付く）。
                                   絵は中央の円（直径 80%）に収まっている必要がある → 収まらなければ縮めて収める
    apple-touch-icon.png（180）  … iPhone / iPad のホーム画面用。透明だと黒く塗られるので白で塗る
    favicon-32.png               … ブラウザのタブ用
"""
import math
import pathlib
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'tools' / 'icons' / 'icon-source.png'
OUT = ROOT / 'icons'
WHITE = (255, 255, 255, 255)


def fit_safe_zone(src: Image.Image, size: int) -> Image.Image:
    """白い板の上に、絵を中央の安全な円（直径 80%）に収めて置く"""
    bbox = src.getchannel('A').getbbox()
    art = src.crop(bbox)
    # 絵の四角の対角線の半分が、円の半径（40%）に収まる倍率
    half_diag = math.hypot(art.width, art.height) / 2
    scale = min(1.0, (src.width * 0.40) / half_diag)
    art = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)
    # 元絵の中での位置（中心からのずれ）も、同じ倍率で保つ
    cx = (bbox[0] + bbox[2]) / 2 - src.width / 2
    cy = (bbox[1] + bbox[3]) / 2 - src.height / 2
    board = Image.new('RGBA', src.size, WHITE)
    board.alpha_composite(art, (round(src.width / 2 + cx * scale - art.width / 2),
                                round(src.height / 2 + cy * scale - art.height / 2)))
    return board.resize((size, size), Image.LANCZOS)


def on_white(src: Image.Image, size: int) -> Image.Image:
    board = Image.new('RGBA', src.size, WHITE)
    board.alpha_composite(src)
    return board.resize((size, size), Image.LANCZOS).convert('RGB')


def main() -> None:
    src = Image.open(SRC).convert('RGBA')
    if src.size != (1024, 1024):
        src = src.resize((1024, 1024), Image.LANCZOS)
    for size in (512, 192):
        src.resize((size, size), Image.LANCZOS).save(OUT / f'icon-{size}.png', optimize=True)
    fit_safe_zone(src, 512).save(OUT / 'icon-maskable-512.png', optimize=True)
    on_white(src, 180).save(OUT / 'apple-touch-icon.png', optimize=True)
    src.resize((32, 32), Image.LANCZOS).save(OUT / 'favicon-32.png', optimize=True)
    print('→ icons/icon-512.png, icon-192.png, icon-maskable-512.png, apple-touch-icon.png, favicon-32.png')


if __name__ == '__main__':
    main()
