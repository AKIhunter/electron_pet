# -*- coding: utf-8 -*-
"""
Electron 桌宠动作帧预处理 v2（修复奔跑失真）
================================================
问题：v1 对每帧独立 bbox 归一化，奔跑帧角色 bbox 天然波动 -> 逐帧缩放脉动（失真）。
方案：同一动作所有帧共用【固定 scale + 固定平移】：
  1. 每帧取前景 mask（不透明源洪泛抠图；已透明源取 alpha 最大连通域去尘埃）
  2. 全帧 union bbox -> scale = min(H_TARGET/uh, W_MAX/uw)
  3. union bbox 底部中心 -> 画布锚点 (128, 254)，整帧按固定 scale 缩放、固定偏移粘贴
     -> 帧间零相对位移，源动画逐帧对齐原样保留
输出: assets/<action>/frame_0000N.png (256x256 RGBA) + meta.json(含帧数) + _preview.png
运行: python tools/preprocess.py

v3（绿残留修复）：
  - 强绿剔除：g 同时超过 r+40 与 b+40（且 g>60）的像素视为绿幕残留，从前景 mask
    剔除后再取最大连通域 —— 切断角色脚下绿幕与角色的连通（wave 幕布）、
    消除绿幕源（idle2 第3帧起为纯绿背景）轮廓上的绿色过渡带
  - despill：轻度绿溢出（g > max(r,b)+12）压回 max(r,b)，修掉边缘发绿
"""
import os
import sys
import glob
import io
import json

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import numpy as np
import cv2
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
OUT = os.path.join(ROOT, "assets")

CANVAS = 256            # 输出画布
H_TARGET = 190          # 角色目标高度（跨动作统一）
W_MAX = 240             # 角色最大宽度（防溢出画布）
ANCHOR_OUT = (128, 254) # 画布内底部中心锚点
BG_TOL = 26.0           # 背景色容差（洪泛）
EDGE_RAMP = 2.0         # 软边缘宽度
GREEN_EXCESS = 40       # 强绿判定：g-r 与 g-b 均超过此值
GREEN_MIN = 60          # 强绿判定最低 g 亮度（保护暗部角色色）
DESPILL_EXCESS = 12     # 轻度绿溢出判定：g 超过 max(r,b) 此值

ACTIONS = ["wave", "drag", "run", "idle1", "idle2", "review1", "review2"]


# ---------------------------------------------------------------- 绿处理
def strong_green_mask(bgr):
    """强绿像素（绿幕/绿幕过渡带）：g 同时明显超过 r 和 b。角色蓝/青色 b 高、
    粉色 r 高，均不满足；牙齿淡黄 g-r 大但 g-b 小，也不满足。"""
    b = bgr[..., 0].astype(np.int32)
    g = bgr[..., 1].astype(np.int32)
    r = bgr[..., 2].astype(np.int32)
    return (g > r + GREEN_EXCESS) & (g > b + GREEN_EXCESS) & (g > GREEN_MIN)


def despill(rgba):
    """轻度绿溢出校正：仅 g 明显超过 max(r,b) 的像素把 g 压回 max(r,b)。"""
    b = rgba[..., 0].astype(np.int32)
    g = rgba[..., 1].astype(np.int32)
    r = rgba[..., 2].astype(np.int32)
    spill = (g > np.maximum(r, b) + DESPILL_EXCESS) & (rgba[..., 3] > 0)
    if not spill.any():
        return rgba
    out = rgba.copy()
    gv = out[..., 1]
    gv[spill] = np.maximum(r, b)[spill]
    return out


# ---------------------------------------------------------------- 前景提取
def cutout(bgra):
    """不透明源：洪泛抠背景。返回 fg bool mask（未取连通域）。"""
    bgr = bgra[..., :3]
    edge = np.concatenate([bgr[0], bgr[-1], bgr[:, 0], bgr[:, -1]])
    bg = np.median(edge.reshape(-1, 3), axis=0)
    dist = np.linalg.norm(bgr.astype(np.float32) - bg.astype(np.float32), axis=2)
    bglike = dist < BG_TOL
    lab, _ = ndimage.label(bglike)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    border.discard(0)
    bgmask = np.isin(lab, list(border)) if border else np.zeros_like(bglike)
    fg = ~bgmask
    return fg


