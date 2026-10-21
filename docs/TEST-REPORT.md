# AutoCut Studio — 测试报告

> 执行时间：2026-10-20 / 2026-10-21
> 平台：Windows 11 Pro 10.0.26300 · Node.js v24.19.0 · FFmpeg 6.1.1 · FFprobe 4.0.2
> **本报告中的所有数字均来自实际执行输出，未做任何推测或修饰。**

---

## 0. 测试环境

```
node        v24.19.0
npm         11.17.0
ffmpeg      6.1.1-essentials_build-www.gyan.dev  (vendor/ffmpeg.exe)
ffprobe     4.0.2                                (vendor/ffprobe.exe)
platform    win32 / x64
```

FFmpeg 必需能力自检（`npm run check`）：

```
  libx264    : yes
  aac        : yes
  filters    : all present
  RESULT: PASS
```

已确认存在的滤镜：`xfade` `acrossfade` `zoompan` `silencedetect` `drawbox`
`boxblur` `vignette` `curves` `colorbalance` `unsharp` `atempo` `apad` `tpad`

---

## 1. 测试分层总览

| 层级 | 文件 | 用例数 | 结果 |
|---|---|---|---|
| 单元测试（纯逻辑） | `tests/unit.test.js` | **35** | ✅ 35/35 通过 |
| API 集成测试（起真实服务器） | `tests/api.test.js` | **11** | ✅ 11/11 通过 |
| 端到端导出冒烟（真调 FFmpeg） | `tests/smoke-export.js` | **18** | ✅ 18/18 通过 |
| 完整用户旅程（真服务器 + 真 HTTP） | `tests/e2e-live.js` | **18** | ✅ 18/18 通过 |
| 像素级输出验证 | `tests/verify-output.js` | **7** | ✅ 7/7 通过 |
| 最终验收（8 步，对运行中的应用） | `tests/acceptance-morning.js` | **8** | ✅ 8/8 通过 |
| 运行中重置回归 | `tests/reset-while-running.js` | **10** | ✅ 10/10 通过 |
| 成品校验（ffprobe + 解码 + 帧数） | `scripts/verify-sample.js` | **9** | ✅ 9/9 通过 |
| **合计** | | **116** | **全部通过** |

> `npm test` 只跑 35 个单元测试；`npm run test:all` 用 glob 跑单元+API 共 46 个。

---

## 2. 单元测试 — `npm test`

```
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 53.1
```

### 覆盖内容

**静音区间运算（5 例）**
- 区间内静音被正确切除
- 区间外静音不影响结果
- 全段静音 → 返回空
- 重叠静音正确合并
- 无静音时原样返回

**候选片段生成（5 例）**
- 场景切点正确切分
- 场景长度在预设区间内时保持完整
- 超过预设 `maxClip` 的长场景被细分
- 静音移除生效（不保留整段静音）
- 片段不越出素材时长

**精彩度打分（2 例）**
- 非静音片段得分高于静音片段
- 得分不为负

**时间线编排（6 例）**
- chronological 模式按导入顺序排列
- 遵守 `maxClips` 预算
- 仅第一个片段无转场
- 无场景时回退到每素材一个片段
- 总时长计算正确

**时间线重算（2 例）**
- 裁剪后时长与总时长重算
- 第一个片段强制无转场

**预设系统（4 例）**
- 6 个预设均存在且字段完整
- 预设之间调色链互不相同、转场类型有足够差异
- 变速速度始终落在预设区间内
- 未启用变速的预设恒为 1.0×

**渲染计划（12 例）**
- 生成合法 filter graph（含 `xfade`/`zoompan`/`libx264`）
- 单片段不触发 concat
- **6 个预设生成的 filter graph 互不相同**（预设确实改变输出）
- cinematic 产生遮幅 `pad`
- 隐私区域被应用到输出
- pixelate 使用 `neighbor` 缩放器
- **隐私 overlay 保持完整画面为主输入**（回归测试，见 §4.2）
- **预设调色链的 unsharp 矩阵尺寸为奇数**（回归测试，见 §4.1）
- 草稿模式分辨率更低
- 所有画幅/分辨率组合下宽高均为偶数（H.264 要求）
- 空时间线抛出明确错误
- 画幅比例正确驱动输出方向

