# dsh-gsv-tts

DSH（DeepSeek Harness）插件，接入 [GSV-TTS-Lite](https://github.com/chinokikiss/GSV-TTS-Lite) 本地 TTS 服务。

## 功能

- **音色预设管理**：在设置中自定义多个音色，每个音色包含目标音色音频、提示音频、提示文本
- **语音合成**：`tts_speak` 工具，支持按音色名称选择，流式合成（SSE），音频落盘为 WAV 文件并通过 DSH Web 服务返回同源短链接（模型上下文不再被巨型 data URL 撑爆）
- **设置面板**：设置 → 插件配置 → 语音合成（GSV-TTS），可视化调整 API 地址、音色、自动朗读等，**保存即热生效**（无需重启）
- **朗读按钮**：每条助手消息的复制/点赞旁新增 🔊 按钮，朗读该条结果（自动排除思考内容）
- **引擎健康检查**：`tts_health_check` 工具，检测 API 服务、Python、pip 包、仓库状态
- **一键安装引擎**：`tts_setup_engine` 工具，辅助下载安装 GSV-TTS-Lite（pip install + git clone + 启动服务）
- **自动朗读**：开启后自动对助手回复合成语音

## 安装

```bash
dsh plugin --profile web add "github:TaoruiLiu19/dsh-gsv"
```

重启 DSH Web 后，4 个工具自动注册到 agent。

> 插件依赖 DSH 的 `webServer` 服务（Web / Desktop profile 自带）来提供音频文件下载；若无该服务会退回 data URL 方式。

## 配置

进入 **设置 → 插件 → dsh-gsv-tts**：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `apiUrl` | GSV-TTS-Lite API 地址 | `http://localhost:9880` |
| `voices` | 音色预设列表 | 空列表（需自行配置） |
| `defaultVoice` | 默认音色名称 | 留空则使用列表第一个 |
| `autoPlay` | 自动朗读助手回复 | `false` |
| `timeout` | 请求超时（毫秒） | `30000` |
| `installDir` | 引擎安装目录 | `./GSV-TTS-Lite` |

### 音色预设结构

每个音色包含：

| 字段 | 说明 |
|------|------|
| `name` | 音色名称（如"拉菲"），用于 `tts_speak` 的 `voice` 参数 |
| `speakerAudioPath` | 目标音色参考音频路径（决定合成声音像谁） |
| `promptAudioPath` | 提示音频路径（提供语调/情感参考） |
| `promptText` | 提示文本（对应提示音频文字）。留空时若引擎支持 ASR 会自动转写，否则合成会报错并提示补填 |

## 工具列表

| 工具 | 功能 |
|------|------|
| `tts_speak` | 文本转语音，支持选择音色 |
| `tts_list_voices` | 列出所有已配置的音色预设 |
| `tts_health_check` | 检查引擎安装和运行状态 |
| `tts_setup_engine` | 辅助安装 GSV-TTS-Lite 引擎 |

## 快速开始

1. 安装插件后，在对话中让 agent 调用 `tts_setup_engine` 自动安装引擎
2. 等待 10 秒后调用 `tts_health_check` 验证服务状态
3. 在设置中配置音色预设（填写参考音频路径与提示文本）
4. 调用 `tts_list_voices` 查看可用音色
5. 调用 `tts_speak` 朗读文本

## 技术栈

- DSH 插件框架：Cordis + `@deepseek-ai/dsh-tools`
- 配置 Schema：`@deepseek-ai/schemastery`
- TTS 引擎：GSV-TTS-Lite 0.4.7
- 语言：TypeScript / Python

## 构建

```bash
pnpm install
pnpm build
```

（从 GitHub 安装时会自动执行 `prepare` 脚本编译，无需手动构建。）

## 已知限制

- 播放方式为 markdown 链接点击播放；内嵌 `<audio>` 播放需客户端扩展（规划中）
- 合成音频以 WAV 文件形式保存在系统临时目录（`%TEMP%/dsh-gsv-tts`），插件启动时清空、会话内最多保留 200 个
- `tts_setup_engine` 通过 `child_process` 执行 pip/git 命令，需运行环境有对应工具
- 参考音频路径为 GSV-TTS-Lite API 服务端本地路径或可访问 URL
- `promptText` 留空时依赖引擎的 ASR 能力（能力探测），不支持时合成会返回明确错误

## 变更记录

- **2.2.0**：设置面板（设置 → 插件配置，保存即热生效）；消息操作区新增"朗读"按钮（排除思考内容，引擎未启动时给出明确原因）；设置新增"引擎"项（与"模型""插件"同级，开关控制引擎启停，默认关闭）；配置变更不再需要重启
- **2.1.0**：音频改由 DSH Web 服务同源提供（不再使用巨型 data URL）；WAV 文件头修复；时长计算修复；`prompt_text` 留空走 ASR 兜底；命令执行改用 `execFileSync`（消除命令注入面）；支持 Windows `py -3`；peer 依赖版本放宽；README 与代码对齐
