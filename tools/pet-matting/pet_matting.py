#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy", "opencv-python-headless", "onnxruntime", "pillow"]
# ///
"""
桌宠素材抠图工具：把 AI 生成的角色视频（即梦、可灵等）变成透明 PNG 帧序列 + GIF。

    python3 pet_matting.py idle.mp4 walk.mp4 drag.mp4 sleep.mp4 --out ./pet

每个输入文件是一个动作，动作名取文件名（idle.mp4 -> idle）。所有动作输出到同一尺寸的画布上，
角色位置对齐，桌宠程序切换动作时不会跳动。
"""
import argparse
import json
import os
import sys
import time
import urllib.request

import cv2
import numpy as np
from PIL import Image

MODEL_NAME = "isnetis.onnx"  # SkyTNT anime-seg (Apache-2.0), trained for anime characters
MODEL_PATH_IN_REPO = "skytnt/anime-seg/resolve/main/isnetis.onnx"
MODEL_SIZE = 1024
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


# ------------------------------------------------------------------ input

def read_frames(path, fps_out):
    """Return (frames as RGB uint8 arrays, fps). Accepts a video, a GIF, or a folder of images."""
    if os.path.isdir(path):
        files = sorted(f for f in os.listdir(path) if f.lower().endswith(IMAGE_EXT))
        if not files:
            raise SystemExit(f"错误: 文件夹里没有图片: {path}")
        frames = [np.array(Image.open(os.path.join(path, f)).convert("RGB")) for f in files]
        return frames, fps_out or 24.0
    if path.lower().endswith(".gif"):
        im = Image.open(path)
        frames, durs = [], []
        for k in range(getattr(im, "n_frames", 1)):
            im.seek(k)
            frames.append(np.array(im.convert("RGB")))
            durs.append(im.info.get("duration", 42) or 42)
        src_fps = 1000.0 / (sum(durs) / len(durs))
        return resample(frames, src_fps, fps_out), fps_out or src_fps
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit(f"错误: 打不开视频: {path}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    frames = []
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    cap.release()
    if not frames:
        raise SystemExit(f"错误: 视频里没有读到帧: {path}")
    return resample(frames, src_fps, fps_out), fps_out or src_fps


def resample(frames, src_fps, fps_out):
    if not fps_out or abs(fps_out - src_fps) < 0.01:
        return frames
    n = int(len(frames) * fps_out / src_fps + 0.5)
    return [frames[min(len(frames) - 1, int(k * src_fps / fps_out + 0.5))] for k in range(max(1, n))]


# ------------------------------------------------------------------ loop detection

def find_loop(frames, min_ratio):
    """Pick start i and end j (exclusive) so that frame j looks like frame i: frames[i:j] then loops seamlessly.
    Returns (i, j, score); score = mean abs difference (0-255) between frame i and frame j."""
    small = [cv2.resize(cv2.cvtColor(f, cv2.COLOR_RGB2GRAY), (64, 64), interpolation=cv2.INTER_AREA).astype(np.float32)
             for f in frames]
    n = len(small)
    min_len = max(4, int(n * min_ratio))
    best = (0, n, float("inf"))
    for i in range(0, max(1, n // 3)):
        for j in range(i + min_len, n):
            d = float(np.mean(np.abs(small[i] - small[j])))
            # prefer longer loops when the seams are about as good
            score = d - 0.002 * (j - i)
            if score < best[2]:
                best = (i, j, score)
    i, j, _ = best
    if j >= n:
        return 0, n, None
    return i, j, float(np.mean(np.abs(small[i] - small[j])))


# ------------------------------------------------------------------ matting

def model_path(arg):
    if arg:
        return arg
    cache = os.path.join(os.path.expanduser("~"), ".cache", "pet-matting")
    path = os.path.join(cache, MODEL_NAME)
    if os.path.exists(path) and os.path.getsize(path) > 100_000_000:
        return path
    os.makedirs(cache, exist_ok=True)
    endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
    url = f"{endpoint}/{MODEL_PATH_IN_REPO}"
    print(f"首次使用，下载抠图模型 (约 170 MB): {url}")
    print("  (国内网络慢可先设置: export HF_ENDPOINT=https://hf-mirror.com)")
    tmp = path + ".part"
    try:
        with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
            total = int(r.headers.get("content-length") or 0)
            got = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if total:
                    print(f"\r  {got / total * 100:5.1f}%", end="", flush=True)
        print()
        os.replace(tmp, path)
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"错误: 模型下载失败 ({e})。可手动下载 {url} 后用 --model 指定路径")
    return path


class AnimeSeg:
    def __init__(self, path):
        import onnxruntime as ort
        avail = ort.get_available_providers()
        prefer = [p for p in ("CUDAExecutionProvider", "CoreMLExecutionProvider") if p in avail]
        try:
            self.sess = ort.InferenceSession(path, providers=prefer + ["CPUExecutionProvider"])
        except Exception:  # noqa: BLE001  (an accelerator that cannot run the graph)
            self.sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])

    def __call__(self, rgb):
        s = MODEL_SIZE
        h0, w0 = rgb.shape[:2]
        h, w = (s, int(s * w0 / h0)) if h0 > w0 else (int(s * h0 / w0), s)
        ph, pw = s - h, s - w
        inp = np.zeros((s, s, 3), np.float32)
        inp[ph // 2:ph // 2 + h, pw // 2:pw // 2 + w] = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA) / 255.0
        pred = self.sess.run(None, {"img": inp.transpose(2, 0, 1)[None]})[0][0, 0]
        pred = pred[ph // 2:ph // 2 + h, pw // 2:pw // 2 + w]
        return np.clip(cv2.resize(pred, (w0, h0), interpolation=cv2.INTER_LINEAR), 0, 1)


def border_color(rgb):
    """Median colour of the frame border and whether the border is a plain, solid background."""
    b = np.concatenate([rgb[:4].reshape(-1, 3), rgb[-4:].reshape(-1, 3), rgb[:, :4].reshape(-1, 3), rgb[:, -4:].reshape(-1, 3)])
    med = np.median(b, axis=0)
    spread = float(np.median(np.abs(b.astype(np.float32) - med).sum(axis=1)))
    return med.astype(np.float32), spread < 18


def chroma_alpha(rgb, key, tol, soft):
    """Alpha from the chroma (CbCr) distance to the key colour."""
    ycc = cv2.cvtColor(rgb, cv2.COLOR_RGB2YCrCb).astype(np.float32)
    k = cv2.cvtColor(np.uint8([[key]]), cv2.COLOR_RGB2YCrCb).astype(np.float32)[0, 0]
    d = np.sqrt((ycc[..., 1] - k[1]) ** 2 + (ycc[..., 2] - k[2]) ** 2)
    return np.clip((d - tol) / max(soft, 1e-3), 0, 1)


def is_chromatic(c):
    """A coloured screen (green / blue / magenta ...), as opposed to white, grey or black."""
    return float(np.max(c) - np.min(c)) > 60


def decontaminate(rgb, alpha, bg):
    """Remove a neutral background colour mixed into semi-transparent edge pixels: F = (C - (1-a)B) / a.
    The alpha is clamped so that small alpha errors are not amplified into coloured fringes."""
    a = alpha[..., None]
    c = rgb.astype(np.float32)
    f = (c - (1 - a) * bg) / np.maximum(a, 0.35)
    edge = (alpha > 0.02) & (alpha < 0.98)
    out = c.copy()
    out[edge] = np.clip(f[edge], 0, 255)
    return out.astype(np.uint8)


def despill(rgb, key, alpha=None):
    """Pull the dominant key channel (e.g. green) down to the max of the others, on edge pixels only
    when an alpha is given (solid interiors keep their real colours, e.g. green clothes)."""
    ch = int(np.argmax(key))
    others = [c for c in range(3) if c != ch]
    out = rgb.copy()
    lim = np.maximum(rgb[..., others[0]], rgb[..., others[1]])
    fixed = np.minimum(rgb[..., ch], lim)
    if alpha is None:
        out[..., ch] = fixed
    else:
        edge = alpha < 0.98
        out[..., ch] = np.where(edge, fixed, rgb[..., ch])
    return out


def clean_alpha(alpha, min_island):
    """Drop faint noise and small detached blobs (stray background bits)."""
    alpha = np.where(alpha < 0.04, 0, alpha)
    solid = (alpha > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(cv2.dilate(solid, np.ones((5, 5), np.uint8)), connectivity=8)
    if n > 2:
        areas = stats[1:, cv2.CC_STAT_AREA]
        keep = np.zeros(n, bool)
        keep[1:] = areas >= max(areas.max() * min_island, 16)
        alpha = alpha * keep[lab]
    return alpha.astype(np.float32)


def matte_sequence(frames, args, seg):
    alphas = []
    bg, solid = border_color(frames[0])
    key = None
    if args.mode == "chroma":
        key = np.array(hex_rgb(args.key), np.float32) if args.key else bg
    for k, rgb in enumerate(frames):
        if args.mode == "chroma":
            a = chroma_alpha(rgb, key, args.tolerance, args.softness)
        else:
            a = seg(rgb)
            if solid and is_chromatic(bg):
                # green/blue screen: also cut out background pockets the model kept (gaps between arms and body)
                a = np.minimum(a, chroma_alpha(rgb, bg, 10, 14))
        alphas.append(clean_alpha(a, args.min_island))
        if (k + 1) % 10 == 0 or k + 1 == len(frames):
            print(f"\r  抠图 {k + 1}/{len(frames)}", end="", flush=True)
    print()
    if args.smooth > 0:
        alphas = temporal_smooth(alphas, args.smooth, args.loop != "off")
    out = []
    for rgb, a in zip(frames, alphas):
        if args.mode == "chroma" or (solid and is_chromatic(bg)):
            rgb = despill(rgb, key if key is not None else bg, a)
        elif solid:
            rgb = decontaminate(rgb, a, bg)
        out.append(np.dstack([rgb, (a * 255 + 0.5).astype(np.uint8)]))
    return out, (args.mode == "chroma" or solid), bg


def temporal_smooth(alphas, radius, wrap):
    """Median over neighbouring frames, which removes edge flicker without smearing motion much."""
    n = len(alphas)
    if n < 3:
        return alphas
    out = []
    for t in range(n):
        idx = [t + d for d in range(-radius, radius + 1)]
        idx = [(i % n) if wrap else min(max(i, 0), n - 1) for i in idx]
        out.append(np.median(np.stack([alphas[i] for i in idx]), axis=0).astype(np.float32))
    return out


# ------------------------------------------------------------------ output

def hex_rgb(s):
    s = s.lstrip("#")
    if len(s) != 6:
        raise SystemExit(f"错误: 颜色格式应为 #rrggbb: {s}")
    return [int(s[i:i + 2], 16) for i in (0, 2, 4)]


def save_gif(rgba_frames, path, fps, bg):
    dur = max(20, int(round(100 / fps)) * 10)
    pal = []
    for f in rgba_frames:
        if bg:
            im = Image.new("RGBA", (f.shape[1], f.shape[0]), tuple(bg) + (255,))
            im.alpha_composite(Image.fromarray(f, "RGBA"))
            pal.append(im.convert("RGB").quantize(256, method=Image.Quantize.MEDIANCUT))
        else:
            rgb = Image.fromarray(np.ascontiguousarray(f[..., :3]), "RGB").quantize(255, method=Image.Quantize.MEDIANCUT)
            idx = np.array(rgb)
            idx[f[..., 3] < 128] = 255
            p = Image.fromarray(idx, "P")
            palette = rgb.getpalette()[:255 * 3]
            p.putpalette(palette + [0] * (768 - len(palette)))
            p.info["transparency"] = 255
            pal.append(p)
    kw = {} if bg else {"transparency": 255, "disposal": 2}
    pal[0].save(path, save_all=True, append_images=pal[1:], duration=dur, loop=0, optimize=False, **kw)


def main():
    ap = argparse.ArgumentParser(description="把角色视频抠成透明 PNG 帧序列 + GIF（桌宠素材）")
    ap.add_argument("inputs", nargs="+", help="视频 (mp4/mov/webm)、GIF 或图片文件夹；每个是一个动作，动作名取文件名")
    ap.add_argument("--out", default="pet_output", help="输出目录 (默认 pet_output)")
    ap.add_argument("--mode", choices=["ai", "chroma"], default="ai",
                    help="ai: 二次元专用 AI 抠图，任意背景 (默认)；chroma: 色键抠图，只适合纯色背景，速度快")
    ap.add_argument("--key", help="chroma 模式的背景色 #rrggbb，默认自动取画面边缘颜色")
    ap.add_argument("--tolerance", type=float, default=18, help="chroma 模式: 与背景色多接近算背景 (默认 18)")
    ap.add_argument("--softness", type=float, default=22, help="chroma 模式: 边缘过渡宽度 (默认 22)")
    ap.add_argument("--fps", type=float, default=0, help="输出帧率，例如 12 (默认保持原视频帧率)")
    ap.add_argument("--loop", choices=["auto", "off", "full"], default="auto",
                    help="auto: 自动找最自然的循环区间并裁剪 (默认)；full: 整段使用并去掉与首帧重复的尾帧；off: 原样输出")
    ap.add_argument("--min-loop", type=float, default=0.5, help="auto 循环至少保留原视频的比例 (默认 0.5)")
    ap.add_argument("--smooth", type=int, default=1, help="抠图边缘的时间平滑半径，0 关闭 (默认 1)")
    ap.add_argument("--min-island", type=float, default=0.02, help="去掉面积小于主体该比例的零碎小块 (默认 0.02)")
    ap.add_argument("--height", type=int, default=0, help="把画布缩放到这个高度像素 (默认不缩放)")
    ap.add_argument("--pad", type=int, default=6, help="画布四周留白像素 (默认 6)")
    ap.add_argument("--gif-bg", default="transparent", help="GIF 背景: transparent (默认) 或 #rrggbb")
    ap.add_argument("--no-gif", action="store_true", help="不生成 GIF")
    ap.add_argument("--model", help="抠图模型 isnetis.onnx 的本地路径 (默认自动下载到 ~/.cache/pet-matting)")
    args = ap.parse_args()

    for p in args.inputs:
        if not os.path.exists(p):
            raise SystemExit(f"错误: 找不到输入: {p}")
    seg = AnimeSeg(model_path(args.model)) if args.mode == "ai" else None
    gif_bg = None if args.gif_bg == "transparent" else hex_rgb(args.gif_bg)

    actions = []
    for p in args.inputs:
        name = os.path.splitext(os.path.basename(p.rstrip("/")))[0]
        t0 = time.time()
        frames, fps = read_frames(p, args.fps)
        print(f"▶ {name}: {len(frames)} 帧, {fps:g} fps")
        loop = {"mode": args.loop}
        if args.loop == "auto" and len(frames) > 8:
            i, j, score = find_loop(frames, args.min_loop)
            frames = frames[i:j]
            loop.update(start=i, end=j, seamDiff=None if score is None else round(score, 2))
            print(f"  循环区间: 第 {i + 1}–{j} 帧 (接缝差异 {score:.1f}，越小越自然；>12 可能看得出跳变)" if score is not None
                  else "  未找到合适的循环点，使用整段")
        elif args.loop == "full" and len(frames) > 3:
            # drop the last frame only if it is a duplicate of the first (首尾帧同图), i.e. far closer to it
            # than neighbouring frames are to each other
            g = [cv2.resize(f, (96, 96), interpolation=cv2.INTER_AREA).astype(np.float32) for f in frames]
            step = float(np.median([np.mean(np.abs(g[k + 1] - g[k])) for k in range(len(g) - 1)]))
            last = float(np.mean(np.abs(g[-1] - g[0])))
            if last < 0.7 * step or last < 0.35:  # 0.35: video compression noise between identical frames
                frames = frames[:-1]
        rgba, solid_bg, bgc = matte_sequence(frames, args, seg)
        actions.append({"name": name, "fps": fps, "frames": rgba, "loop": loop, "source": p, "solidBg": solid_bg,
                        "time": time.time() - t0})

    # one canvas for every action: union of the visible area, so the character never jumps between actions
    box = None
    for a in actions:
        for f in a["frames"]:
            ys, xs = np.nonzero(f[..., 3] > 5)
            if len(xs):
                b = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
                box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    if box is None:
        raise SystemExit("错误: 所有帧都没有抠出角色，请检查视频或换 --mode")
    sizes = {a["frames"][0].shape[:2] for a in actions}
    if len(sizes) > 1:
        print(f"⚠ 各视频分辨率不同 {sorted(sizes)}，画布按最大范围对齐，建议用同一分辨率生成所有动作")
    H0 = max(s[0] for s in sizes)
    W0 = max(s[1] for s in sizes)
    pad = args.pad
    x0, y0 = max(0, box[0] - pad), max(0, box[1] - pad)
    x1, y1 = min(W0, box[2] + pad), min(H0, box[3] + pad)
    scale = args.height / (y1 - y0) if args.height else 1.0
    W, H = int(round((x1 - x0) * scale)), int(round((y1 - y0) * scale))

    os.makedirs(args.out, exist_ok=True)
    meta = {"width": W, "height": H, "scale": round(scale, 4),
            # where the canvas was cut from the source video (before scaling)
            "crop": {"x": int(x0), "y": int(y0), "width": int(x1 - x0), "height": int(y1 - y0)},
            "actions": {}}
    for a in actions:
        n = a["name"]
        d = os.path.join(args.out, n)
        os.makedirs(d, exist_ok=True)
        out = []
        for k, f in enumerate(a["frames"]):
            c = np.zeros((H0, W0, 4), np.uint8)
            c[:f.shape[0], :f.shape[1]] = f
            c = c[y0:y1, x0:x1]
            if scale != 1.0:
                # resize premultiplied so edges do not pick up dark/bright fringes
                pm = c.astype(np.float32)
                pm[..., :3] *= pm[..., 3:] / 255.0
                pm = cv2.resize(pm, (W, H), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
                al = np.clip(pm[..., 3:], 0, 255)
                rgb = np.where(al > 0, pm[..., :3] * 255.0 / np.maximum(al, 1e-3), 0)
                c = np.dstack([np.clip(rgb, 0, 255), al]).astype(np.uint8)
            out.append(c)
            Image.fromarray(c, "RGBA").save(os.path.join(d, f"{n}_{k + 1:04d}.png"), optimize=False)
        if not args.no_gif:
            save_gif(out, os.path.join(args.out, f"{n}.gif"), a["fps"], gif_bg)
        # feet anchor: bottom of the opaque area in the first frame, horizontally its centre
        ys, xs = np.nonzero(out[0][..., 3] > 128)
        anchor = {"x": int((xs.min() + xs.max()) / 2), "y": int(ys.max())} if len(xs) else None
        meta["actions"][n] = {"frames": len(out), "fps": round(a["fps"], 3), "loop": a["loop"],
                              "anchor": anchor, "source": os.path.basename(a["source"]),
                              "png": f"{n}/", "gif": None if args.no_gif else f"{n}.gif"}
        print(f"  ✓ {n}: {len(out)} 帧 → {d}  ({a['time']:.1f}s)")
    with open(os.path.join(args.out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"完成: 画布 {W}×{H}，{len(actions)} 个动作 → {args.out}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