def largest_cc(mask):
    """只保留最大连通域（去签名/尘埃等游离杂点）。"""
    lab, n = ndimage.label(mask)
    if n <= 1:
        return mask
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (1 + int(np.argmax(sizes)))


def soft_alpha(fg):
    """几何距离变换软边缘 alpha。"""
    dt = cv2.distanceTransform(fg.astype(np.uint8), cv2.DIST_L2, 3)
    return np.clip((dt - 1.0) / EDGE_RAMP, 0.0, 1.0)


# ---------------------------------------------------------------- 变换
def resize_premult(rgba, nw, nh):
    """预乘 alpha 双线性缩放（避免半透明边缘变色）。"""
    a = rgba[..., 3].astype(np.float32) / 255.0
    pm = rgba[..., :3].astype(np.float32) * a[..., None]
    pm2 = cv2.resize(pm, (nw, nh), interpolation=cv2.INTER_LINEAR)
    a2 = np.clip(cv2.resize(a, (nw, nh), interpolation=cv2.INTER_LINEAR), 0, 1)
    out = np.zeros((nh, nw, 4), np.float32)
    safe = np.maximum(a2, 1e-4)[..., None]
    out[..., :3] = np.where(a2[..., None] > 0.004, pm2 / safe, 0)
    out[..., 3] = a2 * 255
    return np.clip(out, 0, 255).astype(np.uint8)


def paste(canvas, img, px, py):
    """把 img 粘贴到 canvas 的 (px,py)，越界部分裁剪（只可能是透明边缘）。"""
    sh, sw = img.shape[:2]
    sx0, sy0 = max(0, -px), max(0, -py)
    dx0, dy0 = max(0, px), max(0, py)
    dx1, dy1 = min(CANVAS, px + sw), min(CANVAS, py + sh)
    if dx1 > dx0 and dy1 > dy0:
        canvas[dy0:dy1, dx0:dx1] = img[sy0:sy0 + (dy1 - dy0), sx0:sx0 + (dx1 - dx0)]


