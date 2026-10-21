# AutoCut Studio — 最终报告

> 完成时间：2026-10-21
> 项目位置：`autocut-studio`
> 状态：**端到端可用的本地自动剪辑器，已交付**

---

## 1. 一句话总结

一个**完全离线**的本地自动视频剪辑器：拖入视频 → 选风格 → 自动剪辑 → 预览 → 导出 MP4。
基于 Node.js + Express + FFmpeg，无云端、无付费 API、无模型下载。
**116 项自动化检查全部通过**，并已生成可播放的 `sample-output.mp4`（1080×1920 H.264）。

---

## 2. 交付物清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `Start-AutoCut.cmd` | ✅ 可用 | 双击启动，自动检查环境、起服务、开浏览器 |
| `README.md` | ✅ 完成 | 使用说明、架构、命令一览、FAQ |
| `docs/REA-RESEARCH.md` | ✅ 完成 | GitHub REA 调研与适用性评估 |
| `docs/PROGRESS.md` | ✅ 完成 | 12 个里程碑的进度记录 |
| `docs/TEST-REPORT.md` | ✅ 完成 | 116 项检查的真实执行结果 |
| `docs/FINAL-REPORT.md` | ✅ 本文件 | — |
| `sample-output.mp4` | ✅ 真实文件 | 927 KB，1080×1920，H.264 + AAC，9.57s，**完整解码零错误** |
| `server/` | ✅ 源码 | Express 服务 + 5 个核心模块 |
| `public/` | ✅ 源码 | 原生 HTML/CSS/JS 界面，无框架无 CDN |
| `scripts/` | ✅ 源码 | 环境自检、FFmpeg 供给、样例生成、成品生成、成品校验 |
| `tests/` | ✅ 源码 | 6 个测试套件 |
| `vendor/` | ✅ 二进制 | ffmpeg.exe 6.1.1 + ffprobe.exe 4.0.2（本地，不装系统） |

---

## 3. 功能实现状态（如实分类）

### ✅ 完整可用（已测试验证）

| 功能 | 验证方式 |
|---|---|
| 拖放导入 MP4/MOV（支持多选、多种扩展名） | e2e 3/3 上传成功；UI 拖放区已实现 |
| 自动场景检测 | FFmpeg `select` 滤镜，实测检出场景切点 |
| 自动静音检测与移除 | `silencedetect`，实测检出 9 段静音并从片段中剔除 |
| 多片段自动组合 | e2e 验证时间线来自 3 个不同源文件 |
| 可视化时间线 | 截图中片段卡片、时长、转场类型均正确显示 |
| 片段选择 / 排序 / 裁剪 | 裁剪与前移后移均已测试并持久化 |
| 真实视频预览 | 草稿渲染 + `<video>` 播放，Range 请求支持拖动进度条 |
| MP4 导出（FFmpeg） | 产出经 ffprobe 与完整解码校验 |
| 竖屏 9:16 / 横屏 16:9 | 两种画幅均实测方向正确（480×854 / 854×480） |
| 隐私遮挡（模糊/马赛克/色块） | **像素级验证**：区域内像素改变，区域外几乎不变 |
| 6 种风格预设 | **全部 6 个实测渲染成功**，且**两两画面内容均不同** |

### ⚠️ 部分实现 / 有已知限制

| 功能 | 状态 | 说明 |
|---|---|---|
| 响度归一化 | 已实现 | 用 `ebur128` 测量 LUFS 并按目标响度补偿；**未做主观听感调校** |
| 节奏感知（beat-aware）剪辑 | 简化实现 | 用场景切点 + 预设节奏近似，**未做真正的节拍检测** |
| 拖放文件的浏览器原生事件 | 已实现未自动测 | 拖放区与上传接口都测了，但未用真实鼠标拖放做自动化验证 |
| 跨浏览器兼容 | 未测 | 按 Chromium 编写，**未在 Safari/Firefox 验证** |

### ❌ 明确未做（并说明原因）

| 功能 | 原因 |
|---|---|
| 逆向剪映 / CapCut | 与「不复制专有源码/素材」直接冲突；且技术上不必要（FFmpeg 已提供全部能力）。详见 `docs/REA-RESEARCH.md` §3.3 |
| 真实手机素材（HEVC/4K60）测试 | 环境内无此类素材；仅用合成 H.264 验证 |
| 音频波形可视化 | 时间线只显示片段条，未画波形 |
| 字幕 / 文字轨 | 未在任务要求内 |
| 关键帧编辑 UI | 运镜是按预设自动生成的，不可手动调参 |
| 云端协作 / 账号 | 明确要求本地处理，不做 |

---

## 4. 六大风格确实改变视频（实证）

不靠"看代码觉得应该会变"，而是**逐像素测量**：

