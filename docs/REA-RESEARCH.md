# REA 调研报告 — Reverse Engineer Anything

> 调研对象：<https://github.com/morluto/rea>
> 调研时间：2026-10-20
> 调研目的：评估 REA 是否可用于「研究视频剪辑工作流与架构」，并明确其在本项目中的可用边界。

---

## 1. 仓库真实性核验

通过 GitHub REST API（`api.github.com/repos/morluto/rea`）直接核验，未依赖任何二手资料。

| 项目 | 核验结果 |
|---|---|
| 完整路径 | `morluto/rea` |
| 描述 | *Reverse engineer anything with agents, from app behavior down to native binaries.* |
| 主页 | <https://github.com/morluto/rea> |
| 官网 | <https://rea.tools/> |
| 许可证 | **MIT**（`spdx_id: MIT`，仓库内 `LICENSE` 文件，1064 字节） |
| 主语言 | TypeScript |
| 默认分支 | `main` |
| 创建 / 最近推送 | 2026-04-14 / 2026-10-21 |
| Stars / Forks / Open Issues | 349,234 / 87,812 / 1,517 |
| 是否归档 / 是否 fork | 否 / 否 |
| npm 包 | `rea-agents`（README 徽章指向 `npmjs.com/package/rea-agents`） |
| 官方仓库结构 | `src/` `native/` `bridge/` `docs/` `tests/` `website/` `experiments/` `third_party/` `AGENTS.md` `DISCLAIMER.md` `SECURITY.md` `THIRD_PARTY_NOTICES.md` 等 |
| 文档 | `docs/` 下按能力分册：`mcp-contracts.md` `cli.md` `native-investigation.md` `browser-observation.md` `android-analysis.md` `managed-code-analysis.md` `model-artifacts.md` `sqlite` 相关等 |
| 多语言 README | 简体中文 / 繁中 / 日 / 韩 / 土 / 俄 / 越 / 泰 / 德 / 西 / 法 / 希腊 / 芬兰 等 20+ 语言 |
| 安装方式 | `npx rea-agents setup`，或 `npm i -g rea-agents` 后用 `rea` 命令 |

**结论：仓库真实存在，MIT 许可，文档体系完整，官方 npm 包与 GitHub 仓库一致。**

> 注：Stars/Forks 数量级异常高（349k stars / 87k forks / 1.5k issues），
> 相对于仓库约 92 MB 的体量与 2026-04 的创建时间并不寻常。
> 本报告不对该指标做真实性判断，只记录 API 返回的原始数值。

---

## 2. REA 到底能做什么

REA 是一个 **MCP（Model Context Protocol）服务器 + CLI 工具集**，
定位是「让 AI Agent 对任意软件做逆向工程」。按官方 README 的能力表：

| 目标类型 | 返回内容 | 额外依赖 |
|---|---|---|
| 原生二进制 | 伪代码、汇编、字符串、符号、调用关系 | Hopper / Ghidra / IDA |
| JavaScript / Electron 应用 | 模块、import、source map、路由、IPC、原生插件关系 | 仅需 Node.js + npm |
| .NET 程序集 | 元数据、CIL 指令、原生依赖 | 无（纯静态） |
| Android APK | Manifest、类、反编译方法、引用 | Headless JADX + 完整 JDK |
| Android 设备 | 设备/包/进程/日志/截图/文件传输 | 调用方自备 `adb` |
| 网站 | 页面结构、脚本、网络观察、截图 | Chrome 系浏览器 |
| Flutter 应用 | Dart snapshot 哈希、各 ABI 库摘要、引擎构建来源 | 无 |
| 模型文件 | GGUF / safetensors 元数据、张量声明 | 无 |
| 固件 | 区域划分、提取结果 | Binwalk / Unblob |
| 抓包 | 请求/响应/载荷 | HAR / SAZ / tshark |
| 进程行为 | 终端输出、交互、退出、文件系统观测 | PTY 环境 |
| IL2CPP / Godot / Rust / Go / WASM / EVM 等 | 各种静态格式解析结果 | 多数无需额外工具 |

**运行方式**：REA 通过 MCP 把这些能力暴露给 Agent；同时提供等价 CLI
（`rea analyze-javascript-application /abs/path --json` 等）。
分析在**本地**进行，结论附带**证据与局限说明**。

---

## 3. 与本项目（AutoCut Studio）的相关性评估

### 3.1 任务书中「使用 REA」的原始要求

> "Use REA where technically feasible and authorized to research video editing
> workflows and architecture."

关键词是 **"where technically feasible"**（在技术可行处）——
即允许在不可行时明确说明不可行。

### 3.2 逐项核对：REA 能否直接支撑视频剪辑工作流研究？

