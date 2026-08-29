# -*- coding: utf-8 -*-
"""对比连续截图，统计变化像素数 -> 验证宠物动画在推进。"""
import glob
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import cv2
import numpy as np

files = sorted(glob.glob(r"e:\Trae_Project\stitch_pet_electron\verify\shot*.png"))
if len(files) < 2:
    print("截图不足 2 张")
    sys.exit(1)
imgs = [cv2.imread(f) for f in files]
for f, im in zip(files, imgs):
    print(f"{f}: {None if im is None else im.shape}")
for i in range(len(imgs) - 1):
    a, b = imgs[i], imgs[i + 1]
    if a is None or b is None or a.shape != b.shape:
        print(f"shot{i+1}->shot{i+2}: 无法比较")
        continue
    d = np.abs(a.astype(int) - b.astype(int)).max(axis=2)
    changed = int((d > 12).sum())
    print(f"shot{i+1} -> shot{i+2}: 变化像素 {changed} ({changed / d.size * 100:.2f}%)"
          f"  {'动画推进中' if changed > 300 else '疑似静止'}")