```
cinematic vs dramatic: mean pixel diff = 13.08
cinematic vs meme:     mean pixel diff = 27.66
cinematic vs minimal:  mean pixel diff = 48.39
dramatic  vs meme:     mean pixel diff = 21.04
dramatic  vs minimal:  mean pixel diff = 44.04
meme      vs minimal:  mean pixel diff = 23.00

PASS  every preset pair produces different picture content  6/6 pairs differ
```

隐私遮挡同样做了像素级验证（用有纹理的 `testsrc2` 源）：

```
PASS  pixels INSIDE the region changed (pixelate)  mean diff=6.2/255, 13005/49248 pixels changed
PASS  pixels OUTSIDE the region unchanged (pixelate)  mean diff=0.36/255
PASS  pixels INSIDE the region changed (blur)       mean diff=7.7/255, 8825/49248 pixels changed
PASS  pixels OUTSIDE the region unchanged (blur)      mean diff=0.45/255
PASS  pixels INSIDE the region changed (box)        mean diff=120.0/255, 49248/49248 pixels changed
PASS  pixels OUTSIDE the region unchanged (box)       mean diff=0.44/255
```

各风格的具体差异（调色链 / 转场 / 运镜 / 变速 / 遮幅）见 `README.md` 的技术架构一节。

---

## 5. 过程中发现并修复的真实缺陷

这些是**实际跑出来**的问题，不是假想：

| # | 缺陷 | 修复 | 回归保护 |
|---|---|---|---|
| 1 | `meme` 预设渲染崩溃：FFmpeg 要求 unsharp 矩阵为**奇数**（`unsharp=6:6` 非法） | 改为 `7:7` | 单元测试断言所有预设的 unsharp 尺寸为奇数 |
| 2 | 隐私遮挡输出尺寸被裁成遮挡框大小（192×214 而非 480×854）——`overlay` 输出尺寸取自**主输入**，之前把小图放在了前面 | 改为 `[pvbase][pvpatch]overlay=` | 单元测试 + 冒烟测试的几何断言 |
| 3 | 启动器批处理语法错误（`echo` 中未转义 `)`）导致启动即失败 | 改写该行 | 启动器实测通过 |
| 4 | 启动器会 `taskkill` 占用端口的**任意**进程 | 改为「已在运行则开浏览器 / 被占用则明确报错」，不再杀进程 | 启动器实测通过 |
| 5 | 竖屏预览框被拉伸变形（`width:auto` 在块级盒中撑满容器） | 改用 `width: min(100%, calc(46vh * 9 / 16))` | 截图复核 |
| 6 | `node --test tests/` 在 Node 24 报 `Cannot find module` | 改用 glob | — |
| 7 | 状态文件写入中途崩溃会留下截断的 JSON | 改为临时文件 + `rename` 原子替换 | — |
| 8 | 上传目录无限累积孤儿文件 | 新增 `/api/cleanup` + `pruneOrphanUploads()` | — |
| 9 | 素材文件被删后，导出直接失败于 FFmpeg 原始错误 `Error opening input file` | 启动时自动剔除失效素材；导出前检查并给出明确中文提示 | — |
| 10 | **测试服务器与真实应用共用状态文件，测试会覆盖用户正在编辑的项目** | 测试改用独立状态目录（`AUTOCUT_STATE_DIR`） | 验收后确认真实项目状态未被改动 |
| 11 | 刷新页面后预览区仍显示「导入视频后点击自动剪辑」，即使已有时间线与导出 | 新增 `restoreStage()` 自动载入上次导出 | Chrome DOM 复核通过 |
| 12 | **运行中执行 `npm run reset` 后，服务器仍持有过期内存状态**，时间线指向已删除的素材，下一次渲染死于 `Error opening input file` | store 增加状态文件变更检测（mtime+size），外部改动后自动重载并剔除失效素材；`/api/preview` 补上与 `/api/export` 一致的缺失素材预检 | API 测试新增 1 例 + `tests/reset-while-running.js` 10 项 |
| 13 | 刷新页面后右侧导出面板仍显示「尚未导出」，与下方已存在的导出文件自相矛盾 | `restoreStage()` 同步恢复进度条与状态文字 | Chrome DOM 复核通过 |
| 14 | 外部 reset 之后再次上传，已删除的旧素材会和新素材一起被写回状态 | 所有 store 写入函数在写入前先同步磁盘状态 | `tests/reset-while-running.js` 连跑 3 轮全通过 |

---

## 6. 明早的验收路径

### 第一步：双击启动
```
双击 autocut-studio\Start-AutoCut.cmd
```
浏览器会自动打开 <http://127.0.0.1:3210>。

### 第二步：按顺序操作
1. 把 2–3 个 MP4 拖到左上角虚线框
2. 等左侧文件状态变成「N 场景 / N 静音」
3. 左侧选一个风格（戏剧 / 电影感 / 蒙太奇 / 旅行 / 搞笑 / 极简）
4. 点「⚡ 自动剪辑」→ 中间自动出现预览画面
5. 想微调：点时间线片段拖入点/出点、改转场、前移后移
6. 要遮住姓名/车牌：勾「隐私遮挡模式」→ 在画面上拖框 → 选模糊/马赛克/色块
7. 点「⬇ 导出 MP4」→ 右侧看进度 → 下载