# ---------------------------------------------------------------- 主流程
def process_action(act):
    src_dir = None
    for cand in ("frames", "matted_frames"):
        p = os.path.join(RAW, act, cand)
        if os.path.isdir(p):
            src_dir = p
            break
    if not src_dir:
        print(f"[跳过] {act}: 无素材目录")
        return None
    pngs = sorted(glob.glob(os.path.join(src_dir, "*.png")))
    if not pngs:
        print(f"[跳过] {act}: 无 png")
        return None

    frames = []
    for p in pngs:
        f = cv2.imread(p, cv2.IMREAD_UNCHANGED)
        if f is None:
            raise RuntimeError(f"读取失败: {p}")
        if f.ndim != 3 or f.shape[2] != 4:
            f = cv2.cvtColor(f, cv2.COLOR_BGR2BGRA)
        frames.append(f)

    need_cutout = (frames[0][..., 3] > 8).mean() > 0.95  # 不透明背景需抠图

    # 1) 每帧前景 mask：洪泛/alpha -> 剔除强绿 -> 最大连通域
    #    （强绿剔除后脚下绿幕与角色断开，被最大连通域丢弃；绿幕源轮廓过渡带同理）
    def fg_mask(f):
        raw = cutout(f) if need_cutout else (f[..., 3] > 8)
        return largest_cc(raw & ~strong_green_mask(f[..., :3]))

    masks = [fg_mask(f) for f in frames]
    green_px = [int(strong_green_mask(f[..., :3]).sum()) for f in frames]

    # 2) 全帧 union bbox
    X0, Y0, X1, Y1 = [], [], [], []
    for m in masks:
        ys, xs = np.where(m)
        X0.append(xs.min()); Y0.append(ys.min()); X1.append(xs.max()); Y1.append(ys.max())
    ux0, uy0, ux1, uy1 = min(X0), min(Y0), max(X1), max(Y1)
    uw, uh = ux1 - ux0 + 1, uy1 - uy0 + 1

    # 3) 固定 scale（角色高归一 H_TARGET，宽上限 W_MAX）
    scale = min(H_TARGET / uh, W_MAX / uw)

    # 4) 固定平移：union 底部中心 -> ANCHOR_OUT
    H, W = frames[0].shape[:2]
    nw, nh = max(1, int(round(W * scale))), max(1, int(round(H * scale)))
    ucx, uby = (ux0 + ux1) / 2.0, uy1
    px = int(round(ANCHOR_OUT[0] - ucx * scale))
    py = int(round(ANCHOR_OUT[1] - uby * scale))

    out_dir = os.path.join(OUT, act)
    os.makedirs(out_dir, exist_ok=True)
    first_frame = None
    for i, f in enumerate(frames, 1):
        if need_cutout:
            rgba = np.dstack([f[..., :3], (soft_alpha(masks[i - 1]) * 255).astype(np.uint8)])
        else:
            rgba = f.copy()
            rgba[..., 3][~masks[i - 1]] = 0  # 去尘埃
        rgba = despill(rgba)
        scaled = resize_premult(rgba, nw, nh)
        canvas = np.zeros((CANVAS, CANVAS, 4), np.uint8)
        paste(canvas, scaled, px, py)
        cv2.imwrite(os.path.join(out_dir, f"frame_{i:05d}.png"), canvas)
        if i == 1:
            first_frame = canvas

    print(f"[{act}] 帧数={len(pngs)} 抠图={'是' if need_cutout else '否'} "
          f"union={uw}x{uh} scale={scale:.4f} 平移=({px},{py}) "
          f"角色≈{int(round(uw*scale))}x{int(round(uh*scale))} "
          f"剔绿={max(green_px)}px(最多帧)")
    return {"frames": len(pngs), "cutout": bool(need_cutout), "scale": round(scale, 6)}


def build_preview(cells):
    cols, rows, cell = 4, 2, 200
    sheet = np.zeros((rows * cell + (rows + 1) * 8, cols * cell + (cols + 1) * 8, 3), np.uint8)
    for i in range(0, sheet.shape[0], 16):
        for j in range(0, sheet.shape[1], 16):
            sheet[i:i + 16, j:j + 16] = 60 if ((i // 16 + j // 16) % 2 == 0) else 90
    for idx, (act, frame) in enumerate(cells.items()):
        if idx >= rows * cols:
            break
        r, c = idx // cols, idx % cols
        y0, x0 = 8 + r * (cell + 8), 8 + c * (cell + 8)
        small = cv2.resize(frame, (cell, cell), interpolation=cv2.INTER_AREA)
        alpha = small[..., 3:].astype(np.float32) / 255.0
        fg = small[..., :3].astype(np.float32)
        bg = sheet[y0:y0 + cell, x0:x0 + cell].astype(np.float32)
        sheet[y0:y0 + cell, x0:x0 + cell] = (fg * alpha + bg * (1 - alpha)).astype(np.uint8)
    cv2.imwrite(os.path.join(OUT, "_preview.png"), sheet)
    print("[预览] assets/_preview.png 已生成")


def main():
    os.makedirs(OUT, exist_ok=True)
    summary = {}
    firsts = {}
    for act in ACTIONS:
        info = process_action(act)
        if info:
            summary[act] = info
            p = os.path.join(OUT, act, "frame_00001.png")
            firsts[act] = cv2.imread(p, cv2.IMREAD_UNCHANGED)
    meta = {
        "canvas": CANVAS,
        "h_target": H_TARGET,
        "w_max": W_MAX,
        "anchor": list(ANCHOR_OUT),
        "actions": summary,
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("\n[完成] assets/meta.json:", json.dumps(summary, ensure_ascii=False))
    build_preview(firsts)


if __name__ == "__main__":
    main()