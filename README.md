# dsh-gsv-tts

DSH（DeepSeek Harness）插件，接入 [GSV-TTS-Lite](https://github.com/chinokikiss/GSV-TTS-Lite) 本地 TTS 服务：音色克隆、流式合成、自动朗读、一键朗读、引擎一键启停。

## 功能

- **声音设置面板**：设置 → 声音设置，可视化配置引擎、音色、自动朗读等，**保存即热生效**（无需重启）
- **引擎开关**：一键启动/停止本地 GSV-TTS-Lite 引擎，默认关闭
- **朗读按钮**：每条助手消息的复制/点赞旁有 🔊 按钮，朗读该条结果（自动排除思考内容）；引擎未启动时给出明确原因
- **自动朗读**：开启后自动对助手回复合成语音
- **语音合成工具**：`tts_speak`（流式合成，返回同源短链接）、`tts_list_voices`、`tts_health_check`、`tts_setup_engine`
- **音频投递**：合成音频落盘为 WAV，经 DSH Web 服务同源短链接提供（模型上下文不再被巨型 data URL 撑爆）

## 安装

```bash
dsh plugin --profile web add "github:TaoruiLiu19/dsh-gsv"
```

重启 DSH 后，工具自动注册到 agent，设置中会出现"声音设置"项。

> 依赖 DSH 的 `webServer` 服务（Web / Desktop profile 自带）提供音频下载；`settings` 服务提供设置面板。无这些服务的环境仅保留工具能力。

## 快速开始

1. **安装引擎**：让 agent 调用 `tts_setup_engine` 自动安装（或见下方手动安装）
2. **启动引擎**：设置 → 声音设置 → 打开"启动引擎"开关，等待状态变为"运行中"（模型加载约 15~90 秒）
3. **添加音色**：设置 → 声音设置 → "音色预设" → 添加音色 → 填写四字段 → 保存
4. **朗读**：点任意助手消息旁的 🔊，或让 agent 调用 `tts_speak`

## 下载安装 GSV-TTS-Lite 引擎

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

## 添加音色

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

## 声音设置说明

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

## 工具列表

| 工具 | 功能 |
|------|------|
| `tts_speak` | 文本转语音，支持按音色选择，流式合成返回同源短链接 |
| `tts_list_voices` | 列出已配置的音色预设 |
| `tts_health_check` | 检查引擎/API/Python/仓库状态 |
| `tts_setup_engine` | 一键安装 GSV-TTS-Lite 引擎 |

## 常见问题

- **引擎未启动**：设置 → 声音设置 → 打开开关（模型加载约 15~90 秒）
- **模型缺失**：首次启动会提示，把模型放入 `models` 目录
- **朗读按钮报"语音引擎未启动"**：先到 声音设置 启动引擎
- **参考音频不可用**：必须是引擎服务端可访问的本地路径或 URL

## 技术栈

- DSH 插件框架：Cordis + `@deepseek-ai/dsh-tools`
- 配置 Schema：`@deepseek-ai/schemastery`
- 设置面板：`@deepseek-ai/dsh-settings` + 客户端 `settings.section` 插槽
- TTS 引擎：GSV-TTS-Lite 0.4.7
- 语言：TypeScript（宿主）/ 手写客户端 bundle（浏览器）/ Python（流式 API）

## 构建

```bash
pnpm install
pnpm build
```

（从 GitHub 安装会自动执行 `prepare` 脚本编译；`lib/client.js` 为手写客户端 bundle，随仓库发布。）

## 变更记录

- **2.2.0**：声音设置面板（保存即热生效）；引擎一键启停开关；🔊 朗读按钮（排除思考，引擎未启动给出原因）；设置内帮助文档；音频同源短链接
- **2.1.0**：音频改由 DSH Web 服务同源提供（不再用巨型 data URL）；WAV 头/时长计算修复；`prompt_text` 留空 ASR 兜底；`execFileSync` 消除命令注入；`py -3` 支持；健康检查路径探测

## 已知限制

- 播放为 markdown 链接点击播放；内嵌 `<audio>` 需客户端扩展（规划中）
- 合成音频存于系统临时目录（`%TEMP%/dsh-gsv-tts`），启动清空、会话内最多 200 个
- `tts_setup_engine` 通过 `child_process` 执行 pip/git，需环境有对应工具
- `promptText` 留空依赖引擎 ASR 能力（能力探测），不支持时合成报错
