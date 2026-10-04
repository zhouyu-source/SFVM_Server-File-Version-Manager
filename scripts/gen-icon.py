#!/usr/bin/env python
"""
SFVM 应用图标生成器（可重复执行，改下面的 PLANS 即可重出一整套）。

设计：圆角方形底（对角线渐变 深蓝 -> 蓝 -> 青）+ 一摞白色"版本卡"（三张，略微左右
错开、前低后高）+ 卡与卡之间留出底色缝；够大的尺寸在最前面那张卡上挖一个向上的箭头
—— "把当前这版发出去"。

四条硬约定（改了会坏）：
1. **形状只画"覆盖率蒙版"，不画彩色图**。白色元素统一用蒙版合成到底色上，
   圆角则单独出一份 alpha 蒙版。这样既拿到抗锯齿，又不会出现"白边/黑边"：
   直接在白透明画布上画再缩放，边界像素会混进透明区的 RGB（通常是黑），
   合成后就是一圈脏边。
2. **蒙版按超采样绘制再降采样**（PIL 的 ImageDraw 本身不做抗锯齿）。
3. **小尺寸用单独画稿**（见 PLANS）：16px 只有 16 个像素，卡片要更少更大、
   切缝要更宽，否则后层被抗锯齿抹平、整体糊成一团。
   ICO 允许每个尺寸内嵌不同位图，靠大图缩略是缩不出清晰小图标的。
4. **ICO 手工组装**：Pillow 的 save() 只能从单张图缩放出所有尺寸，
   没法给不同尺寸不同画稿。这里 256 用 PNG 压缩、其余用 32bpp DIB + AND 掩码。

用法：
    python scripts/gen-icon.py                # 写 <仓库>/build/icon.png 与 icon.ico
    python scripts/gen-icon.py --preview      # 额外输出预览图到临时目录
    python scripts/gen-icon.py --out DIR      # 换输出目录（默认 <仓库>/build）
"""

import io
import os
import struct
import sys

from PIL import Image, ImageDraw

# ---------------------------------------------------------------- 设计参数

GRADIENT_STOPS = [          # 对角线渐变色标（t=0 左上，t=1 右下）
    (0.00, (14, 42, 92)),    # 靛蓝
    (0.50, (17, 112, 186)),  # 蓝
    (1.00, (20, 196, 178)),  # 青
]

TILE_RADIUS = 0.22          # 圆角半径（占画布比例）
WHITE = (255, 255, 255)

# 每套画稿的参数：
#   n      卡片数（后 -> 前）
#   size   最前面那张卡的边长（占画布比例）
#   gap    每张卡边界外留出的底色缝宽（占画布比例）
#   span_x/span_y  最后一张与最前一张的中心间距（x 向左/右，y 向上）
#   radius 卡片圆角 / 边长
#   shrink 每后退一层缩小的比例（0 = 等大；>0 有透视感）
#   ss     超采样倍数（越小尺寸取越大，16px 上抗锯齿影响最明显）
#   back_alpha 后层"白"的混入比例（1.0 = 硬边纯白；<1 用色差分层；实测硬边更清楚）
#   knockout 前卡挖空箭头的总高（占画布比例，None = 不挖）
# 小尺寸上卡片要更少更大：16px 只放得下两张，缝再薄也得留一道，否则两层糊成一块。
DETAILED = dict(name="detailed", n=3, size=0.435, gap=0.013, span_x=0.165, span_y=0.295,
                radius=0.20, shrink=0.0, ss=4, back_alpha=1.0, knockout=0.145)
SIMPLE = dict(name="simple", n=3, size=0.470, gap=0.028, span_x=0.180, span_y=0.315,
              radius=0.20, shrink=0.0, ss=4, back_alpha=1.0, knockout=None)
TINY = dict(name="tiny", n=2, size=0.560, gap=0.040, span_x=0.150, span_y=0.300,
            radius=0.24, shrink=0.0, ss=6, back_alpha=1.0, knockout=None)

