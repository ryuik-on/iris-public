#!/usr/bin/env python3
"""コアの静止画を描く。アプリのアイコン用。

画面のコアは 4200 粒の流れ場で、粒の数ではなく「軌跡が蓄積すること」で
あの濃さになっている。だからここでも同じことをする — 粒を進めながら
バッファに足し込み、毎歩わずかに減衰させる。

減衰は「暗い矩形を重ねる」ではなく、バッファ自体を定数倍する。
src/Core.tsx にその理由が書かれている: 上から塗ると色が増えていき、
場が白へ、次に赤へ寄っていく。乗算済みの色ごと縮めれば定常状態に落ち着く。

使い方: python3 scripts/render-core-icon.py
出力: public/iris-{512,192,180}.png と public/iris-1024.png
"""
import numpy as np
from PIL import Image, ImageFilter

SIDE = 1024
STEPS = 700
PARTICLES = 3000

# --hud-accent の系統。色相 198 は画面のコアが全状態で使う値。
INK = np.array([0.20, 0.72, 0.99])
# --hud-bg
GROUND = np.array([0x04, 0x07, 0x0C]) / 255.0


def render() -> np.ndarray:
    """帯のコアと同じ描き方をする。

    src/Core.tsx の速度場（角速度が半径に反比例し、3葉と5葉が半径方向に流す）
    を忠実に移植した版も作った。場としてはそちらが本物だが、
    利用者が選んだのは帯の方だった — 単純な極座標の移流に、粒ごとの明滅と
    軌跡の蓄積を重ねたもの。小さく見たときはこちらの方が「環」として読める。

    忠実さより、選ばれた方を採る。両方を残して食い違わせるより一つにする。
    """
    rng = np.random.default_rng(20260821)
    field = np.zeros((SIDE, SIDE), dtype=np.float32)

    centre = SIDE / 2
    unit = SIDE * 0.30

    angle = rng.uniform(0, 2 * np.pi, PARTICLES)
    # ひとつの円周ではなく帯に散らす。単一半径は環、帯は場になる。
    radius = rng.uniform(0.62, 1.30, PARTICLES)
    # 粒ごとに速さを変える。同じだと剛体のように回り、ずれが生まれない。
    speed = rng.uniform(0.55, 1.45, PARTICLES)
    index = np.arange(PARTICLES)

    for _ in range(STEPS):
        angle = angle + 0.055 * speed
        # ゆっくりした呼吸。帯が固定の円環にならないように。
        radius = np.clip(radius + np.sin(angle * 1.7 + index) * 0.0016, 0.58, 1.34)

        x = (centre + np.cos(angle) * unit * radius).astype(np.int32)
        y = (centre + np.sin(angle) * unit * radius).astype(np.int32)

        # 均等に光らせない。均等な環は読み込み中の輪に見える。
        lit = np.clip(np.sin(angle * 3 + radius * 6), 0, None) ** 2
        weight = (0.05 + lit * 0.30).astype(np.float32)

        # 1画素では 1024px の中で小さすぎる。帯では 2px の円を 72px の中に
        # 描いていて、相対的にはずっと太い。3x3 に散らして太さを合わせる。
        ok = (x >= 1) & (x < SIDE - 1) & (y >= 1) & (y < SIDE - 1)
        xs, ys, ws = x[ok], y[ok], weight[ok]
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                falloff = 1.0 if dx == 0 and dy == 0 else (0.5 if dx == 0 or dy == 0 else 0.3)
                np.add.at(field, (ys + dy, xs + dx), ws * falloff)

        # 減衰は定数倍。上塗りではない（冒頭の注記のとおり）。
        field *= 0.88

    return field


def compose(field: np.ndarray) -> Image.Image:
    # 上位0.5%ではなく百分位で正規化する。最大値で割ると、たまたま何度も
    # 重なった数画素に引きずられて、残り全部が潰れる — 最初にそれをやって
    # 暗い輪になった。
    field = field / max(float(np.percentile(field[field > 0], 99.5)), 1e-6)
    field = np.clip(field, 0, 1)
    # 弱いところを持ち上げる。線形のままだと軌跡がほとんど見えない。
    field = np.power(field, 0.55)

    glow = Image.fromarray((np.clip(field, 0, 1) * 255).astype(np.uint8))
    glow = glow.filter(ImageFilter.GaussianBlur(SIDE * 0.028))
    halo = np.asarray(glow, dtype=np.float32) / 255.0

    # 光暈を先に、場をその上に。画面側の .hud-visor::before と同じ考えで、
    # 虚空に描かれた線ではなく空間の中の光に見せる。
    lit = np.clip(field * 2.6 + halo * 0.9, 0, 2.1)

    rgb = GROUND[None, None, :] + INK[None, None, :] * lit[:, :, None]
    rgb = np.clip(rgb, 0, 1)

    return Image.fromarray((rgb * 255).astype(np.uint8), mode="RGB").convert("RGBA")


if __name__ == "__main__":
    image = compose(render())
    image.save("public/iris-1024.png")
    for size in (512, 192, 180):
        image.resize((size, size), Image.LANCZOS).save(f"public/iris-{size}.png")
    print("public/iris-{1024,512,192,180}.png を書きました")
