# 桌宠抠图工具 (pet-matting)

把即梦、可灵等 AI 生成的**角色动作视频**，变成桌宠能直接用的**透明 PNG 帧序列 + GIF**。

```bash
python pet_matting.py idle.mp4 walk.mp4 drag.mp4 sleep.mp4 --out ./pet
```

```
pet/
├── idle/idle_0001.png …     每个动作一个文件夹（动作名 = 视频文件名）
├── idle.gif
├── walk/ walk.gif   drag/ drag.gif   sleep/ sleep.gif
└── meta.json                画布尺寸、每个动作的帧数/帧率/循环区间/脚底锚点
```

所有动作输出到**同一尺寸的画布**，角色位置对齐，桌宠切换动作时不会跳动。

## 它做了什么

1. **读视频**：mp4 / mov / webm，也支持 GIF 和图片文件夹；可用 `--fps` 改帧率。
2. **找循环点**：自动挑出最自然的首尾衔接区间并裁掉多余部分，让动作无缝循环。
3. **抠图**：默认用专门为二次元角色训练的 AI 模型（[SkyTNT anime-seg](https://huggingface.co/skytnt/anime-seg)，Apache-2.0），任意背景都能抠，头发、蕾丝边缘保留得比较好。
   - 背景是纯绿、纯蓝时，会额外挖掉被身体围住的背景空隙（手臂和身体之间等），并去掉边缘的绿边。
   - 背景是纯白、纯灰时，会去掉边缘混进去的背景色。
4. **清理**：去掉零碎噪点和小块残留；用前后帧平滑边缘，减少闪烁。
5. **统一画布输出**：PNG 序列、GIF、`meta.json`。

## 在 Mac 上安装

需要 Python 3（3.10 或以上更好）。终端里输入 `python3 --version` 能看到版本号就行；没有的话从 https://www.python.org 下载 macOS 安装包安装。

```bash
cd tools/pet-matting
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

国内网络 pip 慢的话，把最后一行换成：

```bash
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
```

**第一次运行**会自动下载抠图模型（约 170 MB，存到 `~/.cache/pet-matting/`）。下载慢或失败时，先设置镜像再运行：

```bash
export HF_ENDPOINT=https://hf-mirror.com
```

以后每次使用前，先进入目录并激活环境：

```bash
cd tools/pet-matting
source .venv/bin/activate
```

## 用法

```
python pet_matting.py <视频/GIF/图片文件夹>... [选项]
```

| 选项 | 作用 | 默认 |
|---|---|---|
| `--out <dir>` | 输出目录 | `pet_output` |
| `--fps <n>` | 输出帧率，桌宠常用 12 或 24，帧率越低文件越少 | 原视频帧率 |
| `--height <px>` | 把画布缩放到这个高度，例如 `300` | 不缩放 |
| `--loop auto\|full\|off` | `auto` 自动找循环区间；`full` 整段使用（首尾帧同图的视频选这个）；`off` 原样输出 | `auto` |
| `--min-loop <比例>` | `auto` 时循环至少保留原视频的比例 | `0.5` |
| `--mode ai\|chroma` | `chroma` 是传统色键抠图，只适合纯色背景，速度快但边缘较差 | `ai` |
| `--smooth <n>` | 边缘时间平滑半径，`0` 关闭 | `1` |
| `--gif-bg <#rrggbb>` | GIF 用实色背景（GIF 透明只有全透/不透两档，半透明边缘会变硬） | 透明 |
| `--no-gif` | 不生成 GIF | |
| `--model <path>` | 手动指定模型文件 `isnetis.onnx` | 自动下载 |

例子：

```bash
python pet_matting.py ~/Downloads/idle.mp4 ~/Downloads/sleep.mp4 --out ~/Desktop/pet --fps 12 --height 300
python pet_matting.py drag.mp4 --loop full --gif-bg "#ffffff"
```

## 用即梦生成视频的建议

- **背景**：提示词里写「纯绿色背景」「纯色背景」。纯绿背景时抠图最干净（会自动去绿边、挖空隙）；角色本身是绿色系时改用纯蓝或纯白背景。
- **循环**：用「首尾帧」功能，首帧和尾帧放**同一张图**，视频天然无缝循环，处理时加 `--loop full`。
- **镜头**：提示词里写「固定镜头，镜头不动」，角色**全身入画并四周留白**，不要被画面边缘切掉。
- **一致**：四个动作都从**同一张角色图**生成，并使用**相同的分辨率和画面比例**，这样各动作的位置和大小才能对齐。
- **走路**：写「原地踏步行走」，桌宠程序自己移动窗口；否则角色会走出画面。

## meta.json

```jsonc
{
  "width": 271, "height": 593,               // 画布尺寸（所有动作相同）
  "scale": 1.0,                               // --height 缩放比例
  "crop": { "x": 180, "y": 30, "width": 271, "height": 593 },  // 画布在原视频中的位置
  "actions": {
    "idle": {
      "frames": 96, "fps": 24.0,
      "loop": { "mode": "auto", "start": 12, "end": 108, "seamDiff": 0.05 },  // seamDiff 越小接缝越自然
      "anchor": { "x": 114, "y": 565 },       // 第一帧中脚底中心的位置，用来把角色放在桌面上
      "png": "idle/", "gif": "idle.gif"
    }
  }
}
```

## 说明

- 速度：CPU 上每帧约 1 秒（1024 分辨率推理）；5 秒的 24fps 视频约 2 分钟。先用 `--fps 12` 可以减半。
- 和标准透明图对比测试：AI 模式在纯色和复杂背景下与真实轮廓的重合度（IoU）约 98.6%–99.2%。
- 被身体围住的小块背景，在**复杂背景**下可能抠不干净；用纯色背景生成视频最稳。
- 这个抠图模型针对二次元角色训练，写实人物效果会差一些。
