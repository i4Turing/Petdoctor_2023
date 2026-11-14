#!/usr/bin/env node
/**
 * Seer (赛尔号) pet fight-animation frame exporter.
 *
 *   node export.mjs <petId | file.swf>... [options]
 *
 * Downloads https://seer.61.com/resource/fightResource/pet/swf/<id>.swf (the same file Petdoctor
 * loads), plays it in Ruffle inside headless Chromium through bin/exporter.swf, and writes every
 * action (frame label: attack / sa / cp / hited / appear / ...) as a PNG sequence and a GIF.
 *
 * The same file runs as the encoder worker (worker_threads) that turns captured frames into files.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PET_URL = (id) => `https://seer.61.com/resource/fightResource/pet/swf/${id}.swf`;

const HELP = `用法 / Usage:
  node export.mjs <精灵序号 | 本地.swf>... [选项]

  例: node export.mjs 1 3000            导出 1 号和 3000 号精灵全部动作
      node export.mjs 70 --labels attack1 --scale 2
      node export.mjs ./my_pet.swf      本地 SWF（需符合赛尔号精灵动画规格，导出类名为 pet）

选项 / Options:
  --out <dir>          输出目录 (默认 ./output)
  --labels <a,b,...>   只导出这些动作 (默认全部帧标签: attack,sa,cp,hited,appear...)
  --format <png,gif>   输出格式, 逗号分隔 (默认 png,gif)
  --scale <n>          渲染缩放倍数 (默认 1; 矢量动画可用 2 得到高清帧)
  --canvas <mode>      action: 每个动作单独裁剪画布 (默认)
                       pet:    同一精灵所有动作共用一个画布, 便于对齐
  --gif-bg <color>     GIF 背景: transparent (默认, 1 位透明) 或 #rrggbb
  --render-bg <color>  在实色背景上渲染 (#rrggbb), 输出不再透明。叠加/滤色等混合模式的特效
                       需要背景才能与游戏完全一致, 透明背景下部分发光会略有差别
  --effects            同时导出 SWF 中以链接名导出的特效类 (如 ef1166、bullet), 存于 effects/
  --quality <q>        Ruffle 渲染质量 low|medium|high|best (默认 high)
  --pad <px>           每帧在边界外额外渲染的像素, 防止滤镜被裁掉 (默认 64)
  --timeout <sec>      单个精灵超时 (默认 600)
  --keep-swf           同时保存下载的 SWF
  --headed             显示浏览器窗口 (调试用)
`;

function parseArgs(argv) {
  const o = {
    targets: [], out: "output", labels: "", format: "png,gif", scale: 1, canvas: "action",
    gifBg: "transparent", renderBg: null, quality: "high", pad: 64, timeout: 600, keepSwf: false, headed: false, effects: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case "-h": case "--help": console.log(HELP); process.exit(0);
      case "-o": case "--out": o.out = v(); break;
      case "--labels": o.labels = v(); break;
      case "--format": o.format = v(); break;
      case "--scale": o.scale = Number(v()); break;
      case "--canvas": o.canvas = v(); break;
      case "--gif-bg": o.gifBg = v(); break;
      case "--render-bg": o.renderBg = v(); break;
      case "--quality": o.quality = v(); break;
      case "--pad": o.pad = Number(v()); break;
      case "--timeout": o.timeout = Number(v()); break;
      case "--effects": o.effects = true; break;
      case "--keep-swf": o.keepSwf = true; break;
      case "--headed": o.headed = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}\n\n${HELP}`);
        o.targets.push(a);
    }
  }
  if (!o.targets.length) { console.log(HELP); process.exit(1); }
  o.formats = [...new Set(o.format.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (o.formats.some((f) => f !== "png" && f !== "gif")) throw new Error("--format accepts png and/or gif");
  if (!(o.scale > 0)) throw new Error("--scale must be > 0");
  if (!["action", "pet"].includes(o.canvas)) throw new Error("--canvas must be action or pet");
  if (o.gifBg !== "transparent") hexColor(o.gifBg);
  if (o.renderBg) {
    o.renderBg = hexColor(o.renderBg);
    if (o.gifBg === "transparent") o.gifBg = null; // frames are opaque anyway
  }
  return o;
}

// ---------------------------------------------------------------- download / SWF inspection

async function loadSwf(target) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    return { name: path.basename(target, path.extname(target)), buf: fs.readFileSync(target), src: target };
  }
  if (!/^\d+$/.test(target)) throw new Error(`"${target}" is neither a pet id nor an existing .swf file`);
  const url = PET_URL(target);
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${url}?${Date.now().toString(16)}`);
      if (res.status === 404) throw Object.assign(new Error(`HTTP 404: no fight animation for pet ${target} (${url})`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!["FWS", "CWS", "ZWS"].includes(buf.subarray(0, 3).toString("latin1")))
        throw Object.assign(new Error(`${url} did not return a SWF`), { fatal: true });
      return { name: target, buf, src: url };
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`download failed for ${url}: ${lastErr?.cause?.code || lastErr?.message}`);
}

/** Names from the SymbolClass tag that are effect/linkage classes (not `pet`, not Animate's *_fla.* timeline classes). */
function linkageClasses(buf) {
  const sig = buf.subarray(0, 3).toString("latin1");
  let body;
  if (sig === "FWS") body = buf.subarray(8);
  else if (sig === "CWS") body = zlib.inflateSync(buf.subarray(8));
  else return []; // LZMA (ZWS) is not handled here
  const nbits = body[0] >> 3;
  let p = Math.ceil((5 + 4 * nbits) / 8) + 4;
  const names = [];
  while (p + 2 <= body.length) {
    const h = body.readUInt16LE(p); p += 2;
    const code = h >> 6;
    let len = h & 63;
    if (len === 63) { len = body.readUInt32LE(p); p += 4; }
    if (code === 0) break;
    if (code === 76) {
      let q = p + 2;
      for (let n = body.readUInt16LE(p); n > 0; n--) {
        q += 2; // character id
        const e = body.indexOf(0, q);
        names.push(body.subarray(q, e).toString("utf8"));
        q = e + 1;
      }
    }
    p += len;
  }
  return names.filter((n) => n !== "pet" && !/_fla\.|(^|\.)Timeline_/.test(n) && !n.includes(","));
}