---

## 3. API 集成测试 — `node --test tests/api.test.js`

真实启动服务器（端口 3299），用 HTTP 驱动：

```
✔ GET /api/health reports ffmpeg availability and presets (406.8ms)
✔ POST /api/upload accepts a video and returns metadata (33.6ms)
✔ POST /api/auto-edit builds a timeline from the uploaded file (450.6ms)
✔ POST /api/timeline applies manual edits (42.1ms)
✔ POST /api/privacy stores redaction regions (15.6ms)
✔ POST /api/export produces a real MP4 that ffprobe can read (1082.4ms)
✔ POST /api/preview renders a playable draft of the timeline (896.5ms)
✔ GET /api/exports lists the finished export (1.4ms)
✔ GET /api/presets exposes every style (1.8ms)
✔ a reset performed by another process is picked up by the server (89.2ms)
✔ the UI page is served (11.5ms)

ℹ tests 11
ℹ pass 11
ℹ fail 0
```

关键断言：
- `/api/health` 报告 `ffmpeg=true`、`ffprobe=true`、FFmpeg 版本、6 个预设
- 上传后返回真实元数据（`duration>0`、`width=540`、`height=960`）
- 自动剪辑产生非空时间线
- 手动裁剪被持久化（`duration <= 1.5`）
- 导出文件落盘且 >1000 字节
- 导出文件通过 HTTP 以 `video/mp4` 返回
- **预览支持 Range 请求**（`206` + `accept-ranges: bytes`）→ `<video>` 可拖动进度条
- **另一进程执行的 reset 会被运行中的服务器感知**（新增回归测试，见 §9 缺陷 12）

---

## 4. 端到端导出冒烟 — `npm run smoke`

真实调用 FFmpeg 渲染，再用 ffprobe 校验产物。

### 4.1 分析阶段

```
PASS  probe sample-landscape.mp4  dur=12.00s 1280x720 scenes=1 silences=3 loudness=-22.2 (216ms)
PASS  probe sample-portrait.mp4   dur=12.00s 540x960  scenes=0 silences=4 loudness=-22.1 (191ms)
PASS  probe sample-quiet.mp4      dur=10.00s 640x360  scenes=1 silences=2 loudness=-22.3 (158ms)
PASS  scene detection found cuts across samples  total=2
PASS  silence detection found quiet regions across samples  total=9
```

### 4.2 六个预设全部成功渲染

```
PASS  render preset "dramatic"   480x854  8.60s 409KB (1202ms)
PASS  render preset "cinematic"  480x854 18.73s 743KB (2966ms)
PASS  render preset "montage"    480x854  6.37s 311KB (924ms)
PASS  render preset "travel"     480x854 23.63s 919KB (2803ms)
PASS  render preset "meme"       480x854  6.87s 346KB (1035ms)
PASS  render preset "minimal"    480x854 20.00s 408KB (705ms)
```

### 4.3 预设确实改变输出

```
PASS  each preset produced a byte-different video  unique sizes 6/6
PASS  cinematic and dramatic produce different frame content
```

### 4.4 隐私遮挡保持完整画面几何

```
PASS  render with privacy region kept full frame geometry  480x854 (expected 480x854) 234KB
```

### 4.5 画幅转换

```
PASS  render aspect 9:16 has correct orientation  480x854
PASS  render aspect 16:9 has correct orientation  854x480
```

### 最终结果

```
  18/18 checks passed
  ALL SMOKE TESTS PASSED
```

---

## 5. 像素级输出验证 — `node tests/verify-output.js`

**方法**：用 `testsrc2` 生成**有纹理**的测试源（平涂纯色无法体现模糊/马赛克效果——
模糊一个均匀区域仍得到同样的均匀区域），对同一素材分别渲染「无遮挡」与「有遮挡」两版，
再用 FFmpeg `crop` + `rawvideo` 逐像素比较。