SIZE_PLAN = {
    16: TINY,
    32: SIMPLE,
    48: SIMPLE,
    64: DETAILED,
    128: DETAILED,
    256: DETAILED,
}

MASTER_SIZE = 1024          # build/icon.png 的边长
KEYHOLE_ASPECT = 0.30       # 挖空箭头：箭身宽 / 总高
KEYHOLE_HEAD = 0.78         # 挖空箭头：头宽   / 总高


# ---------------------------------------------------------------- 基础工具

def _lerp(a, b, t):
    return a + (b - a) * t


def gradient_color(t):
    """按色标插值取色，t 会被夹到 [0,1]。"""
    t = min(max(t, 0.0), 1.0)
    for i in range(len(GRADIENT_STOPS) - 1):
        t0, c0 = GRADIENT_STOPS[i]
        t1, c1 = GRADIENT_STOPS[i + 1]
        if t <= t1:
            f = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(int(round(_lerp(c0[k], c1[k], f))) for k in range(3))
    return GRADIENT_STOPS[-1][1]


def gradient_tile(size):
    """
    对角线渐变的实心底图（RGB）。按最终尺寸算，不参与超采样。
    逐通道用"行切片拼字节"，避开 Python 层逐像素写点 —— 1024² 那样会慢到不可用。
    """
    ramp = [gradient_color(i / (2 * size - 2)) for i in range(2 * size - 1)]
    chans = []
    for k in range(3):
        lut = [c[k] for c in ramp]
        buf = bytearray()
        for y in range(size):
            buf += bytes(lut[y:y + size])
        chans.append(Image.frombytes("L", (size, size), bytes(buf)))
    return Image.merge("RGB", chans)


# ---------------------------------------------------------------- 蒙版绘制

def _corner_mask(S):
    """圆角方形底：圆角之外为 0。"""
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, S - 1, S - 1], radius=TILE_RADIUS * S, fill=255
    )
    return m


def _card(d, cx, cy, edge, radius_ratio, fill=255):
    d.rounded_rectangle([cx - edge / 2, cy - edge / 2, cx + edge / 2, cy + edge / 2],
                        radius=edge * radius_ratio, fill=fill)


def _glyph_masks(S, preset):
    """
    返回 (前景蒙版, 后层蒙版)。

    卡片从后往前画，**每张开画之前先把它自己按 gap 外扩一圈、从两张蒙版上挖掉** ——
    这样每张卡的边界外都留出一圈底色，层层之间才有真正的分界。
    （反过来做"画完再用下一张的内缩形状挖"是无效的：下一张紧接着又把挖掉的地方填回去了。）
    """
    n, gap = preset["n"], preset["gap"]
    rr, shrink = preset["radius"], preset["shrink"]
    span_x = preset.get("span_x", preset.get("span", 0.0))
    span_y = preset.get("span_y", preset.get("span", 0.0))

    def edge_of(i):
        """第 i 张卡的边长（越靠后越小 —— shrink>0 时给出透视）。"""
        return S * preset["size"] * (1.0 - shrink * (n - 1 - i))

    centers = []
    for i in range(n):
        frac = 0.5 - i / (n - 1) if n > 1 else 0.0     # +1/2(最后) -> -1/2(最前)
        centers.append((0.5 + span_x * frac, 0.5 - span_y * frac))

    prim = Image.new("L", (S, S), 0)
    back = Image.new("L", (S, S), 0)
    dp, db = ImageDraw.Draw(prim), ImageDraw.Draw(back)

    for i, (cx, cy) in enumerate(centers):
        edge = edge_of(i)
        if i > 0:
            for d in (dp, db):
                _card(d, S * cx, S * cy, edge + S * gap * 2, rr, fill=0)
        _card(dp if i == n - 1 else db, S * cx, S * cy, edge, rr)

    k = preset["knockout"]
    if k:
        cx, cy = centers[-1]
        h = S * k
        head_h, head_w = h * 0.55, h * KEYHOLE_HEAD
        stub_w = head_w * KEYHOLE_ASPECT
        top = S * cy - h / 2.0
        dp.polygon([(S * cx, top),
                    (S * cx - head_w / 2, top + head_h),
                    (S * cx + head_w / 2, top + head_h)], fill=0)
        # 箭身与箭头重叠 1px，避免两者之间被抗锯齿磨出一道缝
        dp.rectangle([S * cx - stub_w / 2, top + head_h - 1,
                      S * cx + stub_w / 2, top + h], fill=0)

    return prim, back