// ---------------------------------------------------------------- local server + Ruffle page

const MIME = { ".js": "text/javascript", ".wasm": "application/wasm", ".swf": "application/x-shockwave-flash", ".map": "application/json" };

function startServer() {
  const ruffleDir = path.dirname(require.resolve("@ruffle-rs/ruffle/package.json"));
  const exporterSwf = fs.readFileSync(path.join(HERE, "bin", "exporter.swf"));
  const state = { job: null };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const job = state.job;
    if (u.pathname.startsWith("/api/")) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        if (job) job.onPost(u, Buffer.concat(chunks));
      });
      return;
    }
    if (u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(job ? pageHtml(job) : "no job");
    }
    if (u.pathname === "/exporter.swf") return send(res, exporterSwf, ".swf");
    if (u.pathname === "/pet.swf" && job) return send(res, job.swf, ".swf");
    if (u.pathname.startsWith("/ruffle/")) {
      const f = path.join(ruffleDir, path.basename(u.pathname));
      if (fs.existsSync(f)) return send(res, fs.readFileSync(f), path.extname(f));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })),
  );

  function send(res, buf, ext) {
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  }
}

function pageHtml(job) {
  const params = new URLSearchParams({
    swf: "/pet.swf", post: "/api", scale: String(job.opts.scale), pad: String(job.opts.pad),
    labels: job.opts.labels, classes: job.classes.join(","),
    bg: job.opts.renderBg ? job.opts.renderBg.map((c) => c.toString(16).padStart(2, "0")).join("") : "", debug: process.env.DEBUG_EXPORTER ? "1" : "",
  }).toString();
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#333">
<div id="host" style="width:800px;height:600px"></div>
<script>
window.RufflePlayer = window.RufflePlayer || {};
window.RufflePlayer.config = {
  publicPath: "/ruffle/", polyfills: false, autoplay: "on", unmuteOverlay: "hidden", splashScreen: false,
  preferredRenderer: "wgpu-webgl", quality: ${JSON.stringify(job.opts.quality)}, letterbox: "off",
  contextMenu: "off", showSwfDownload: false, warnOnUnsupportedContent: false, openUrlMode: "deny",
  logLevel: "warn", maxExecutionDuration: 60, allowScriptAccess: true
};
</script>
<script src="/ruffle/ruffle.js"></script>
<script>
const player = window.RufflePlayer.newest().createPlayer();
player.style.width = "800px"; player.style.height = "600px";
document.getElementById("host").appendChild(player);
const api = player.ruffle ? player.ruffle() : player;
api.load({ url: "/exporter.swf", parameters: ${JSON.stringify(params)} }).catch((e) =>
  fetch("/api/fail", { method: "POST", body: "ruffle load error: " + e }));
</script></body></html>`;
}

// ---------------------------------------------------------------- capture one SWF

/**
 * Plays the SWF and streams each finished sequence to `onSequence(name, kind, frames)` as soon as
 * all of its frames have arrived, so encoding overlaps with the capture of the next action.
 */
async function capturePet(browser, srv, swf, classes, opts, onSequence) {
  const frames = new Map(); // name -> [{seq, cf, total, hit, x, y, w, h, data}]
  const ends = new Map(); // name -> {frames, kind}
  const started = new Set();
  const logs = [];
  let meta = null;
  let renderer = "";
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

  const maybeStart = (name) => {
    const end = ends.get(name);
    const list = frames.get(name) || [];
    if (!end || started.has(name) || list.length < end.frames) return;
    started.add(name);
    console.log(`  ✓ ${end.kind === "class" ? "特效 " : ""}${name}: ${end.frames} 帧`);
    onSequence(name, end.kind, list.sort((a, b) => a.seq - b.seq), meta);
  };

  srv.state.job = {
    swf: swf.buf,
    classes,
    opts,
    onPost(u, body) {
      const q = u.searchParams;
      switch (u.pathname) {
        case "/api/meta":
          meta = JSON.parse(body.toString("utf8"));
          console.log(`  fps ${meta.fps}, 帧标签: ${meta.labels.map((l) => l.name).join(", ") || "(none)"}`);
          break;
        case "/api/frame": {
          const name = q.get("label");
          if (!frames.has(name)) frames.set(name, []);
          frames.get(name).push({
            seq: +q.get("seq"), cf: +q.get("cf"), total: +q.get("total"), hit: q.get("hit"),
            x: +q.get("x"), y: +q.get("y"), w: +q.get("w"), h: +q.get("h"), data: body,
          });
          maybeStart(name);
          break;
        }
        case "/api/end":
          ends.set(q.get("label"), { frames: +q.get("frames"), kind: q.get("kind") });
          maybeStart(q.get("label"));
          break;
        case "/api/log":
          logs.push(body.toString("utf8"));
          console.warn(`  [swf] ${body.toString("utf8")}`);
          break;
        case "/api/done": resolveDone(); break;
        case "/api/fail": rejectDone(new Error(body.toString("utf8"))); break;
      }
    },
  };

  const page = await browser.newPage();
  page.on("console", (m) => {
    const text = m.text();
    const r = /Used renderer: ([\w-]+)/.exec(text);
    if (r) renderer = r[1];
    if (process.env.DEBUG_EXPORTER) {
      let t = text.replace(/%c/g, "");
      if (t.startsWith("[exporter]")) try { t = decodeURIComponent(t); } catch {}
      console.warn(`  [browser:${m.type()}] ${t.slice(0, 500)}`);
    }
    else if (m.type() === "error" && !/favicon/.test(text)) console.warn(`  [browser] ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => console.warn(`  [page] ${e.message}`));
  const timer = setTimeout(() => rejectDone(new Error(`timed out after ${opts.timeout}s`)), opts.timeout * 1000);
  try {
    await page.goto(`http://127.0.0.1:${srv.port}/`);
    await done;
  } finally {
    clearTimeout(timer);
    await page.close();
    srv.state.job = null;
  }
  if (renderer && !/wgpu|webgl/.test(renderer))
    console.warn(`  ⚠ Ruffle 使用的渲染器是 ${renderer}，截图可能不完整 (需要 WebGL)`);
  for (const name of ends.keys())
    if (!started.has(name)) console.warn(`  ⚠ ${name}: 只收到 ${(frames.get(name) || []).length}/${ends.get(name).frames} 帧`);
  return { meta, logs };
}

