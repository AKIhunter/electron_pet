# -*- coding: utf-8 -*-
"""校验输出帧：帧数、角色 bbox 帧间抖动（稳定性）、run 序列拼图。"""
import os
import sys
import io
import glob

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import numpy as np
import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets")
ACTIONS = ["wave", "drag", "run", "idle1", "idle2", "review1", "review2"]


def bbox_stats(act):
    files = sorted(glob.glob(os.path.join(OUT, act, "frame_*.png")))
    if not files:
        return None, []
    boxes = []
    for fp in files:
        a = cv2.imread(fp, cv2.IMREAD_UNCHANGED)[..., 3]
        ys, xs = np.where(a > 8)
        if len(xs) == 0:
            boxes.append((np.nan,) * 4)
            continue
        boxes.append((xs.min(), ys.min(), xs.max(), ys.max()))
    arr = np.array(boxes, float)
    return files, arr


def main():
    print(f"{'动作':<8}{'帧数':>4}{'x中心std':>9}{'底部y std':>9}{'宽std':>7}{'高std':>7}  说明")
    for act in ACTIONS:
        files, arr = bbox_stats(act)
        if not files:
            print(f"{act:<8}    0  —— 缺帧")
            continue
        cx = (arr[:, 0] + arr[:, 2]) / 2
        by = arr[:, 3]
        w = arr[:, 2] - arr[:, 0]
        h = arr[:, 3] - arr[:, 1]
        print(f"{act:<8}{len(files):>4}{cx.std():>9.1f}{by.std():>9.1f}{w.std():>7.1f}{h.std():>7.1f}"
              f"  中心/底部漂移=角色位置稳定性，宽高波动=姿态自然形变")

    # run 序列拼图：每 3 帧取 1，检查连续性与对齐
    files, _ = bbox_stats("run")
    picks = files[::3][:12]
    cell = 128
    sheet = np.full((2 * cell, 6 * cell, 3), 255, np.uint8)
    for i, fp in enumerate(picks):
        img = cv2.imread(fp, cv2.IMREAD_UNCHANGED)
        small = cv2.resize(img, (cell, cell), interpolation=cv2.INTER_AREA)
        r, c = divmod(i, 6)
        a = small[..., 3:].astype(np.float32) / 255.0
        fg = small[..., :3].astype(np.float32)
        sheet[r * cell:(r + 1) * cell, c * cell:(c + 1) * cell] = (fg * a + 255 * (1 - a)).astype(np.uint8)
    p = os.path.join(OUT, "_run_sheet.png")
    cv2.imwrite(p, sheet)
    print(f"\n[拼图] {p}（run 每 3 帧取 1，共 {len(picks)} 格）")


if __name__ == "__main__":
    main()