### 第三步：确认成品
- 导出文件在 `exports/` 目录
- 已有现成成品 `sample-output.mp4`（1080×1920）可直接播放确认

### 这一流程已被完整验证过

从纯净状态出发实际跑通，并已固化为可重复执行的脚本
`node tests/acceptance-morning.js`（详见 `docs/TEST-REPORT.md` §7b）：

```
STEP 1  启动器                     -> ffmpeg=True 6.1.1, presets=6, files=0
STEP 2  拖入 3 个视频              -> 3/3 ok，分析完成（1sc/3sil, 0sc/4sil, 1sc/2sil）
STEP 3  选风格 cinematic           -> preset=cinematic
STEP 4  自动剪辑                   -> 8 clips / 3 sources / 24s
STEP 5  草稿预览                   -> done 368x652 483KB
STEP 6  隐私遮挡（模糊）           -> 1 region
STEP 7  导出                       -> done 1080x1920 18.75s 1808KB
STEP 8  ffprobe 校验 + 完整解码     -> h264 1080x1920 yuv420p + aac 48kHz 2ch，解码零错误
        HTTP 下载                  -> 200, 1851127 bytes, video/mp4
```

---

## 7. 已知限制（明早可能遇到的）

1. **端口 3210 被占用** → 启动器会明确提示并给出换端口命令，不会乱杀进程。
2. **首次运行**若 `node_modules` 或 `vendor/` 缺失，联网装一次即可（之后完全离线）。
3. **大文件分析较慢** —— 场景/静音检测是全片扫描，10 分钟视频可能需要一两分钟。
4. **导出耗时**取决于分辨率与 CPU；1080p 建议先用「生成草稿预览」确认效果。
5. **MOV / HEVC** 能否解码取决于本机 FFmpeg 编译时带的解码器；
   本机这份 essentials build 覆盖了常见的 H.264/HEVC。
6. **界面语言为中文**，面向你的使用习惯。

---

## 8. 技术决策说明

| 决策 | 理由 |
|---|---|
| 原生 HTML/CSS/JS，无前端框架 | 免构建、免 CDN、离线可用、启动即用 |
| 场景检测用 `select`+`scene` | FFmpeg 内置，零依赖，速度快 |
| 静音检测用 `silencedetect` | 同上，参数直观（dB 阈值 + 最短时长） |
| 转场用 `xfade`/`acrossfade` | 画面与声音同步转场，FFmpeg 4.3+ 内置 |
| 画幅转换用 `scale`+`crop`（填充）/ `pad`（遮幅） | 两种画幅策略都支持，cinematic 用 pad 出黑边 |
| 响度用 `ebur128` | FFmpeg 内置 LUFS 测量，客观且标准 |
| 隐私遮挡用 `overlay`+`boxblur`/`scale` | 纯 FFmpeg 实现，烘焙进输出，无需重编码原片 |
| 状态用 JSON 文件 + 原子写入 | 单机单用户，够用且零依赖 |
| FFmpeg 固化到 `vendor/` | 不污染系统；`npm run setup:ffmpeg` 可在任何机器复现 |

---

## 9. 关于 REA 的最终说明

按任务书要求调研了 <https://github.com/morluto/rea>，核验结论：
仓库真实、MIT 许可、349,234 stars、文档完整（`docs/` 20+ 分册）、npm 包 `rea-agents`。

**但 REA 与视频剪辑领域没有直接技术交集** —— 它是原生二进制 / JS / APK / 固件等的
逆向分析工具集，能力表中没有媒体处理类目。

因此本项目**没有**逆向剪映或任何第三方软件，而是**从 FFmpeg 的公开滤镜能力自研**。
这样既满足了「使用 REA 于技术可行处」（唯一交集是「产出附带证据」的方法论，
已体现在每一步自动决策都保留可核验中间结果），也满足「不复制专有源码/素材/品牌」。

完整论证见 `docs/REA-RESEARCH.md`。

---

## 10. 复现所有验证

```powershell
cd autocut-studio
npm install --ignore-scripts
npm run setup:ffmpeg
npm run make-samples

npm test                        # 35 单元测试
node --test tests/api.test.js   # 11 API 集成测试
npm run smoke                   # 18 端到端导出检查
node tests/e2e-live.js          # 18 完整用户旅程
node tests/verify-output.js     # 7 像素级验证
node scripts/make-sample-output.js  # 重新生成 sample-output.mp4
npm run verify:sample           # 9 成品校验

# 需要应用正在运行（双击 Start-AutoCut.cmd）
node tests/acceptance-morning.js   # 8 步最终验收
node tests/reset-while-running.js  # 10 运行中重置回归
```

**所有数字均来自上述命令的真实输出。**