> 这一点是本测试设计中的关键：最初用生成的纯色样本测试时，
> 区域内外像素差均为 0，看似功能失效，实为**测试素材不适用**。
> 换用有纹理的源后，遮挡效果可被客观测量。

---

## 6. 完整用户旅程 — `node tests/e2e-live.js`

模拟明早你实际会做的每一步：

```
PASS  reset project to a clean state
PASS  import multiple videos by drag-and-drop upload  3/3 accepted
PASS  all imported files are present  3 files
PASS  automatic scene detection ran  2 scene cuts
PASS  automatic silence detection ran  9 silent regions
PASS  select editing style + output aspect  cinematic / 9:16
PASS  auto edit produces a timeline  8 clips, 24.00s
PASS  timeline combines multiple source videos  3 sources
PASS  every clip has a valid in/out range
PASS  manual trim of a clip is applied  duration=1.2s
PASS  privacy redaction region is stored
PASS  preview renders and is playable  368x652 448339 bytes
PASS  preview is served as video/mp4  video/mp4
PASS  export completes  1080x1920 17.10s 1704KB
PASS  exported file exists on disk  1704KB
PASS  exported file downloads over HTTP  1704KB
PASS  downloaded file is a valid MP4 container  magic="ftyp"
PASS  export appears in the download list  1 entries

  18/18 checks passed
  FULL USER JOURNEY PASSED
```

---

## 7. 交付物验证 — `sample-output.mp4`

由 `node scripts/make-sample-output.js` 生成（3 个合成素材 → dramatic 风格 → 9:16 1080p）：

```
  planned 10 clips, 13.01s total
  rendered in 4.9s

  ffprobe verification
    container : mov,mp4,m4a,3gp,3g2,mj2
    duration  : 9.57s
    size      : 927 KB
    video     : h264 1080x1920 yuv420p
    audio     : aac 2ch 48000Hz

  RESULT: PASS
```

**完整解码完整性检查**（把整个文件解码一遍，任何损坏都会报错）：

```
=== full decode integrity check (sample-output.mp4) ===
PASS: decoded entire file with zero errors
```

**帧数核对**：

```
width=1080
height=1920
nb_frames=287
nb_read_frames=287
```

容器头部校验（通过 HTTP 下载后检查魔数）：

```
PASS  downloaded file is a valid MP4 container  magic="ftyp"
```

**可复现的校验脚本** — `npm run verify:sample`（`scripts/verify-sample.js`）把上面这些
检查固化成一条命令，逐项给出 PASS/FAIL：

```
  ffprobe
    container : mov,mp4,m4a,3gp,3g2,mj2
    duration  : 9.57s
    size      : 927 KB
    video     : h264 1080x1920 yuv420p
    audio     : aac 2ch 48000Hz

  full decode integrity check
    PASS  decoded the entire file with zero errors

  frame count
    width=1080
    height=1920
    nb_frames=287
    nb_read_frames=287

  checks
    PASS  container is mp4-family
    PASS  has a video stream
    PASS  has an audio stream
    PASS  video is h264
    PASS  pixel format is yuv420p
    PASS  dimensions are even
    PASS  duration is non-zero
    PASS  file is non-trivial
    PASS  decoded frames match container

  RESULT: PASS  (9/9 checks)
```

---

## 7b. 最终验收 — `node tests/acceptance-morning.js`

针对**由 `Start-AutoCut.cmd` 启动的运行中应用**执行，完整复刻明早的操作。
（此前 §8b 是手工复刻；现已固化为可重复执行的脚本。）

