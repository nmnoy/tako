#!/usr/bin/env python3
"""脱稿のお祝いのタコのアニメ（APNG）を、クリスタから書き出したコマ（tools/anim/frame_XX.png）から作る。

使い方（コマを差し替えたら）:
    python3 tools/build_anim.py

出力（icons/）:
    done.png        … アニメ（紺。「脱稿！」の画面はダークモードでも白い紙なので1色でいい）

コマについて:
    - 白い背景に紺1色で描いたもの（クリスタの連番書き出しは BMP で透明を持てない）。
      白地の上の紺の濃さから透明度を逆算して、縁のなめらかさを保ったまま背景を抜く
    - 512px で受け取って 128px に縮める（画面では 64px で出す。Mac の画面は2倍の密度なので 128px 要る）
    - 続けて同じ絵のコマは1コマにまとめて、その分長く出す（ファイルが軽くなる）
"""
import pathlib
from PIL import Image, ImageChops

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'tools' / 'anim'
OUT = ROOT / 'icons'

FPS = 10
SIZE = 128
PLAYS = 0            # 0 = ずっとループ（最後の6コマが同じ絵なので、そこが一息つく間になる）
INK = (16, 45, 114)  # 描いた紺


def load_frames() -> list[Image.Image]:
    """透明度だけのコマ（L）にする。赤の濃さが一番よく変わるので、赤で逆算する"""
    frames = []
    for f in sorted(SRC.glob('frame_*.png')):
        r = Image.open(f).convert('RGB').getchannel('R')
        a = r.point(lambda v: max(0, min(255, round((255 - v) * 255 / (255 - INK[0])))))
        frames.append(a.resize((SIZE, SIZE), Image.LANCZOS))
    if not frames:
        raise SystemExit(f'{SRC} にコマ（frame_00.png …）がない')
    return frames


def colorize(alpha: Image.Image, rgb: tuple[int, int, int]) -> Image.Image:
    im = Image.new('RGBA', alpha.size, rgb + (0,))
    im.putalpha(alpha)
    return im


def main() -> None:
    alphas = load_frames()
    # 同じ絵が続くところをまとめる
    merged: list[tuple[Image.Image, int]] = []
    for a in alphas:
        if merged and ImageChops.difference(merged[-1][0], a).getbbox() is None:
            merged[-1] = (merged[-1][0], merged[-1][1] + 1)
        else:
            merged.append((a, 1))
    ms = 1000 // FPS
    frames = [colorize(a, INK) for a, _ in merged]
    frames[0].save(OUT / 'done.png', save_all=True, append_images=frames[1:],
                   duration=[n * ms for _, n in merged], loop=PLAYS, disposal=1, blend=0, optimize=True)
    total = sum(n for _, n in merged) * ms
    print(f'{len(alphas)} コマ（まとめて {len(merged)} 枚）/ {total / 1000:.1f} 秒でループ → icons/done.png')


if __name__ == '__main__':
    main()
