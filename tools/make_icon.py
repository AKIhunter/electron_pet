"""生成 build/icon.ico（应用图标）

取 assets/idle1/frame_00001.png → 裁掉四周透明边（角色原本仅占画布 ~72%）→
内容放大到 256 见方（electron-builder 要求图标 ≥256×256）→ 居中补透明边 →
多尺寸 ICO（256/128/64/48/32/16，Windows 各处自动选用）。
electron-builder 打包时自动拾取 build/icon.ico 作为 exe 图标。
用法：python tools/make_icon.py
"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "idle1", "frame_00001.png")
OUT_DIR = os.path.join(ROOT, "build")
OUT = os.path.join(OUT_DIR, "icon.ico")

SIDE = 256

img = Image.open(SRC).convert("RGBA")
bbox = img.getchannel("A").getbbox()  # alpha > 0 的包围盒
img = img.crop(bbox)

w, h = img.size
scale = SIDE / max(w, h)
img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
w, h = img.size

canvas = Image.new("RGBA", (SIDE, SIDE), (0, 0, 0, 0))
canvas.paste(img, ((SIDE - w) // 2, (SIDE - h) // 2))

os.makedirs(OUT_DIR, exist_ok=True)
canvas.save(OUT, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print(f"saved {OUT} (base {SIDE}x{SIDE})")