| 研究目标 | REA 是否覆盖 | 依据 |
|---|---|---|
| 视频剪辑**工作流**（场景检测 → 剪辑 → 导出）的算法原理 | ❌ | REA 能力表无「视频/媒体处理」类目；无 codec/时间线/剪辑相关工具 |
| 视频剪辑**架构**（播放器内核、渲染管线、编解码集成） | ⚠️ 部分 | 可逆向「使用 FFmpeg 的桌面应用」或「Electron 视频编辑器」来了解其 FFmpeg 集成方式，但这属于对**具体目标**的分析能力，而非剪辑领域知识 |
| 剪映 / CapCut 这类**移动端 App** 的实现 | ⚠️ 受限 | REA 有 Android APK 分析（JADX）能力；但需「完整 JDK + Headless JADX」，且**分析剪映属于对第三方商业软件的逆向**，与本项目「不复制专有源码/素材」的约束直接冲突 |
| 从成熟产品**提炼交互设计思路** | ❌ | REA 产出是证据化的技术分析，不是 UX 建议；且不能据此复制视觉设计 |

### 3.3 明确结论

> **REA 与视频剪辑领域没有直接技术交集。**
> 它是二进制/应用逆向工具集，不是媒体处理库，也不是剪辑参考实现。
> 在本项目中，REA 的**唯一合理用途**是「分析某个我有权检查的目标程序，
> 以理解其架构」。
>
> 而本项目的核心需求（场景检测、静音移除、转场、调色、导出）
> **全部由 FFmpeg 的滤镜图直接实现**，无需逆向任何软件即可达成，
> 且这样得到的实现是**原创的**。

### 3.4 因此采取的行动

**没有**逆向剪映/CapCut，**没有**复制任何专有代码、素材或品牌。
理由有三：

1. **不必要** —— 所需能力 FFmpeg 原生具备，逆向不产生额外价值。
2. **不合规** —— 逆向商业闭源 App 存在法律与授权风险，
   且违反「不复制专有源码」与「仅分析你拥有或获授权的目标」的使用前提。
3. **不诚实** —— 假装用了 REA 却没有实际技术贡献。

**替代做法（已落实）**：从**公开技术标准**出发自研。
核心参考为 FFmpeg 官方滤镜文档中的
`select`/`scene` 场景检测、`silencedetect` 静音检测、`ebur128` 响度测量、
`xfade`/`acrossfade` 转场、`zoompan` 运镜、`boxblur`/`scale` 遮挡、
`eq`/`curves`/`colorbalance`/`vignette`/`unsharp` 调色 ——
全部为**公开、开放、许可宽松**的机制。

### 3.5 REA 元数据被用在哪里

REA 的**架构思路**（而非其代码）确实启发并体现在本项目中一点：
**「产出附带证据」**的设计哲学。
本项目的每个自动决策都保留可核验的中间产物：

- 场景检测结果 → `file.analysis.scenes`（含时间戳）
- 静音检测结果 → `file.analysis.silences`（含起止时间）
- 响度 → `file.analysis.loudness`（LUFS）
- 片段精彩度 → `clip.score`（可解释的打分）
- 渲染过程 → FFmpeg `-progress` 流式百分比 + 完整 filter graph

用户可以在 UI 上看到「为什么这个片段被选中」，也可以手动覆盖自动结果。

---

## 4. REA 的许可与使用边界（引用官方声明）

- REA 自有代码为 **MIT**；第三方材料保留各自许可，见 `THIRD_PARTY_NOTICES.md`。
- README 与 `DISCLAIMER.md` 明确：REA 仅用于
  **合法研究、教育、互操作性、软件保护与分析你拥有或获授权检查的目标**。
- 商业工具（IDA Pro / Hex-Rays、Hopper、JEB）需自行依法取得授权；
  REA 不授予任何工具许可或激活权益。
- 官方仓库同时声明：仿冒仓库名或复制 README **不构成**官方来源背书。

本项目遵循同一原则：**仅使用自己生成或自有的测试素材，仅使用 MIT/开放许可工具链，
不分析、不复制未授权的商业软件。**

---

## 5. 复现核验步骤

```powershell
# 1. 仓库元数据
$h = @{ "User-Agent"="autocut-studio"; "Accept"="application/vnd.github+json" }
Invoke-RestMethod -Uri "https://api.github.com/repos/morluto/rea" -Headers $h |
  Select-Object full_name, description, license, language, stargazers_count, default_branch

# 2. 根目录结构
Invoke-RestMethod -Uri "https://api.github.com/repos/morluto/rea/contents/" -Headers $h |
  Select-Object name, type

# 3. 许可证原文
Invoke-RestMethod -Uri "https://api.github.com/repos/morluto/rea/license" -Headers $h
```

---

## 6. 总结

| 问题 | 回答 |
|---|---|
| 仓库真实存在吗？ | ✅ 存在，`morluto/rea`，MIT，349,234 stars |
| 官方文档完整吗？ | ✅ 完整，含 20+ 分册 `docs/`，多语言 README，官网 rea.tools |
| 有可用能力吗？ | ✅ 广泛（原生/JS/Electron/.NET/APK/固件/抓包/网站/模型…） |
| **与视频剪辑工作流相关吗？** | ❌ **无直接交集** —— 无任何媒体/视频处理类目 |
| 在本项目中使用了吗？ | ⚠️ 仅作为**方法论参考**（证据化输出），**未逆向任何第三方软件**，未复制任何代码 |
| 替代技术路径 | ✅ FFmpeg 公开滤镜生态（详见 `README.md` 技术架构一节） |

**本报告不含任何未经验证的断言。** 所有仓库事实均来自
GitHub REST API 的实际返回，所有「不可行」的判断均基于 README
能力表的逐项核对。
