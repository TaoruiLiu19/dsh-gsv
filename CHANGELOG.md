# 变更记录

本文件记录 dsh-gsv-tts 的所有版本更新。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[2.3.2]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.1...v2.3.2
[2.3.1]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/TaoruiLiu19/dsh-gsv/releases/tag/v2.0.0
