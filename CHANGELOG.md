# 变更记录

本文件记录 dsh-gsv-tts 的所有版本更新。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [3.0.0] - 2026-08-30

### 音色 Registry 一键安装（P2）
- 音色市场：包内离线清单（`docs/voices.json`）或自定义远端源（`voiceRegistryUrl`，服务端拉取带 no-cache）
- 信任规则：信任 = 随插件发版内置——仅包内清单且 `trusted` 为真免确认；**任何远端清单一律两阶段确认**（即便自报 trusted），阶段 1 不下载任何字节
- 三工具 `tts_voice_registry` / `tts_voice_install` / `tts_voice_remove` + 同源 HTTP 路由 `registry/{list,install,remove}`，共享核心
- 安装：下载 → sha256 强校验 → 大小/后缀白名单 → 原子落盘 `<installDir>/voices/<id>/` → 写回 `Config.voices`（id + source 账本），失败不留半成品、不写配置
- 只读托管：`source:'registry'` 音色在设置面板只读、仅可卸载；卸载按 id 精确匹配，自定义音色拒绝删，`defaultVoice` 悬空一并清空
- 面板新增"音色市场"卡：来源/信任徽标、试听（复用 /preview）、两阶段确认安装、卸载删除文件确认
- 单测并入 CI：清单校验、信任边界、原子写、卸载护栏、路径穿越

## [2.6.0] - 2026-08-29

### 设置面板增强（P1-3）
- 每条音色新增"试听"按钮：用固定试听文案单次合成并播放（**未保存的草稿音色也能直接试听**，便于"靠耳朵挑"）
- 新增"全部试听（循环）"：批量合成所有音色后循环播放，边听边对比，可暂停/停止；失败音色给出提示
- 面板顶栏的引擎运行状态 + 一键启停自 2.2.0 起已提供，本次无改动

## [2.5.0] - 2026-08-29

### 朗读净化补全（P0-1）
- 过滤 markdown 表格（数据行与分隔行），只读表格外的正文
- 超长文本保护：`tts_speak` 单段上限 6000 字符，朗读/自动朗读分段上限 30000 字符，超限给出友好提示
- 空文本判断与合成口径统一：清洗后为空（只有代码/链接/表格）的回复返回明确提示
- 新增单元测试（`npm test`，基于 node:test，零新增依赖）：净化器与句切分器

### 渐进分段播放（P1-1）
- 服务端新增 `TTSService.synthesizeSegments`：按句切分（中文句末标点、顿号 + 英文句点，单段 ≤ 800 字）逐段流式合成，段间 0 静音
- `/dsh-gsv-tts/speak` 返回可顺序播放的 URL 队列（`segments`），兼容旧单 URL 字段
- 前端播放器按 `<audio>` ended 事件自动续播下一段——长回复不再等整段合成完才出声

### 朗读控件（P1-2）
- 朗读按钮新增 暂停 / 继续 / 停止 三键，作用于整个分段队列（记录当前段 + 段内时间）
- 显示朗读进度（已播 / 总时长 + 段序号）
- 高亮正在朗读的那条消息（呼吸边框）

### 自动朗读打断（P0-2）
- 自动朗读改为"通知 → 前端按需合成播放"：服务端递增 seq，前端轮询感知新回复
- 新回复到来时默认打断当前朗读（barge-in）；设置中可关闭 `interruptOnNew`，朗读中跳过新回复避免叠音

## [2.3.2] - 2026-08-28

- 对齐 `@deepseek-ai/dsh-tools` peer 依赖范围（`^0.1.0-rc.6`），与 lockfile 一致
- CI：`pnpm/action-setup` 从 `packageManager` 字段读取版本
- 文档：README 补充 CI/npm 徽章与 2.3.x 变更记录

## [2.3.1] - 2026-08-28

- 补全 npm 发布元数据（`keywords`、`license`、`repository` 等）以支持插件市场收录
- 新增 GitHub Actions CI 与发布前 manifest 校验（`npm run verify`）
- 新增 `docs/PUBLISHING.md` 发布指南

## [2.3.0] - 2026-08-27

- 真流式客户端改进与引擎兼容补丁
- 补充引擎安装与语音下载指南
- 新增界面截图
- README 双语重写，明确 npm / GitHub 双通道安装

## [2.2.0] - 2026-08-26

- 声音设置面板（保存即热生效，无需重启）
- 引擎一键启停开关
- 🔊 朗读按钮（排除思考内容；引擎未启动时给出明确原因）
- 设置内帮助文档
- 音频同源短链接

## [2.1.0] - 2026-08-25

- 音频改由 DSH Web 服务同源提供（不再用巨型 data URL）
- WAV 头/时长计算修复
- `prompt_text` 留空时 ASR 兜底
- `execFileSync` 消除命令注入风险
- `py -3` 支持
- 健康检查路径探测

## [2.0.0] - 2026-08-24

- 首个正式版本：接入 GSV-TTS-Lite 本地 TTS 引擎
- 提供 `tts_speak` / `tts_list_voices` / `tts_health_check` / `tts_setup_engine` 四个工具

[2.6.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.2...v2.5.0
[2.3.2]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.1...v2.3.2
[2.3.1]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/TaoruiLiu19/dsh-gsv/releases/tag/v2.0.0