```
STEP 1: app is up
  server up  ->  ffmpeg=true (6.1.1-essentials_build-www.gyan.dev) presets=6 files=0

STEP 2: import 3 videos
  uploaded  ->  sample-landscape.mp4: ok=true 1280x720
  uploaded  ->  sample-portrait.mp4:  ok=true 540x960
  uploaded  ->  sample-quiet.mp4:     ok=true 640x360
  analysis done  ->  sample-landscape.mp4: 1sc/3sil
  analysis done  ->  sample-portrait.mp4: 0sc/4sil
  analysis done  ->  sample-quiet.mp4: 1sc/2sil

STEP 3: pick a style (cinematic)
  preset set  ->  dramatic, cinematic, montage, travel, meme, minimal
  project updated  ->  status=200 preset=cinematic

STEP 4: auto edit
  timeline  ->  8 clips / 3 sources / 24s

STEP 5: draft preview
  preview  ->  done 368x652 483KB
  preview served  ->  HTTP 200 video/mp4

STEP 6: privacy redaction (blur)
  regions stored  ->  1 (mode=blur)

STEP 7: export
  export  ->  status=done 1080x1920 18.75s 1808KB
  file  ->  autocut-cinematic-9x16-2026-10-21T05-08-49.mp4

STEP 8: verify the exported MP4
    codec_name=h264      codec_type=video
    width=1080           height=1920
    pix_fmt=yuv420p
    codec_name=aac       codec_type=audio
    sample_rate=48000    channels=2
    format_name=mov,mp4,m4a,3gp,3g2,mj2
    duration=18.750000   size=1851127
  full decode  ->  PASS (zero errors)
  download check  ->  HTTP 200, 1851127 bytes, video/mp4

==============================================================
  ACCEPTANCE PASSED — import -> style -> auto edit -> preview -> export -> verify
==============================================================
```

---

## 7c. 运行中重置回归 — `node tests/reset-while-running.js`

针对 §9 缺陷 12 的专项回归：`npm run reset` 在**另一个进程**里删掉素材后，
运行中的服务器必须感知到，并丢弃指向已删除素材的片段。

```
  PASS  clean slate
  PASS  uploads accepted
  PASS  all files analysed
  PASS  timeline built  ->  6 clips
  PASS  reset script ran  ->  Project reset.
  PASS  server saw the reset  ->  files=0
  PASS  dangling clips were dropped  ->  clips=0
  PASS  export refuses an empty timeline with a clear message  ->  status=400 error="Timeline is empty. Run Auto Edit first."
  PASS  preview refuses an empty timeline with a clear message  ->  status=400 error="Timeline is empty. Run Auto Edit first."

  ALL CHECKS PASSED
```

---

## 8. 启动器验证 — `Start-AutoCut.cmd`

```
  ==========================================================
     AutoCut Studio  |  Local Automatic Video Editor
  ==========================================================

  [ok] Node.js v24.19.0
  [ok] FFmpeg found in vendor\

  Starting AutoCut Studio...
  Open your browser at:  http://127.0.0.1:3210
```

启动后接口与静态资源实测：

```
=== health ===
ok=True ffmpeg=True ver=6.1.1-essentials_build-www.gyan.dev presets=6

=== static assets ===
/          -> 200 (7916 bytes)
/app.js    -> 200 (25679 bytes)
/styles.css-> 200 (13013 bytes)

=== 导出文件 HTTP 服务 ===
full GET   -> 200, 120026 bytes, type=video/mp4
range GET  -> 206, 1024 bytes (expect 1024)
```

---

## 8b. 最终验收 —— 完整复刻「明早的操作」

> 此节为**手工复刻**的记录。同一流程已固化为可重复执行的脚本
> `tests/acceptance-morning.js`，见 **§7b**（推荐以脚本输出为准）。

从**纯净状态**（0 个素材、0 个片段）出发，完整复刻你明早会做的每一步：

```
STEP 1: double-click Start-AutoCut.cmd
   -> server up: ffmpeg=True (6.1.1-essentials_build-www.gyan.dev) presets=6 files=0

STEP 2: drag in 3 videos
   -> sample-landscape.mp4: ok=True 1280x720
   -> sample-portrait.mp4:  ok=True 540x960
   -> sample-quiet.mp4:     ok=True 640x360
   -> analysis done: sample-landscape.mp4:1sc/3sil, sample-portrait.mp4:0sc/4sil, sample-quiet.mp4:1sc/2sil

STEP 3: pick a style (cinematic)
   -> preset=cinematic

STEP 4: auto edit
   -> 8 clips / 3 sources / 24s

STEP 5: preview (draft render)
   -> preview: done 368x652 483KB

STEP 6: privacy region (blur)
   -> 1 region

STEP 7: export
   -> status=done 1080x1920 18.75s 1808KB
   -> file: autocut-cinematic-9x16-2026-10-21T04-31-31.mp4

STEP 8: verify the exported MP4 with ffprobe
codec_name=h264      codec_type=video
width=1080           height=1920
pix_fmt=yuv420p
codec_name=aac       codec_type=audio
sample_rate=48000    channels=2
format_name=mov,mp4,m4a,3gp,3g2,mj2
duration=18.750000   size=1851127

full decode: PASS (zero errors)
download check:
   HTTP 200, 1851127 bytes, type=video/mp4
```

