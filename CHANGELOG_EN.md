# Changelog

All notable changes to dsh-gsv-tts are documented in this file. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-08-30

### Voice Registry one-click install (P2)
- Voice market: bundled offline manifest (`docs/voices.json`) or a custom remote source (`voiceRegistryUrl`, fetched server-side with no-cache)
- Trust rule: trust = shipped with the plugin — only the bundled manifest with `trusted: true` installs without confirmation; **any remote manifest requires two-phase confirmation** (even if it self-reports trusted), and phase 1 downloads nothing
- Three tools `tts_voice_registry` / `tts_voice_install` / `tts_voice_remove` plus same-origin HTTP routes `registry/{list,install,remove}`, sharing one core
- Install: download → sha256 verification → size/extension whitelist → atomic staging under `<installDir>/voices/<id>/` → write back to `Config.voices` (id + source bookkeeping); failures leave no partial files and never touch config
- Read-only managed voices: `source:'registry'` entries are read-only in the panel (uninstall only); removal matches by id, refuses custom voices, and clears a dangling `defaultVoice`
- New "Voice Market" card in the panel: source/trust badge, preview (reuses /preview), two-phase confirmed install, delete-files confirm on uninstall
- Unit tests wired into CI: manifest validation, trust boundaries, atomic writes, uninstall guards, path traversal

## [2.6.0] - 2026-08-29

### Settings panel enhancements (P1-3)
- Per-voice "Preview" button: synthesizes a fixed preview sentence and plays it — **unsaved draft voices can be previewed too**, perfect for ear-based voice picking
- New "Preview all (loop)": synthesizes every voice and loops through them for comparison, with pause/stop; failed voices are reported
- The engine status bar + one-click start/stop at the top of the panel have been available since 2.2.0; unchanged in this release

## [2.5.0] - 2026-08-29

### Read-aloud text cleaning (P0-1)
- Filter Markdown tables (data rows and separator rows); only non-table prose is read
- Length guards with friendly messages: 6000 chars for `tts_speak`, 30000 for read-aloud/auto-read
- Unified empty-text handling: replies containing only code/links/tables now get a clear hint
- Added unit tests (`npm test`, built on node:test, zero new dependencies) for the cleaner and the segmenter

### Progressive segmented playback (P1-1)
- New `TTSService.synthesizeSegments`: splits text into sentences (CJK enders/`、`/English periods, ≤ 800 chars per segment), synthesizes each, 0-gap stitching
- `/dsh-gsv-tts/speak` now returns an ordered URL queue (`segments`); single-URL fields kept for compatibility
- The client player auto-advances on `<audio>` `ended` — long replies start speaking without waiting for full synthesis

### Playback controls (P1-2)
- Pause / Resume / Stop across the whole segment queue (current segment + in-segment position remembered)
- Progress display (elapsed / total + segment index)
- Highlight the message currently being read (pulsing outline)

### Auto-read barge-in (P0-2)
- Auto-read is now "notify → client synthesizes on demand": the server bumps a seq, the client polls for new replies
- New replies interrupt current playback by default; toggleable via the new `interruptOnNew` setting (skip while reading instead of overlapping)

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

[2.6.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.2...v2.5.0
[2.3.2]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.1...v2.3.2
[2.3.1]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/TaoruiLiu19/dsh-gsv/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/TaoruiLiu19/dsh-gsv/releases/tag/v2.0.0
