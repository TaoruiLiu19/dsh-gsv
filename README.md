# dsh-gsv-tts

> 为 DSH（DeepSeek Harness）接入语音朗读能力 —— 双模式可选：**云端快速体验**（Edge，免安装、装上即听）+ **本地专业**（GSV-TTS-Lite，音色克隆、完全离线）。

![CI](https://img.shields.io/github/actions/workflow/status/TaoruiLiu19/dsh-gsv/ci.yml?branch=master&label=CI&logo=github)
![npm](https://img.shields.io/npm/v/dsh-gsv-tts)
![Downloads](https://img.shields.io/npm/dt/dsh-gsv-tts)
![License](https://img.shields.io/npm/l/dsh-gsv-tts)
[![Listed on awesome-dsh-plugin](https://img.shields.io/badge/Listed%20on-awesome--dsh--plugin.com-8B5CF6?style=flat-square)](https://awesome-dsh-plugin.com/p/TaoruiLiu19/dsh-gsv/)

English README: [README_EN.md](README_EN.md) · 变更记录: [CHANGELOG.md](CHANGELOG.md)

---

## ✨ 功能亮点

- 🌐 **云端快速体验（Edge）**：**零配置、装上即用**，无需 Python / 模型 / 引擎；20+ 种免费自然语言音色（晓晓、云希、Aria 等），联网即用，< 1 秒出声
- 🖥️ **本地专业（GSV）**：按参考音频**克隆目标音色**、**完全离线**；由云端简单模式一键升级引导而来
- 🔊 **一键朗读**：每条助手消息旁的 🔊 按钮直接朗读（自动排除思考内容）；长回复**按句分段渐进播放**，带暂停/继续/停止与进度显示，正在朗读的消息会高亮
- 🔁 **自动朗读**：开启后自动朗读助手回复；新回复默认打断当前朗读（barge-in），可在设置中关闭
- 🔄 **模式切换**：设置面板一键在"快速体验 / 本地专业"间切换，音色与状态实时跟随
- 🎛️ **声音设置面板**：可视化配置，**保存即热生效**（无需重启）；每条音色可"试听"，或"全部试听"循环对比
- 🎪 **音色市场**：从内置/自定义远端清单**一键下载并注入音色**，试听后安装、只读托管；内置可信源免确认，远端源二次确认
- 🚀 **引擎一键启停 / 一键安装**：本地 GSV 引擎启停（模型加载约 15~90 秒）与自动安装，均由设置面板/工具完成
- 🔗 **同源音频短链接**：合成音频落盘并同源提供，不再撑爆模型上下文

---

## 🎯 快速上手（两种模式，任选其一）

| 你的诉求 | 用哪种 | 怎么开始 |
|---|---|---|
| "我就想**装上就能听**" | 🌐 **快速体验（Edge）** | 见下方「一、快速体验模式」——**无需任何安装** |
| "我要**克隆自己的声音 / 完全离线**" | 🖥️ **本地专业（GSV）** | 见下方「二、本地专业模式」 |

> **默认模式**：全新安装默认为 **Edge 快速体验**（联网即用）；**从旧版本升级的老用户仍保持 GSV 本地模式、声音不变**，可随时在设置面板切换。

### 一、快速体验模式（Edge，新装默认）

1. 安装插件并重启 DSH（见「📦 安装」）
2. 打开 设置 → 声音设置 → **TTS 模式**选 **快速体验（Edge）**
3. "音色"下拉选一个云端音色（晓晓 / 云希 / Aria…）
4. 点任意助手消息旁的 🔊 —— **立即出声，< 1 秒**

> 无需安装 Python、无需模型、无需启动引擎。仅需联网。云端音色标注 🌐，为您提供免配置即听的入口。

### 二、本地专业模式（GSV）

1. 安装插件并重启 DSH（见「📦 安装」）
2. 打开 设置 → 声音设置 → **TTS 模式**选 **本地专业（GSV）**
3. **安装引擎**：让 agent 调用 `tts_setup_engine`，或见「🔧 安装 GSV-TTS-Lite 引擎」
4. **启动引擎**：打开"启动引擎"开关，等待状态变为"运行中"
5. **添加音色**：在"音色预设"添加，或从「🎪 音色市场」一键下载，或克隆
6. 点任意助手消息旁的 🔊，或让 agent 调用 `tts_speak`

> 本地模式全程离线运行，支持音色克隆，不依赖网络与云端配额。

## 📦 安装

两种方式任选其一，然后在设置中启用：

```bash
# 方式一：从 npm 安装
dsh plugin --profile web add dsh-gsv-tts

# 方式二：从 GitHub 安装
dsh plugin --profile web add "github:TaoruiLiu19/dsh-gsv"
```

> **关于 profile**：以上以 `web` profile 为例；当前桌面应用常用 `desktop` profile，把命令里的 `web` 换成 `desktop` 即可。

安装后重启 DSH，工具自动注册到 agent，设置中出现"声音设置"项。

> 依赖 DSH 的 `webServer` 服务（Web / Desktop profile 自带）提供音频下载；`settings` 服务提供设置面板。无这些服务的环境仅保留工具能力。

## 🔄 模式切换与迁移

| 项 | 说明 |
|---|---|
| 如何切换 | 设置 → 声音设置 → **TTS 模式**（快速体验 / 本地专业），切换即时生效 |
| 配置项 | `provider: 'edge' \| 'gsv'`（初始化分派，建议经设置面板切换，勿手动改） |
| 老用户升级 | 无 `provider` 字段的旧配置 → 保持 `gsv` 本地模式，**声音不变** |
| 全新安装 | 默认 `edge` 云端简单模式，联网即用 |
| `schemaVersion` | 配置结构版本，迁移守卫的落点 |

> Edge 模式需联网；若云端不可用，面板会提示"云端通道拥挤 / 暂不可用"，本地 GSV 模式始终可用作降级。

---

## 🏗️ 系统架构

![dsh-gsv-tts 系统构成与数据流](docs/images/architecture.png)

> 📖 交互式架构图：[打开 dsh-gsv-tts.architecture.html](docs/architecture/dsh-gsv-tts.architecture.html)（支持缩放、聚焦、主题切换）

**双 provider 架构**：`TTSService` 按 `config.provider` 分发到云端（Edge）或本地（GSV），朗读主链路与工具调用两条路径对两种 provider 一致。

- 🔊 **朗读主链路（经 webServer）**：用户点击 🔊 → DSH Web 客户端 → `webServer` 的 `/speak` 路由 → `TTSService` 按 provider 请求 → 云端/本地引擎返回音频块 → `AudioStore` 落盘 → 同源短链接回传浏览器播放。
- 🤖 **Agent 工具调用（宿主内直连）**：Agent 调用 `tts_speak` 等工具时，由宿主进程内 tools 服务**直接**执行，**不经 webServer HTTP 网关**。

| 构成 | 说明 |
|------|------|
| DSH 应用（DeepSeek Harness） | 插件宿主：Web 客户端、webServer、settings 服务 |
| dsh-gsv-tts 插件 | `TTSService`（按 provider 分发）/ `AudioStore`（落盘）/ 引擎管理（启停·安装·健康检查） |
| Edge provider | `edge-tts-universal`，微软精选网络音色，返回 MP3 流（浏览器解码） |
| GSV-TTS-Lite 本地引擎 | 本机 Python 进程，FastAPI :9880，真流式 `/tts/stream`，返回 WAV |

## 📸 截图

![声音设置面板](docs/images/settings-voice.png)

*设置 → 声音设置：TTS 模式、引擎开关、音色配置、健康状态*

![朗读按钮](docs/images/read-button.png)

*消息操作区的 🔊 朗读按钮（悬停显示"朗读结果"）*

![引擎运行中](docs/images/engine-running.png)

*本地引擎启动后的"运行中"状态*

---

## 🌐 快速体验模式（Edge）详解

- **音色**：20+ 种微软精选自然音色（中文晓晓 / 云希 / 云野等，英文 Aria 等），面板下拉即选，无需配置。
- **输出**：MP3 音频流，由 `edge-tts-universal` 生成，经 `AudioStore` 落盘为 `.mp3` 并同源提供，浏览器直接解码（**无转码开销**）。
- **健康检测**：内置连接超时、令牌自动刷新与错误恢复；面板显示云端可用状态。
- **限流与降级**：微软可能对过量使用限流。若检测到云端不可用，面板会引导切到本地 GSV（无限量 + 可克隆）。
- **配额字段**：`quotaDaily`（默认 `null` = 不限量）为预留引导字段，硬配额待后续版本。

## 🖥️ 本地专业模式（GSV）详解

- **能力**：按参考音频**克隆目标音色**；完全离线运行，数据不出本机。
- **成本**：需安装 Python 环境 + 下载模型；首次模型加载约 15~90 秒。
- **入口**：见「🔧 安装 GSV-TTS-Lite 引擎」与「🎙️ 添加音色 / 音色市场」。

---

## 🔧 安装 GSV-TTS-Lite 引擎

### 方式一：自动安装（推荐）

让 agent 调用 `tts_setup_engine`，自动完成：检测 Python → 安装 `gsv-tts-lite==0.4.7` → 克隆仓库 → 安装依赖 → 部署流式 API → 启动服务。

### 方式二：手动安装

1. 安装 **Python 3.10+**（推荐 3.12），确保 `pip` 可用
2. 安装核心包：`pip install gsv-tts-lite==0.4.7`
3. 克隆仓库：`git clone https://github.com/chinokikiss/GSV-TTS-Lite.git`
4. 安装 API 依赖：`pip install -r <仓库>/API/requirements.txt`
5. 把本插件 `scripts/` 下的 `dsh_stream_api.py` 复制到 `<仓库>/API/` 目录（真流式 API）
6. 下载模型（`s1v3.ckpt`、`s2Gv2ProPlus.pth` 等）放入 `<仓库>/models/`
7. 启动：`python <仓库>/API/dsh_stream_api.py -p 9880 --models_dir <仓库>/models`
8. 在 设置 → 声音设置 打开引擎开关验证

> 引擎示例音频位于 `<仓库>/examples/`（`laffey.mp3`、`AnAn.ogg`），可直接用作测试音色。

## 🎪 音色市场

从音色市场一键下载并注入音色，无需手动填写参考音频路径。

> 🌐 **在线试听网站**：[https://taoruiliu19.github.io/gsv-market/](https://taoruiliu19.github.io/gsv-market/) —— 浏览、试听、下载市场中的全部音色，无需安装插件。

1. 打开 设置 → 声音设置 → **音色市场**
2. 浏览音色卡片（来源、作者、许可），点 **试听** 预听
3. 点 **安装**：
   - 内置可信清单（`trusted`）→ 直接安装
   - 自定义远端清单（`voiceRegistryUrl`）→ 二次确认来源与许可后安装
4. 安装后音色自动加入"音色预设"，即可在 🔊 / `tts_speak` 中选用
5. 市场安装的音色在面板中**只读**（仅可卸载），防止误改破坏账本；点 **卸载** 可（提示）同时删除本地音频

> **信任规则**：信任 = 随插件发版内置。仅包内离线清单且标记可信源时免确认；**任何远端清单一律二次确认**（即便自报可信）。自定义音色请在"音色预设"手工添加。

## 🎙️ 添加音色（本地 GSV）

1. 打开 设置 → 声音设置
2. "音色预设"下点击"添加音色"
3. 填写四个字段：

| 字段 | 说明 | 示例 |
|------|------|------|
| `音色名称` | 音色名，`tts_speak` 与 🔊 按钮按它选择 | `拉菲` |
| `参考音频路径` | 目标音色参考音频（决定声音像谁） | `D:\GSV\GSV-TTS-Lite\examples\laffey.mp3` |
| `提示音频路径` | 语调/情感参考音频 | `D:\GSV\GSV-TTS-Lite\examples\AnAn.ogg` |
| `提示文本` | 提示音频对应的文字（引擎不支持留空自动转写，务必填写） | `ちが……ちがう。レイア、貴様は間違っている。` |

4. 点击"保存"，立即生效，无需重启
5. 默认音色留空则使用列表第一个音色

> 参考音频路径必须是**引擎服务端能访问的本地路径或可访问 URL**。

## ⚙️ 声音设置说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| TTS 模式 | 快速体验（Edge 云端，免安装）/ 本地专业（GSV，离线/克隆） | 老用户 `gsv` / 新装 `edge` |
| 引擎开关 | 启动/停止 GSV-TTS-Lite 引擎进程 | 关 |
| `apiUrl` | 引擎 API 地址 | `http://localhost:9880` |
| `defaultVoice` | 默认音色（gsv=预设名 / edge=云端音色 id，留空用第一个） | 空 |
| `timeout` | 请求超时（毫秒） | `30000` |
| `installDir` | 引擎安装目录 | `./GSV-TTS-Lite` |
| `autoPlay` | 自动朗读助手回复 | `false` |
| `interruptOnNew` | 自动朗读时新回复是否打断当前朗读（关闭则朗读中跳过，避免叠音） | `true` |
| `voiceRegistryUrl` | 音色市场远端清单地址（留空使用包内离线清单） | 空 |
| `provider` | `gsv` \| `edge`（初始化分派，勿手动改；设置面板切换） | 见"TTS 模式" |
| `schemaVersion` | 配置结构版本（迁移守卫落点） | `1` |
| `quotaDaily` | 云端简单模式每日配额（`null`=不限量，仅引导用） | `null` |
| `voices` | 音色预设列表 | 空 |

配置保存在 DSH 的 settings（`~/.dsh/settings.yaml` 的 `dsh-gsv-tts:` 段），修改后插件热生效。

## 🧰 工具列表

| 工具 | 功能 |
|------|------|
| `tts_speak` | 文本转语音；按当前 provider 与音色选择，流式合成返回同源短链接 |
| `tts_list_voices` | 列出当前 provider 可用音色 |
| `tts_health_check` | 检查当前 provider（引擎/云端）状态 |
| `tts_setup_engine` | 一键安装本地 GSV-TTS-Lite 引擎 |

## ❓ 常见问题

- **装上怎么直接出声？**：默认 Edge 模式，无需任何安装，设置面板选音色即可；本地模式才需要装引擎。
- **引擎未启动（本地模式）**：设置 → 声音设置 → 打开引擎开关（模型加载约 15~90 秒）。
- **模型缺失**：首次启动会提示，把模型放入 `models` 目录。
- **朗读按钮报"语音引擎未启动"**：如果你用的是本地 GSV 模式，先到声音设置启动引擎；不想装引擎就切回 Edge 云端模式。
- **云端音色有的读不了？**：确认网络畅通；云端通道受限时可切本地 GSV。
- **参考音频不可用**：必须是引擎服务端可访问的本地路径或 URL。

## 🛠️ 技术栈

- DSH 插件框架：Cordis + `@deepseek-ai/dsh-tools`
- 配置 Schema：`@deepseek-ai/schemastery`
- 设置面板：`@deepseek-ai/dsh-settings` + 客户端 `settings.section` 插槽
- 云端 Provider：`edge-tts-universal`（微软网络音色，MP3 流）
- 本地引擎：GSV-TTS-Lite 0.4.7
- 语言：TypeScript（宿主）/ 手写客户端 bundle（浏览器）/ Python（本地流式 API）

## 📦 构建与发布

```bash
pnpm install
pnpm build        # 编译宿主代码（lib/）
pnpm publish      # 发布到 npm（files: lib, scripts, cordis.patch.yml）
```

从 GitHub 安装会自动执行 `prepare` 脚本编译；`lib/client.js` 为手写客户端 bundle，随仓库发布。

更多发布细节见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 📜 变更记录

完整更新历史见 [CHANGELOG.md](CHANGELOG.md)。

## ⚠️ 已知限制

- 播放为 markdown 链接点击播放；内嵌 `<audio>` 需客户端扩展（规划中）
- 合成音频存于系统临时目录（`%TEMP%/dsh-gsv-tts`），启动清空、会话内最多 200 个
- Edge 云端模式依赖网络；微软限量限流时可能不可用（已有降级引导）
- `tts_setup_engine` 通过 `child_process` 执行 pip/git，需环境有对应工具
- `promptText` 留空依赖引擎 ASR 能力（能力探测），不支持时合成报错

## 📄 License

本项目以 **MIT 许可证** 开源发布。

版权所有 © 2026 TaoruiLiu19。在软件的副本或主要部分中包含上述版权声明和本许可声明的前提下,任何人可免费复制、修改、合并、发布、分发、再授权及/或出售本软件副本。

本项目按"**原样**"提供,**不附带任何明示或默示保证**。完整许可条款见 [LICENSE](LICENSE) 文件。