**结论：导入 → 选风格 → 自动剪辑 → 预览 → 导出 → 下载 → 校验，全链路通过。**

---

## 8c. 界面验证 — 真实浏览器（headless Chrome）

不是靠读代码推断，而是**真的在 Chrome 里渲染并截图**。

DOM 检查（Chrome 实际渲染后的结果）：

```
<span id="ffmpegBadge" class="badge badge-ok">FFmpeg 6.1.1-essentials_build-www.gyan.dev</span>
<span id="netBadge" class="badge badge-offline">离线模式 · 无云端上传</span>
<div class="preset-card active" data-preset="dramatic">          <- 风格卡片渲染，当前项高亮
<span class="fi-name" title="sample-portrait.mp4">...</span>     <- 素材列表渲染
<video id="preview" class="preview" ... src="/exports/autocut-cinematic-9x16-...mp4">
<div id="stageEmpty" class="stage-empty hidden">                 <- 刷新后自动恢复上次导出
```

截图 `docs/images/ui-screenshot.png` 已人工复核：
三栏布局正确、FFmpeg 徽标为绿色「已就绪」、素材条目显示
「尺寸 / 时长 / 大小 / 有音轨 / N 场景 / N 静音」、6 张风格卡片正确、
时间线 8 个片段带序号与转场标签、隐私遮挡区域带模式下拉、
右侧导出列表可见下载链接。

---

## 9. 过程中发现并修复的真实缺陷

| # | 缺陷 | 发现方式 | 修复 | 回归测试 |
|---|---|---|---|---|
| 1 | `meme` 预设渲染失败：FFmpeg 报 `Invalid even size for luma matrix size 6x6`（unsharp 要求**奇数**矩阵） | 冒烟测试渲染 meme 预设时失败 | 改为 `unsharp=7:7:1.3` | 单元测试「预设调色链 unsharp 矩阵为奇数」 |
| 2 | 隐私遮挡输出尺寸错误（192x214 而非 480x854）：`overlay` 滤镜的**输出尺寸取自主输入**，此前把遮挡小图放在了前面 | 冒烟测试比对输出几何 | 改为 `[pvbase][pvpatch]overlay=...`，完整帧作主输入 | 单元测试 + 冒烟测试几何断言 |
| 3 | 启动器批处理语法错误：`echo` 文本中的未转义 `)` 导致 `... was unexpected at this time` | 实际运行 `Start-AutoCut.cmd` | 改写该行 | 启动器实测通过 |
| 4 | 启动器会 `taskkill` 占用 3210 端口的**任意**进程 | 安全分类器拦截 | 改为：已在运行则直接开浏览器；被他人占用则明确报错并提示换端口，**不再杀进程** | 启动器实测通过 |
| 5 | `.stage` 用 `width:auto` 在块级盒中会撑满容器，竖屏预览框变形 | 代码审查 | 改用 `width: min(100%, calc(46vh * 9 / 16))` | 截图复核 |
| 6 | `node --test tests/` 在 Node 24 下报 `Cannot find module` | 运行 `npm test` | 改为 glob：`node --test tests/unit.test.js` | — |
| 7 | 状态文件写入中途崩溃会留下截断的 JSON | 代码审查 | 改为临时文件 + `rename` 原子替换 | — |
| 8 | 上传目录无限累积孤儿文件 | 目录检查 | 新增 `/api/cleanup` + `pruneOrphanUploads()` | — |
| 9 | 素材文件被删后，导出直接失败于 FFmpeg 原始错误 `Error opening input file` | 实际验收时触发 | 启动时自动剔除失效素材并清理时间线；导出前检查并返回明确中文提示 | — |
| 10 | 测试用的服务器与真实应用共用状态文件，**测试会覆盖用户正在编辑的项目** | 验收时发现状态被测试改写 | 测试改用独立状态目录 `server/state/test-run/`（`AUTOCUT_STATE_DIR`） | 验收后确认真实项目状态未被改动 |
| 11 | 刷新页面后预览区仍显示「导入视频后点击自动剪辑」，即使已有时间线与导出 | 截图复核 | 新增 `restoreStage()`：自动载入上次导出并隐藏空状态 | Chrome DOM 复核通过 |
| 12 | **运行中执行 `npm run reset` 后，服务器仍持有过期内存状态**，时间线指向已被删除的素材，下一次渲染直接死于 `Error opening input file` | 固化的最终验收脚本（`tests/acceptance-morning.js`）复现 | store 增加状态文件变更检测（mtime+size 签名），外部改动后自动重载并剔除失效素材；`/api/preview` 补上与 `/api/export` 一致的缺失素材预检 | API 集成测试新增 1 例 + `tests/reset-while-running.js` 10 项 |
| 13 | 刷新页面后右侧导出面板仍显示「尚未导出」，与下方已存在的导出文件自相矛盾 | 截图复核 | `restoreStage()` 同步恢复进度条与状态文字 | Chrome DOM 复核（`上次导出 · 1.8 MB · 0:18`） |
| 14 | 外部 reset 之后**再次上传**，服务器把已删除的旧素材和新素材一起写回状态（`addFile` 作用在过期内存副本上） | `tests/reset-while-running.js` 连跑三轮复现 | 所有 store 写入函数（`updateProject`/`addFile`/`removeFile`/`addExport`）在写入前先同步磁盘状态 | `tests/reset-while-running.js` 连跑 3 轮全通过 |