// ---------------------------------------------------------------- encoder worker pool

class Pool {
  constructor(size) { this.size = size; this.workers = []; this.idle = []; this.queue = []; }
  run(task) {
    return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject }); this.pump(); });
  }
  pump() {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w) {
        if (this.workers.length >= this.size) return;
        w = this.spawn();
      }
      w.job = this.queue.shift();
      w.postMessage(w.job.task);
    }
  }
  spawn() {
    const w = new Worker(fileURLToPath(import.meta.url));
    w.on("message", (msg) => {
      const job = w.job;
      w.job = null;
      this.idle.push(w);
      if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.result);
      this.pump();
    });
    w.on("error", (e) => {
      this.workers = this.workers.filter((x) => x !== w);
      this.idle = this.idle.filter((x) => x !== w);
      if (w.job) w.job.reject(e);
      this.pump();
    });
    this.workers.push(w);
    return w;
  }
  close() { return Promise.all(this.workers.map((w) => w.terminate())); }
}

const plain = (list) => list.map(({ x, y, w, h, data }) => ({ x, y, w, h, data }));

async function exportPet(browser, srv, pool, target, opts) {
  const swf = await loadSwf(target);
  console.log(`  SWF ${(swf.buf.length / 1024).toFixed(1)} KB  ${swf.src}`);
  const dir = path.join(opts.out, safeName(swf.name));
  fs.mkdirSync(dir, { recursive: true });
  if (opts.keepSwf) fs.writeFileSync(path.join(dir, `${safeName(swf.name)}.swf`), swf.buf);
  const allClasses = linkageClasses(swf.buf);
  const classes = opts.effects ? allClasses : [];

  const t0 = Date.now();
  const seqs = new Map(); // name -> {kind, list, boxes: Promise<bbox[]>, written?: Promise}
  const write = (name, s, box) =>
    pool.run({
      type: "write", frames: plain(s.list), box, dir, sub: s.kind === "class" ? "effects" : "", name,
      formats: opts.formats, fps: s.fps, gifBg: opts.gifBg, bg: opts.renderBg,
    });
  const { meta, logs } = await capturePet(browser, srv, swf, classes, opts, (name, kind, list, m) => {
    const s = { kind, list, fps: m?.fps || 24 };
    s.boxes = pool.run({ type: "bbox", frames: plain(list), bg: opts.renderBg });
    // canvas=action: each sequence is written as soon as its own bounds are known
    if (kind === "class" || opts.canvas === "action")
      s.written = s.boxes.then((b) => { s.box = unionBox(b); return write(name, s, s.box); });
    seqs.set(name, s);
  });
  if (!meta) throw new Error("no metadata received from the capture SWF");
  const fps = meta.fps;
  const tCapture = Date.now();

  if (opts.canvas === "pet") {
    // one canvas for all actions: wait for every action's bounds, then write them all
    const labelSeqs = [...seqs].filter(([, s]) => s.kind !== "class");
    const petBox = unionBox((await Promise.all(labelSeqs.map(([, s]) => s.boxes))).flat());
    for (const [name, s] of labelSeqs) { s.box = petBox; s.written = write(name, s, petBox); }
  }
  await Promise.all([...seqs.values()].map((s) => s.written));

  const describe = (name, s) => {
    const hitIdx = s.list.findIndex((f) => f.hit === "1" || f.hit === "true");
    const base = (s.kind === "class" ? "effects/" : "") + safeName(name);
    return {
      frames: s.list.length, timelineFrames: s.list[0]?.total ?? 0,
      width: s.box.x1 - s.box.x0, height: s.box.y1 - s.box.y0,
      // where the registration point lies in every frame (Petdoctor puts the pet's at x=180, y=260)
      origin: { x: -s.box.x0, y: -s.box.y0 },
      firstHitFrame: hitIdx >= 0 ? hitIdx + 1 : null,
      sourceFrames: s.list.map((f) => f.cf),
      png: opts.formats.includes("png") ? `${base}/` : undefined,
      gif: opts.formats.includes("gif") ? `${base}.gif` : undefined,
    };
  };
  const actions = meta.labels.filter((l) => seqs.has(l.name)).map((l) => ({ label: l.name, petFrame: l.frame, ...describe(l.name, seqs.get(l.name)) }));
  const effects = classes.filter((c) => seqs.has(c)).map((c) => ({ class: c, ...describe(c, seqs.get(c)) }));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    pet: swf.name, source: swf.src, fps, scale: opts.scale, canvas: opts.canvas,
    renderBackground: opts.renderBg ? "#" + opts.renderBg.map((c) => c.toString(16).padStart(2, "0")).join("") : "transparent",
    labels: meta.labels, actions, effects: effects.length ? effects : undefined,
    warnings: logs.length ? logs : undefined,
  }, null, 2));

  const sec = (ms) => (ms / 1000).toFixed(1);
  console.log(`  → ${dir}  (${actions.length} 个动作${effects.length ? `, ${effects.length} 个特效` : ""}; 渲染 ${sec(tCapture - t0)}s, 共 ${sec(Date.now() - t0)}s)`);
  if (!opts.effects && allClasses.length)
    console.log(`  ℹ 该 SWF 另有 ${allClasses.length} 个导出特效类 (${allClasses.slice(0, 6).join(", ")}${allClasses.length > 6 ? ", ..." : ""}), 加 --effects 可一并导出`);
}

