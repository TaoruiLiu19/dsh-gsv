# dsh-gsv-tts

> 为 DSH（DeepSeek Harness）接入 [GSV-TTS-Lite](https://github.com/chinokikiss/GSV-TTS-Lite) 本地 TTS 引擎 —— 音色克隆、流式合成、自动朗读、一键朗读、引擎一键启停，全程本地运行。

![CI](https://img.shields.io/github/actions/workflow/status/TaoruiLiu19/dsh-gsv/ci.yml?branch=master&label=CI&logo=github)
![npm](https://img.shields.io/npm/v/dsh-gsv-tts)
![Downloads](https://img.shields.io/npm/dt/dsh-gsv-tts)
![License](https://img.shields.io/npm/l/dsh-gsv-tts)
[![Listed on awesome-dsh-plugin](https://img.shields.io/badge/Listed%20on-awesome--dsh--plugin.com-8B5CF6?style=flat-square)](https://awesome-dsh-plugin.com/p/TaoruiLiu19/dsh-gsv/)

English README: [README_EN.md](README_EN.md) · 变更记录: [CHANGELOG.md](CHANGELOG.md)

---

## ✨ 功能亮点

- 🎙️ **音色克隆**：按参考音频克隆目标音色，`tts_speak` 按名称选用
- ⚡ **真流式合成**：SSE 逐块合成，首块到达即推送，低首包延迟
- 🔊 **一键朗读**：每条助手消息旁的 🔊 按钮直接朗读（自动排除思考内容）
- 🔁 **自动朗读**：开启后自动为助手回复合成语音
- 🎛️ **声音设置面板**：设置 → 声音设置，可视化配置，**保存即热生效**（无需重启）
- 🚀 **引擎一键启停**：一键启动/停止本地 GSV-TTS-Lite 引擎，模型加载约 15~90 秒
- 🛠️ **一键安装引擎**：`tts_setup_engine` 自动检测 Python、安装依赖、克隆仓库并启动服务
- 🔗 **同源音频短链接**：合成音频落盘为 WAV，经 DSH Web 服务同源提供，不再撑爆模型上下文

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

## 🚀 快速开始

1. **安装引擎**：让 agent 调用 `tts_setup_engine` 自动安装（或见下方手动安装）
2. **启动引擎**：设置 → 声音设置 → 打开"启动引擎"开关，等待状态变为"运行中"
3. **添加音色**：设置 → 声音设置 → "音色预设" → 添加音色 → 填写四字段 → 保存
4. **朗读**：点任意助手消息旁的 🔊，或让 agent 调用 `tts_speak`

## 🏗️ 系统架构

![dsh-gsv-tts 系统构成与数据流](docs/images/architecture.png)

> 📖 交互式架构图：[打开 dsh-gsv-tts.architecture.html](docs/architecture/dsh-gsv-tts.architecture.html)（支持缩放、聚焦、主题切换）

**两条调用路径**：

- 🔊 **朗读主链路（经 webServer）**：用户点击 🔊 → DSH Web 客户端 → `webServer` 的 `/speak` 路由 → 插件从会话中提取消息文本 → `TTSService` 流式请求引擎 → 引擎 SSE 逐块返回音频 → `AudioStore` 拼接 WAV 落盘 → 同源短链接回传浏览器播放。
- 🤖 **Agent 工具调用（宿主内直连）**：Agent 调用 `tts_speak` 等工具时，由宿主进程内 tools 服务**直接**执行插件逻辑，**不经 webServer HTTP 网关**——图中以虚线表示，与 🔊 按钮路径区分。

| 构成 | 说明 |
|------|------|
| DSH 应用（DeepSeek Harness） | 插件宿主：Web 客户端、webServer、settings 服务 |
| dsh-gsv-tts 插件 | `TTSService`（流式合成）/ `AudioStore`（WAV 落盘）/ 引擎管理（启停·安装·健康检查） |
| GSV-TTS-Lite 本地引擎 | 本机 Python 进程，FastAPI :9880，真流式 `/tts/stream` |

## 📸 截图

![声音设置面板](docs/images/settings-voice.png)

*设置 → 声音设置：引擎开关、TTS 配置、帮助文档*

![朗读按钮](docs/images/read-button.png)

*消息操作区的 🔊 朗读按钮（悬停显示"朗读结果"）*

![引擎运行中](docs/images/engine-running.png)

*引擎启动后的"运行中"状态*

## 🔧 下载安装 GSV-TTS-Lite 引擎

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

## 🎙️ 添加音色

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
| 引擎开关 | 启动/停止 GSV-TTS-Lite 引擎进程 | 关 |
| `apiUrl` | 引擎 API 地址 | `http://localhost:9880` |
| `defaultVoice` | 默认音色（留空用第一个） | 空 |
| `timeout` | 请求超时（毫秒） | `30000` |
| `installDir` | 引擎安装目录 | `./GSV-TTS-Lite` |
| `autoPlay` | 自动朗读助手回复 | `false` |
| `voices` | 音色预设列表 | 空 |

配置保存在 DSH 的 settings（`~/.dsh/settings.yaml` 的 `dsh-gsv-tts:` 段），修改后插件热生效。

## 🧰 工具列表

| 工具 | 功能 |
|------|------|
| `tts_speak` | 文本转语音，支持按音色选择，流式合成返回同源短链接 |
| `tts_list_voices` | 列出已配置的音色预设 |
| `tts_health_check` | 检查引擎/API/Python/仓库状态 |
| `tts_setup_engine` | 一键安装 GSV-TTS-Lite 引擎 |

## ❓ 常见问题

- **引擎未启动**：设置 → 声音设置 → 打开开关（模型加载约 15~90 秒）
- **模型缺失**：首次启动会提示，把模型放入 `models` 目录
- **朗读按钮报"语音引擎未启动"**：先到 声音设置 启动引擎
- **参考音频不可用**：必须是引擎服务端可访问的本地路径或 URL

## 🛠️ 技术栈

- DSH 插件框架：Cordis + `@deepseek-ai/dsh-tools`
- 配置 Schema：`@deepseek-ai/schemastery`
- 设置面板：`@deepseek-ai/dsh-settings` + 客户端 `settings.section` 插槽
- TTS 引擎：GSV-TTS-Lite 0.4.7
- 语言：TypeScript（宿主）/ 手写客户端 bundle（浏览器）/ Python（流式 API）

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
- `tts_setup_engine` 通过 `child_process` 执行 pip/git，需环境有对应工具
- `promptText` 留空依赖引擎 ASR 能力（能力探测），不支持时合成报错

## 📄 License

本项目以 **MIT 许可证** 开源发布。

版权所有 © 2026 TaoruiLiu19。在软件的副本或主要部分中包含上述版权声明和本许可声明的前提下,任何人可免费复制、修改、合并、发布、分发、再授权及/或出售本软件副本。

本项目按"**原样**"提供,**不附带任何明示或默示保证**。完整许可条款见 [LICENSE](LICENSE) 文件。
