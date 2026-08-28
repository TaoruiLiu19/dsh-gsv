# Changelog

All notable changes to dsh-gsv-tts are documented in this file. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.2] - 2026-08-28

- Align the `@deepseek-ai/dsh-tools` peer dependency range (`^0.1.0-rc.6`) with the lockfile
- CI: `pnpm/action-setup` reads the version from the `packageManager` field
- Docs: added CI/npm badges and 2.3.x changelog entries to the READMEs

## [2.3.1] - 2026-08-28

- Completed npm publish metadata (`keywords`, `license`, `repository`, ...) for plugin-marketplace discovery
- Added GitHub Actions CI and a pre-publish manifest check (`npm run verify`)
- Added `docs/PUBLISHING.md`

## [2.3.0] - 2026-08-27

- True-streaming client improvements and engine compatibility patch
- Added engine-install and voice-download guides
- Added UI screenshots
- Bilingual README rewrite with clear npm/GitHub install paths

## [2.2.0] - 2026-08-26

- Voice Settings panel (hot-applied, no restart needed)
- One-click engine switch
- 🔊 read-aloud button (excludes reasoning; clear error when the engine is off)
- In-settings help documentation
- Same-origin audio short links

## [2.1.0] - 2026-08-25

- Same-origin audio served by the DSH web server (no more giant data URLs)
- WAV header/duration calculation fixes
- ASR fallback when `prompt_text` is empty
- `execFileSync` (no shell injection)
- `py -3` support
- Health-check path probing

## [2.0.0] - 2026-08-24

- Initial release: integrates the GSV-TTS-Lite local TTS engine
- Ships four tools: `tts_speak` / `tts_list_voices` / `tts_health_check` / `tts_setup_engine`

[2.3.2]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.1...v2.3.2
[2.3.1]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/TaoruiLiu19/dsh-gsv/releases/tag/v2.0.0