// ---------------------------------------------------------------- image helpers (shared with workers)

/** zlib ARGB (BitmapData.getPixels, unmultiplied) -> RGBA */
function decodeFrame(f) {
  if (!f.w || !f.h) return null;
  const argb = zlib.inflateSync(f.data);
  const rgba = Buffer.allocUnsafe(f.w * f.h * 4);
  for (let i = 0; i < argb.length; i += 4) {
    rgba[i] = argb[i + 1]; rgba[i + 1] = argb[i + 2]; rgba[i + 2] = argb[i + 3]; rgba[i + 3] = argb[i];
  }
  return rgba;
}

function alphaBox(f, bg) {
  if (!f.w || !f.h) return null;
  const argb = zlib.inflateSync(f.data);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0, i = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++, i += 4) {
      if (bg ? argb[i + 1] !== bg[0] || argb[i + 2] !== bg[1] || argb[i + 3] !== bg[2] : argb[i]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x0: f.x + minX, y0: f.y + minY, x1: f.x + maxX + 1, y1: f.y + maxY + 1 };
}

function unionBox(boxes) {
  const b = boxes.filter(Boolean);
  if (!b.length) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  return {
    x0: Math.min(...b.map((v) => v.x0)), y0: Math.min(...b.map((v) => v.y0)),
    x1: Math.max(...b.map((v) => v.x1)), y1: Math.max(...b.map((v) => v.y1)),
  };
}

