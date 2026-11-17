# 精灵动作帧导出工具 (frame-exporter)

把《赛尔号》页游精灵对战动画（Petdoctor 加载的同一个 SWF）里的**每个动作**导出成 **PNG 帧序列** 和 **GIF**。

```
node export.mjs 1 3000 --out ./frames
```

```
frames/1/
├── attack/attack_0001.png … attack_0065.png   物理攻击
├── attack.gif
├── sa/  sa.gif                                 特殊攻击
├── cp/  cp.gif                                 属性攻击
├── hited/  hited.gif                           受击
└── meta.json                                   帧率、每个动作的帧数/尺寸/注册点/命中帧
```

## 原理

精灵动画 SWF（`https://seer.61.com/resource/fightResource/pet/swf/<序号>.swf`）导出一个 `pet` 类，
它的主时间轴用帧标签区分动作：`attack` / `sa` / `cp` / `hited`，部分精灵还有 `appear`、`attack1`、`hidemove` 等。

工具与 Petdoctor 的 `FightPanel` 播放方式一致：`pet.gotoAndStop(标签)`，下一帧对动作剪辑 `getChildAt(0).gotoAndPlay(1)`，
一直播放到该剪辑最后一帧。播放在 [Ruffle](https://ruffle.rs)（Flash 模拟器）里进行，运行于无头 Chromium，
由一个很小的包装 SWF（`src/Exporter.hx`，已编译为 `bin/exporter.swf`）每帧用 `BitmapData.draw` 截图。
所以帧脚本、嵌套剪辑、滤镜、混合模式都按游戏里的方式实际执行，而不是静态解析时间轴。

## 安装

需要 Node.js ≥ 18（在代理后使用需 ≥ 22.21）。

```bash
cd tools/frame-exporter
npm install
npx playwright install chromium
```

## 用法

```
node export.mjs <精灵序号 | 本地.swf>... [选项]
```

| 选项 | 说明 |
| --- | --- |
| `--out <dir>` | 输出目录，默认 `./output` |
| `--labels a,b` | 只导出这些动作，默认全部帧标签。最外层没有帧标签的 SWF（比如地图上的 NoNo，方向标签在内层的身体和配色图层上；或者最外层是不带时间轴的容器）会改用内层剪辑的帧标签，几个内层剪辑一起跳到同一个标签播放；哪里都没有标签的单段动画导出为 `play` |
| `--format png,gif` | 输出格式，默认两种都要 |
| `--scale <n>` | 渲染倍数，默认 1；矢量精灵用 `2` 可得高清帧 |
| `--canvas action\|pet` | `action`（默认）：每个动作单独裁剪画布；`pet`：同一精灵所有动作共用画布，方便对齐 |
| `--gif-bg <color>` | GIF 背景，默认 `transparent`（GIF 只有 1 位透明，半透明边缘会变硬）；可用 `#ffffff` 等实色 |
| `--render-bg <color>` | 在实色背景上渲染，PNG 也变为不透明。中后期精灵的特效大量使用叠加 (add)、滤色 (screen) 等混合模式，需要有背景才能与游戏里完全一致；透明背景下部分发光、高光会略有差别 |
| `--effects` | 同时导出 SWF 中以链接名导出的特效类（如 `ef1166`、`bullet`），存到 `effects/` |
| `--quality low\|medium\|high\|best` | Ruffle 渲染质量，默认 `high` |
| `--pad <px>` | 每帧在显示边界外多渲染的像素，防止发光等滤镜被裁掉，默认 64 |
| `--keep-swf` | 同时保存下载的 SWF |
| `--timeout <秒>` | 单个精灵的超时，默认 600 |
| `--headed` | 显示浏览器窗口（调试用） |

例子：

```bash
node export.mjs 70 --labels attack1 --scale 2       # 雷伊的特殊技能，2 倍分辨率
node export.mjs 4000 --effects --canvas pet          # 含特效类，所有动作对齐到同一画布
node export.mjs ./my_pet.swf --gif-bg "#000000"      # 本地 SWF（需导出 pet 类）
```

变身形态、星皇之怒衔接等扩展动作在单独的 SWF 中，序号规则见 `Main.as` 的 `reloadFightAnime`：
变身形态为 `序号 + 1500000`（序号 < 10000 时为 `序号 + 290000000`），
星皇之怒衔接形态为 `序号 + 500000`（序号 < 10000 时为 `序号 + 190000000`）。直接把算出的序号传给工具即可。

## meta.json

```jsonc
{
  "fps": 25,                       // GIF 帧间隔按此计算
  "renderBackground": "transparent",
  "actions": [{
    "label": "attack",
    "frames": 65,                  // 导出的帧数
    "width": 833, "height": 435,   // 画布尺寸（已乘 scale）
    "origin": { "x": 34, "y": 212 },// 精灵注册点在画布中的位置（Petdoctor 把注册点放在舞台 180,260）
    "firstHitFrame": 35,           // 动作剪辑首次 hit = 1 的帧（游戏在此触发对方受击），没有则为 null
    "sourceFrames": [1, 2, …]      // 每张图对应动作剪辑的哪一帧
  }],
  "effects": [ … ]                 // 使用 --effects 时，各特效类的同样信息
}
```

## 说明

- 物理攻击等动作会冲向对手再返回，画布宽度会包含整个移动范围；精灵完全离开画面的帧导出为全透明图，以保持时序。
- 较新的精灵（如 4000）动作本身只有几帧姿势，主要的动画放在单独导出的特效类里，这时请加 `--effects`。
- 透明背景导出时，使用混合模式的特效无法与背景混合，部分发光、高光与游戏里略有差别；要求还原观感时用 `--render-bg`（例如战斗背景的主色）。
- 渲染由 Ruffle 完成，与 Flash Player 在极个别特性上可能有差异。
- 没有独立显卡时（服务器、容器）Chromium 用 CPU 模拟 WebGL，带大量全屏特效的精灵会比较慢（5000 号约 3–4 分钟）。
- 修改包装 SWF 后用 [Haxe](https://haxe.org) 4.3 重新编译：`haxe build.hxml`（`src/haxe/NativeStackTrace.hx`
  是 Haxe 标准库文件的补丁版，让 try/catch 在 Ruffle 中可用）。