# ---------------------------------------------------------------- 图标合成

def render(size, preset):
    """
    渲染一张 size x size 的 RGBA 图标。
    底色按最终尺寸算；圆角与内容蒙版按超采样倍数画好再降采样 —— 抗锯齿靠这个。
    后层用 Image.blend 按 back_alpha 把"白"混进底色：1.0 = 硬边纯白，
    小尺寸上缝隙细到抗锯齿都留不住时，改用 0.7 左右的色差来分层反而更清楚。
    """
    ss = preset.get("ss", 4)
    S = size * ss
    prim, back = _glyph_masks(S, preset)

    out = gradient_tile(size)
    # back_alpha=1.0 时这一句退化成"纯白"，分支不必特判（特判过一版，把后层整个丢了）
    soft = Image.blend(out, Image.new("RGB", (size, size), WHITE), preset["back_alpha"])
    out = Image.composite(soft, out, back.resize((size, size), Image.LANCZOS))
    out = Image.composite(Image.new("RGB", (size, size), WHITE), out,
                          prim.resize((size, size), Image.LANCZOS))

    out = out.convert("RGBA")
    out.putalpha(_corner_mask(S).resize((size, size), Image.LANCZOS))
    return out


# ---------------------------------------------------------------- ICO 组装

def dib_bytes(img):
    """
    把 RGBA 图编码成 ICO 内部使用的 DIB：
    BITMAPINFOHEADER(40) + 32bpp BGRA 自下而上的 XOR 位图 + 1bpp AND 掩码。
    """
    w, h = img.size
    px = img.load()

    header = struct.pack(
        "<IiiHHIIiiII",
        40,          # biSize
        w,           # biWidth
        h * 2,       # biHeight（XOR + AND 两段，故为 2 倍）
        1,           # biPlanes
        32,          # biBitCount
        0,           # biCompression = BI_RGB
        w * h * 4,   # biSizeImage
        0, 0, 0, 0,
    )

    rows = []
    for y in range(h - 1, -1, -1):
        row = bytearray()
        for x in range(w):
            r, g, b, a = px[x, y]
            row += bytes((b, g, r, a))      # BGRA
        rows.append(bytes(row))
    xor_bitmap = b"".join(rows)

    # AND 掩码：1 = 透明。32bpp 下 Windows 主要看 alpha，掩码写对更保险。
    stride = ((w + 31) // 32) * 4
    mask_rows = []
    for y in range(h - 1, -1, -1):
        bits = bytearray(stride)
        for x in range(w):
            if px[x, y][3] == 0:
                bits[x // 8] |= 0x80 >> (x % 8)
        mask_rows.append(bytes(bits))
    and_mask = b"".join(mask_rows)

    return header + xor_bitmap + and_mask


def write_ico(path, frames):
    """
    frames: [(size, PIL.Image)] —— 各尺寸可以是不同画稿。
    256 走 PNG 压缩（省体积），其余走 DIB（兼容性最好）。
    """
    entries = []
    offset = 6 + 16 * len(frames)
    for (size, img) in frames:
        if size >= 256:
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            blob = buf.getvalue()
        else:
            blob = dib_bytes(img)
        entries.append((size, blob))

    out = bytearray()
    out += struct.pack("<HHH", 0, 1, len(entries))     # reserved, type=icon, count
    for (size, blob) in entries:
        dim = 0 if size >= 256 else size               # 256 在目录里记 0
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    for (_, blob) in entries:
        out += blob

    with open(path, "wb") as f:
        f.write(bytes(out))
    return len(out)


# ---------------------------------------------------------------- 校验

def count_whitish_edges(img):
    """
    扫半透明过渡像素（1 <= alpha <= 254），统计其中"三通道都偏白"的数量。
    圆角外的过渡像素应该是底色（深蓝/青），偏白说明边缘混进了白底。
    """
    px = img.load()
    total = whitish = 0
    for y in range(img.size[1]):
        for x in range(img.size[0]):
            r, g, b, a = px[x, y]
            if 1 <= a <= 254:
                total += 1
                if r > 200 and g > 200 and b > 200:
                    whitish += 1
    return total, whitish


def corner_alphas(img):
    w, h = img.size
    px = img.load()
    return [px[x, y][3] for (x, y) in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]


# ---------------------------------------------------------------- 主流程

def arg_value(flag):
    """取 `--flag VALUE` 形式的值，没有这个开关就返回 None。"""
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    build_dir = arg_value("--out") or os.path.join(root, "build")
    os.makedirs(build_dir, exist_ok=True)

    print("frames:")
    frames = []
    for size in sorted(SIZE_PLAN):
        preset = SIZE_PLAN[size]
        img = render(size, preset)
        frames.append((size, img))
        print("  %3dpx  %-8s cards=%d gap=%.1fpx keyhole=%-5s corners=%s" % (
            size, preset["name"], preset["n"], preset["gap"] * 2 * size,
            bool(preset["knockout"]), corner_alphas(img)))

    master = render(MASTER_SIZE, DETAILED)
    png_path = os.path.join(build_dir, "icon.png")
    master.save(png_path)
    print("-> %s  %dx%d" % (png_path, *master.size))

    ico_path = os.path.join(build_dir, "icon.ico")
    nbytes = write_ico(ico_path, frames)
    print("-> %s  %d bytes  sizes=%s" % (
        ico_path, nbytes, [s for (s, _) in frames]))

    total, whitish = count_whitish_edges(master)
    print()
    print("白边扫描（主图 %d）：过渡像素 %d，偏白 %d（%.4f%%）" % (
        MASTER_SIZE, total, whitish, (100.0 * whitish / total) if total else 0.0))
    print("四角 alpha =", corner_alphas(master))

    if "--preview" in sys.argv:
        out = os.path.join(os.environ.get("TEMP", "/tmp"), "sfvm-icon")
        os.makedirs(out, exist_ok=True)
        for name, col in [("dark", (32, 32, 36)), ("light", (255, 255, 255)),
                          ("magenta", (255, 0, 255)), ("blue", (20, 60, 120))]:
            bg = Image.new("RGB", master.size, col)
            bg.paste(master, (0, 0), master)
            bg.resize((320, 320), Image.LANCZOS).save(os.path.join(out, "v5_%s.png" % name))

        tiles = []
        for (size, img) in frames:
            box = Image.new("RGB", (size, size), (32, 32, 36))
            box.paste(img, (0, 0), img)
            tiles.append(box.resize((110, 110), Image.LANCZOS))
        sheet = Image.new("RGB", (110 * len(tiles) + 8 * (len(tiles) - 1), 110), (90, 90, 90))
        for i, t in enumerate(tiles):
            sheet.paste(t, (i * 118, 0))
        sheet.save(os.path.join(out, "v5_sizes.png"))

        bg = Image.new("RGB", master.size, (32, 32, 36))
        bg.paste(master, (0, 0), master)
        bg.crop((0, 0, 240, 240)).resize((720, 720), Image.NEAREST).save(
            os.path.join(out, "v5_corner.png"))
        print("-> previews in", out)


if __name__ == "__main__":
    main()