function placeOnCanvas(f, rgba, box, bg) {
  const W = box.x1 - box.x0, H = box.y1 - box.y0;
  const out = Buffer.alloc(W * H * 4);
  if (bg) for (let i = 0; i < out.length; i += 4) { out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; out[i + 3] = 255; }
  if (!rgba) return out;
  const sx0 = Math.max(box.x0, f.x), sy0 = Math.max(box.y0, f.y);
  const sx1 = Math.min(box.x1, f.x + f.w), sy1 = Math.min(box.y1, f.y + f.h);
  for (let y = sy0; y < sy1; y++) {
    const src = ((y - f.y) * f.w + (sx0 - f.x)) * 4;
    rgba.copy(out, ((y - box.y0) * W + (sx0 - box.x0)) * 4, src, src + (sx1 - sx0) * 4);
  }
  return out;
}

const CRC = zlib.crc32 ? (b) => zlib.crc32(b) >>> 0 : (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

/** RGBA -> PNG (per-row adaptive filter, chosen by minimum sum of absolute differences). */
function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const r0 = y * stride, p0 = r0 - stride, has = y > 0;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 0; i < stride; i++) {
      const x = rgba[r0 + i], a = i >= 4 ? rgba[r0 + i - 4] : 0, b = has ? rgba[p0 + i] : 0, c = has && i >= 4 ? rgba[p0 + i - 4] : 0;
      let v = x; s0 += v < 128 ? v : 256 - v;
      v = (x - a) & 255; s1 += v < 128 ? v : 256 - v;
      v = (x - b) & 255; s2 += v < 128 ? v : 256 - v;
      v = (x - ((a + b) >> 1)) & 255; s3 += v < 128 ? v : 256 - v;
      const p = a + b - c;
      let pa = p - a, pb = p - b, pc = p - c;
      pa = pa < 0 ? -pa : pa; pb = pb < 0 ? -pb : pb; pc = pc < 0 ? -pc : pc;
      v = (x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; s4 += v < 128 ? v : 256 - v;
    }
    let t = 0, m = s0;
    if (s1 < m) { m = s1; t = 1; } if (s2 < m) { m = s2; t = 2; } if (s3 < m) { m = s3; t = 3; } if (s4 < m) { t = 4; }
    const o = y * (stride + 1) + 1;
    raw[o - 1] = t;
    for (let i = 0; i < stride; i++) {
      const x = rgba[r0 + i], a = i >= 4 ? rgba[r0 + i - 4] : 0, b = has ? rgba[p0 + i] : 0;
      let pred = 0;
      if (t === 1) pred = a;
      else if (t === 2) pred = b;
      else if (t === 3) pred = (a + b) >> 1;
      else if (t === 4) {
        const c = has && i >= 4 ? rgba[p0 + i - 4] : 0, p = a + b - c;
        let pa = p - a, pb = p - b, pc = p - c;
        pa = pa < 0 ? -pa : pa; pb = pb < 0 ? -pb : pb; pc = pc < 0 ? -pc : pc;
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[o + i] = (x - pred) & 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function gifFrame(gif, rgba, w, h, delay, solid, first) {
  const { quantize, applyPalette } = require("gifenc");
  let px = rgba;
  if (solid) {
    px = Buffer.alloc(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3] / 255;
      px[i] = Math.round(rgba[i] * a + solid[0] * (1 - a));
      px[i + 1] = Math.round(rgba[i + 1] * a + solid[1] * (1 - a));
      px[i + 2] = Math.round(rgba[i + 2] * a + solid[2] * (1 - a));
      px[i + 3] = 255;
    }
  }
  // build the palette from a sample of the pixels (large frames would otherwise dominate the run time)
  const n = w * h, step = Math.max(1, Math.floor(n / 200000));
  let sample = px;
  if (step > 1) {
    sample = Buffer.alloc(Math.ceil(n / step) * 4);
    for (let p = 0, o = 0; p < n; p += step, o += 4) px.copy(sample, o, p * 4, p * 4 + 4);
  }
  const format = solid ? "rgb565" : "rgba4444";
  let palette = quantize(sample, 256, solid ? {} : { format, oneBitAlpha: true, clearAlpha: true, clearAlphaThreshold: 96 });
  let transparentIndex = solid ? -1 : palette.findIndex((c) => c[3] === 0);
  if (!solid && transparentIndex < 0) {
    palette = palette.length < 256 ? [...palette, [0, 0, 0, 0]] : [...palette.slice(0, 255), [0, 0, 0, 0]];
    transparentIndex = palette.length - 1;
  }
  const index = applyPalette(px, palette, format);
  gif.writeFrame(index, w, h, {
    palette, delay, ...(first ? { repeat: 0 } : {}),
    ...(transparentIndex >= 0 ? { transparent: true, transparentIndex, dispose: 2 } : {}),
  });
}

function hexColor(s) {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) throw new Error(`bad color ${s}, use #rrggbb`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function safeName(s) {
  return s.replace(/[\\/:*?"<>|\s]+/g, "_") || "_";
}

/** worker task: write one sequence (PNG frames + GIF), decoding one frame at a time */
function writeSequence({ frames, box, dir, sub, name, formats, fps, gifBg, bg }) {
  const W = box.x1 - box.x0, H = box.y1 - box.y0;
  const ln = safeName(name);
  const base = path.join(dir, sub || "", ln);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const png = formats.includes("png"), wantGif = formats.includes("gif");
  if (png) fs.mkdirSync(base, { recursive: true });
  const gif = wantGif ? require("gifenc").GIFEncoder() : null;
  const delay = Math.max(20, Math.round(100 / fps) * 10); // GIF delays are in 1/100 s
  const solid = bg || (gifBg && gifBg !== "transparent" ? hexColor(gifBg) : null);
  frames.forEach((f, i) => {
    f.data = Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength);
    const canvas = placeOnCanvas(f, decodeFrame(f), box, bg);
    if (png) fs.writeFileSync(path.join(base, `${ln}_${String(i + 1).padStart(4, "0")}.png`), encodePng(canvas, W, H));
    if (gif) gifFrame(gif, canvas, W, H, delay, solid, i === 0);
  });
  if (gif) {
    gif.finish();
    fs.writeFileSync(`${base}.gif`, gif.bytes());
  }
  return true;
}

// ---------------------------------------------------------------- entry points

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { chromium } = require("playwright");
  const srv = await startServer();
  const pool = new Pool(Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1)));
  const browser = await chromium.launch({
    headless: !opts.headed,
    // no GPU (servers, CI): let WebGL fall back to SwiftShader instead of failing
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
  });
  let failed = 0;
  try {
    for (const target of opts.targets) {
      console.log(`\n▶ ${target}`);
      try {
        await exportPet(browser, srv, pool, target, opts);
      } catch (e) {
        failed++;
        console.error(`  ✗ ${e.message}`);
      }
    }
  } finally {
    await browser.close();
    srv.server.close();
    await pool.close();
  }
  process.exit(failed ? 1 : 0);
}

if (!isMainThread) {
  parentPort.on("message", (task) => {
    try {
      if (task.type === "bbox") {
        parentPort.postMessage({ result: task.frames.map((f) => alphaBox({ ...f, data: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength) }, task.bg)) });
      } else {
        parentPort.postMessage({ result: writeSequence(task) });
      }
    } catch (e) {
      parentPort.postMessage({ error: e.stack || String(e) });
    }
  });
} else if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  // Node only honours HTTPS_PROXY for fetch() when started with NODE_USE_ENV_PROXY=1 (Node >= 22.21).
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" },
  });
  process.exit(r.status ?? 1);
} else {
  main().catch((e) => {
    console.error(process.env.DEBUG_EXPORTER ? e.stack : `错误: ${e.message}`);
    process.exit(1);
  });
}