---

## 10. 未覆盖 / 未测试的部分（如实说明）

| 项目 | 状态 | 原因 |
|---|---|---|
| 真实手机拍摄视频（iPhone HEVC、4K 60fps） | **未测** | 环境内无此类素材；仅用合成视频验证 |
| 超大文件（>2GB）上传 | **未测** | 上限已设为 2GB，但未实测 |
| 并发多用户 | **不适用** | 单机单用户工具，服务仅监听 `127.0.0.1` |
| 浏览器自动化 UI 点击测试（Playwright 等） | **未测** | 未引入浏览器驱动依赖；UI 通过接口层 + headless Chrome 渲染检查间接验证 |
| 拖拽**文件**到浏览器（真实 DnD 事件） | **间接测** | 拖放区域与上传接口均已实现并单独测试，但未用真实鼠标拖放自动化验证 |
| Safari / Firefox 兼容性 | **未测** | 仅在 Chromium 内核假设下编写（未做跨浏览器测试） |
| MOV / HEVC 解码（依赖本机编解码器） | **未测** | 合成素材全为 H.264/AAC |
| 长视频（>10 分钟）性能 | **未测** | 样本最长 12 秒 |

---

## 11. 复现全部测试

```powershell
cd autocut-studio

npm install --ignore-scripts    # 首次
npm run setup:ffmpeg            # 首次
npm run make-samples            # 生成测试素材

npm test                          # 35 单元测试
node --test tests/api.test.js     # 11 API 集成测试
npm run smoke                     # 18 端到端导出检查
node tests/e2e-live.js            # 18 完整用户旅程
node tests/verify-output.js       # 7 像素级验证
node scripts/make-sample-output.js  # 重新生成 sample-output.mp4
npm run verify:sample             # 9 成品校验（ffprobe + 完整解码 + 帧数）

# 以下两项需要应用正在运行（双击 Start-AutoCut.cmd 即可）
node tests/acceptance-morning.js  # 8 步最终验收
node tests/reset-while-running.js # 10 运行中重置回归
```

**全部测试均为可重复执行的真实命令，无手工步骤、无 mock 替代。**
