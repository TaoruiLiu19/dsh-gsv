// dsh-gsv-tts 客户端插件（手写 bundle，遵循 DSH client module 格式）
// - 消息操作区（复制/点赞旁）增加"朗读"按钮：朗读该条助手结果（不含思考），调用宿主 /dsh-gsv-tts/speak
// - 长回复渐进分段播放：/speak 返回 URL 队列，播放器按 <audio> ended 事件顺序续播，段间 0 静音
// - 播放控件：暂停 / 继续 / 停止 + 进度显示 + 当前消息高亮（作用于整个队列）
// - 自动朗读（barge-in）：轮询 /dsh-gsv-tts/autoplay/poll，新回复到来时按 interruptOnNew 打断或跳过
// - 设置 → 插件配置：dsh-gsv-tts 设置卡片（音色、自动朗读、打断开关、API 等，保存后热生效）
// - 音色试听：每条音色旁“试听”按钮（草稿未保存也能试听）+ “全部试听”批量循环播放
// - 音色市场：包内离线/远端清单拉取、两阶段确认安装、卸载（注册表音色只读托管）
window.__ModuleLoader__.load({
	id: "dsh-gsv-tts",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsx = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// ─── 样式注入 ───
		const css = "._gsv_action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex;font-size:14px}._gsv_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}._gsv_action:disabled{cursor:default;opacity:.4}._gsv_failure{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-left:6px}._gsv_action_active{color:var(--dsw-alias-brand,#6e56cf)!important;background:var(--dsw-alias-interactive-bg-hover)}._gsv_paused{opacity:.7}._gsv_controls{display:inline-flex;align-items:center;gap:2px}._gsv_progress{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:4px;font-variant-numeric:tabular-nums;white-space:nowrap}._gsv_turn_active{outline:1px solid var(--dsw-alias-brand,#6e56cf);outline-offset:2px;border-radius:8px;animation:_gsv_pulse 2s ease-in-out infinite}@keyframes _gsv_pulse{0%,100%{outline-color:var(--dsw-alias-brand,#6e56cf)}50%{outline-color:transparent}}";
		let actionStyle = null;
		let lifecycle;
		function installActionStyles() {
			actionStyle = document.createElement("style");
			actionStyle.dataset.plugin = "dsh-gsv-tts";
			actionStyle.dataset.pluginCss = "dsh-gsv-tts/read-button.css";
			actionStyle.textContent = css + "::highlight(dsh-gsv-sentence){background-color:var(--dsw-alias-interactive-bg-hover,#eae6ff);color:inherit}";
			document.head.appendChild(actionStyle);
		}

		function onDeactivate(cleanup, signal = lifecycle?.signal) {
			let active = true;
			const dispose = () => {
				if (!active) return;
				active = false;
				signal?.removeEventListener("abort", dispose);
				cleanup();
			};
			if (signal?.aborted) dispose();
			else signal?.addEventListener("abort", dispose, { once: true });
			return dispose;
		}

		async function pluginFetch(url, options = {}, lifetime = lifecycle?.signal) {
			const signal = lifetime && options.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime || options.signal;
			signal?.throwIfAborted();
			const response = await fetch(url, signal ? { ...options, signal } : options);
			signal?.throwIfAborted();
			return response;
		}

		// ─── 文案 ───
		const NS = "gsv-tts";
// DeepSeek 官方音色是固定的两个：直接内置，切模式不发网络请求
const DEEPSEEK_VOICE_OPTIONS = [
	{ id: "stella", name: "海星（女声）" },
	{ id: "tide", name: "暗潮（男声）" },
];

// 提供方目录兜底（服务端 /provider/catalog 可用时以其为准）：Tab、能力、默认音色都从这里来
const DEFAULT_PROVIDER_CATALOG = [
	{
		id: "custom", label: "自定义 TTS", i18nKey: "mode.custom", badge: "cloud", defaultVoice: "af_sarah",
		description: "OpenAI-compatible /audio/speech",
		capabilities: { needsEngine: false, needsKey: false, network: true, voiceSource: "builtin", streaming: true }
	},
	{
		id: "edge",
		label: "快速体验（Edge）",
		i18nKey: "mode.quick",
		description: "微软 Edge 云端声音，免安装免配置，需要联网",
		badge: "cloud",
		defaultVoice: "",
		capabilities: { needsEngine: false, needsKey: false, network: true, voiceSource: "remote", cloning: false, customVoices: false, billed: false, streaming: false, formats: ["mp3"] }
	},
	{
		id: "deepseek",
		label: "官方语音（DeepSeek）",
		i18nKey: "mode.official",
		description: "DeepSeek 官方 TTS，复用 Harness 凭据，按字符计费",
		badge: "official",
		defaultVoice: "stella",
		capabilities: { needsEngine: false, needsKey: true, network: true, voiceSource: "builtin", cloning: false, customVoices: false, billed: true, streaming: true, formats: ["wav"] }
	},
	{
		id: "gsv",
		label: "本地克隆（GSV）",
		i18nKey: "mode.pro",
		description: "本地 GSV-TTS-Lite，离线 / 隐私 / 音色克隆",
		badge: "local",
		defaultVoice: "",
		capabilities: { needsEngine: true, needsKey: false, network: false, voiceSource: "presets", cloning: true, customVoices: true, billed: false, streaming: true, formats: ["wav"] }
	}
];
		const zh = {
			"mode.custom": "自定义 TTS",
			"field.liveReply": "生成时逐句朗读可见正文",
			"field.usage": "查看朗读用量和性能",
			"field.modelIntegrity": "校验模型 SHA-256",
			"field.modelManifest": "模型版本和 SHA-256 清单路径",
			"field.synthesisSpeed": "GSV 合成语速",
			"field.deepseekBudget": "DeepSeek 每日自动朗读计费字符上限（空白不限，0 禁止）",
			"read": "朗读结果",
			"reading": "朗读中…",
			"pause": "暂停",
			"resume": "继续",
			"stop": "停止",
			"cardTitle": "声音设置",
			"cardDesc": "调整 TTS 音色、自动朗读等设置，保存后即时生效。",
			"cardLoadFailed": "声音设置加载失败",
			"cardLoading": "声音设置加载中…",
			"cardUnavailable": "声音设置不可用：当前宿主没有提供设置服务。",
			"field.apiUrl": "API 地址",
			"field.apiUrlHint": "GSV-TTS-Lite 服务地址",
			"field.defaultVoice": "默认音色",
			"field.cloudVoice": "云端音色",
			"currentVoice": "当前音色",
			"field.defaultVoiceHint": "留空使用第一个音色",
			"mode.title": "TTS 模式",
			"mode.quick": "快速体验（Edge 云端）",
			"mode.pro": "本地专业（GSV）",
			"mode.badgeCloud": "🌐 云端",
			"mode.badgeLocal": "🖥️ 本地·离线",
			"mode.quickDesc": "微软 Edge 云端声音，免安装免配置，需要联网",
			"mode.proDesc": "本地 GSV-TTS-Lite，离线 / 隐私 / 音色克隆",
			"mode.official": "官方语音（DeepSeek）",
			"mode.badgeOfficial": "🌐 官方·计费",
			"mode.officialDesc": "DeepSeek 官方 TTS（海星/暗潮），复用已有 Key，按字符计费",
			"field.apiKey": "DeepSeek API Key",
			"field.apiKeyHint": "留空 = 直接复用 Harness 凭据；填写则覆盖",
			"field.apiKeyReuse": "默认复用 Harness 已配置的 DEEPSEEK_API_KEY（模型设置里保存的那个），无需再填 Key",
			"field.apiKeyRef": "凭据名称",
			"field.apiKeyRefHint": "默认 DEEPSEEK_API_KEY；留空则不查 Harness 凭据",
			"mode.healthOk": "云端通道正常",
			"mode.healthDown": "云端通道暂不可用",
			"mode.healthBusy": "云端体验通道拥挤，建议切换本地无限引擎",
			"mode.switchPro": "✨ 本地无限量 + 可克隆音色 → 一键切换",
			"mode.marketGsvOnly": "音色市场（本地克隆素材）仅本地专业模式可用",
			"voice.default": "（跟随默认）",
			"field.autoPlay": "自动朗读助手回复",
			"field.interruptOnNew": "新回复打断当前朗读",
			"field.interruptOnNewHint": "关闭后朗读中遇到新回复会跳过，避免叠音",
			"field.lexicon": "发音词典",
			"field.lexiconHint": "# 每行 原词=读法，例如：`nDSH=DeepSeek`nGSV=G S V",
			"field.lexiconDesc": "对所有模式生效；英文不区分大小写，长词优先；替换只做一次",
			"field.timeout": "请求超时（毫秒）",
			"field.installDir": "引擎安装目录",
			"field.voices": "音色预设",
			"voice.name": "音色名称",
			"voice.speaker": "参考音频路径",
			"voice.prompt": "提示音频路径",
			"voice.promptText": "提示文本",
			"voice.add": "添加音色",
			"voice.remove": "删除",
			"voice.preview": "试听",
			"voice.previewAll": "全部试听（循环）",
			"voice.previewAllSeq": "全部试听",
			"voice.previewing": "试听中…",
			"market.title": "音色市场",
			"market.desc": "从清单安装音色（包内离线 / 自定义远端源）；第三方来源安装需确认。",
			"market.website": "在线试听网站",
			"market.load": "加载市场",
			"market.loading": "加载中…",
			"market.refresh": "刷新",
			"market.sourceBundled": "包内清单",
			"market.sourceRemote": "远端清单",
			"market.trusted": "官方可信",
			"market.untrusted": "第三方（安装需确认）",
			"market.installed": "已安装",
			"market.install": "安装",
			"market.uninstall": "卸载",
			"market.registryTag": "市场安装",
			"market.confirmInstallTitle": "确认安装第三方音色？",
			"market.confirmInstallBody": "请核对来源、作者与许可：",
			"market.confirm": "确认安装",
			"market.cancel": "取消",
			"market.confirmRemoveTitle": "卸载音色？",
			"market.confirmRemoveBody": "是否同时删除本地音频文件？",
			"market.removeDelete": "删除文件",
			"market.removeKeep": "保留文件",
			"save": "保存",
			"saving": "保存中…",
			"saveRejected": "部分设置未被宿主接受，请检查取值后重试。",
			"discard": "放弃修改",
			"readOnly": "本部署的设置只读。",
			"unsaved": "未保存",
			"engineNav": "声音设置",
			"engineTitle": "语音引擎（GSV-TTS-Lite）",
			"engineDesc": "选择引擎启动方式。默认节能（与旧版一致）；想要更快的首次朗读可切到常驻。",
			"engineOn": "启动引擎",
			"engineOff": "停止引擎",
			"engineRunning": "运行中",
			"engineStopped": "已停止",
			"engineStarting": "启动中…（模型加载需要一些时间）",
			"engineStopping": "停止中…",
			"engineNotNeeded": "云端模式无需本地引擎",
			"engineMode.title": "引擎启动方式",
			"engineMode.always": "常驻模式（性能优先）",
			"engineMode.alwaysDesc": "插件加载后自动启动并预热，首次出声较快。常驻约 0.9GB 显存 + 0.5GB 内存。",
			"engineMode.eco": "节能模式（资源优先）",
			"engineMode.ecoDesc": "不后台启动，不朗读时不占资源；首次出声较慢（需要先加载模型）。与旧版行为一致。",
			"engineMode.saveFailed": "切换启动方式失败，请重试",
			"helpTitle": "帮助"
		};
		const en = {
			"mode.custom": "Custom TTS",
			"field.liveReply": "Read visible sentences while the reply streams",
			"field.usage": "Speech usage and performance",
			"field.modelIntegrity": "Verify model SHA-256",
			"field.modelManifest": "Model version and SHA-256 manifest path",
			"field.synthesisSpeed": "GSV synthesis speed",
			"field.deepseekBudget": "Daily billable DeepSeek auto-read characters (blank: unlimited, 0: disabled)",
			"read": "Read result",
			"reading": "Reading…",
			"pause": "Pause",
			"resume": "Resume",
			"stop": "Stop",
			"cardTitle": "Voice Settings",
			"cardDesc": "Adjust TTS voices and auto-read; changes apply instantly.",
			"cardLoadFailed": "Failed to load voice settings",
			"cardLoading": "Loading voice settings…",
			"cardUnavailable": "Voice settings unavailable: this host does not provide a settings service.",
			"field.apiUrl": "API URL",
			"field.apiUrlHint": "GSV-TTS-Lite service URL",
			"field.defaultVoice": "Default voice",
			"field.cloudVoice": "Cloud voice",
			"currentVoice": "Current voice",
			"field.defaultVoiceHint": "Empty uses the first voice",
			"mode.title": "TTS Mode",
			"mode.quick": "Quick (Edge cloud)",
			"mode.pro": "Local Pro (GSV)",
			"mode.badgeCloud": "🌐 Cloud",
			"mode.badgeLocal": "🖥️ Local·Offline",
			"mode.quickDesc": "Microsoft Edge cloud voices, zero setup, requires network",
			"mode.proDesc": "Local GSV-TTS-Lite: offline / private / voice cloning",
			"mode.official": "Official (DeepSeek)",
			"mode.badgeOfficial": "🌐 Official·Billed",
			"mode.officialDesc": "DeepSeek official TTS (Stella/Tide), reuses your API key, billed per character",
			"field.apiKey": "DeepSeek API Key",
			"field.apiKeyHint": "Empty = reuse the Harness credential; filling it overrides",
			"field.apiKeyReuse": "Reuses the DEEPSEEK_API_KEY already configured in the Harness (the one saved in model settings); no key needed here",
			"field.apiKeyRef": "Credential name",
			"field.apiKeyRefHint": "Defaults to DEEPSEEK_API_KEY; leave empty to skip the Harness credential service",
			"mode.healthOk": "Cloud channel healthy",
			"mode.healthDown": "Cloud channel temporarily unavailable",
			"mode.healthBusy": "Cloud channel is congested; switch to the unlimited local engine",
			"mode.switchPro": "✨ Unlimited local + cloneable voices → switch with one click",
			"mode.marketGsvOnly": "Voice market (local clone materials) is only available in Local Pro mode",
			"voice.default": "(follow default)",
			"field.autoPlay": "Auto-read assistant replies",
			"field.interruptOnNew": "New replies interrupt current read",
			"field.interruptOnNewHint": "When off, new replies are skipped while reading to avoid overlap",
			"field.lexicon": "Pronunciation lexicon",
			"field.lexiconHint": "# One  from=reading  per line, e.g.`nDSH=DeepSeek`nGSV=G S V",
			"field.lexiconDesc": "Applies to every mode; ASCII matching ignores case, longest match wins, single pass",
			"field.timeout": "Timeout (ms)",
			"field.installDir": "Engine install directory",
			"field.voices": "Voices",
			"voice.name": "Name",
			"voice.speaker": "Speaker audio path",
			"voice.prompt": "Prompt audio path",
			"voice.promptText": "Prompt text",
			"voice.add": "Add voice",
			"voice.remove": "Remove",
			"voice.preview": "Preview",
			"voice.previewAll": "Preview all (loop)",
			"voice.previewAllSeq": "Preview all",
			"voice.previewing": "Previewing…",
			"market.title": "Voice Market",
			"market.desc": "Install voices from a manifest (bundled offline / custom remote); third-party sources require confirmation.",
			"market.website": "Online audition site",
			"market.load": "Load market",
			"market.loading": "Loading…",
			"market.refresh": "Refresh",
			"market.sourceBundled": "Bundled manifest",
			"market.sourceRemote": "Remote manifest",
			"market.trusted": "Official trusted",
			"market.untrusted": "Third-party (confirm to install)",
			"market.installed": "Installed",
			"market.install": "Install",
			"market.uninstall": "Uninstall",
			"market.registryTag": "Market",
			"market.confirmInstallTitle": "Install third-party voice?",
			"market.confirmInstallBody": "Review source, author and license:",
			"market.confirm": "Confirm install",
			"market.cancel": "Cancel",
			"market.confirmRemoveTitle": "Uninstall voice?",
			"market.confirmRemoveBody": "Also delete the local audio files?",
			"market.removeDelete": "Delete files",
			"market.removeKeep": "Keep files",
			"save": "Save",
			"saving": "Saving…",
			"saveRejected": "Some settings were rejected by the host; check the values and try again.",
			"discard": "Discard",
			"readOnly": "Settings are read-only in this deployment.",
			"unsaved": "Unsaved",
			"engineNav": "Voice Settings",
			"engineTitle": "Speech Engine (GSV-TTS-Lite)",
			"engineDesc": "Choose how the engine starts. Eco (default, same as before) uses no resources when idle; Always gives the fastest first read.",
			"engineOn": "Start engine",
			"engineOff": "Stop engine",
			"engineRunning": "Running",
			"engineStopped": "Stopped",
			"engineStarting": "Starting… (model loading takes a while)",
			"engineStopping": "Stopping…",
			"engineNotNeeded": "Local engine is not needed in cloud mode",
			"engineMode.title": "Engine startup",
			"engineMode.always": "Always on (performance)",
			"engineMode.alwaysDesc": "Starts and pre-warms with the plugin; first audio is faster. Holds ~0.9 GB VRAM + 0.5 GB RAM.",
			"engineMode.eco": "Eco (resources first)",
			"engineMode.ecoDesc": "No background start and no idle cost; first audio is slower (model loading needed). Same as before.",
			"engineMode.saveFailed": "Could not change the startup mode; please retry",
			"helpTitle": "Help"
		};

		// ─── 全局朗读播放器单例 ───
		// 任意时刻最多一个朗读队列在播；start 新队列即打断旧队列（barge-in）。
		// 暂停/继续作用于整个队列：记录当前段 + 段内时间，恢复后从原处续播。
		let activeSpeak = null; // 进行中的流式朗读请求（AbortController）
		const playbackPrefs = { speed: 1, volume: 1, follow: false };
		try {
			const stored = JSON.parse(localStorage.getItem("dsh-gsv-tts:player") || "{}");
			if ([0.75, 1, 1.25, 1.5, 1.75, 2].includes(stored.speed)) playbackPrefs.speed = stored.speed;
			if (Number.isFinite(stored.volume) && stored.volume >= 0 && stored.volume <= 1) playbackPrefs.volume = stored.volume;
			playbackPrefs.follow = stored.follow === true;
		} catch { /* 浏览器禁止或尚无本地存储 */ }
		const acceptSpeech = () => playbackPrefs.follow ? "application/x-ndjson" : "audio/wav, application/x-ndjson;q=0.9";
		function applyPlaybackPrefs(audio) {
			if (!audio) return;
			audio.playbackRate = playbackPrefs.speed;
			audio.volume = playbackPrefs.volume;
			audio.preservesPitch = true;
		}
		function updatePlaybackPref(field, value) {
			playbackPrefs[field] = value;
			applyPlaybackPrefs(player.audio);
			try { localStorage.setItem("dsh-gsv-tts:player", JSON.stringify(playbackPrefs)); } catch {}
		}
		let firstAudioProbe = null;
		let lastCaptions = [];
		function microphoneActive() {
			return typeof document !== "undefined" && Boolean(document.querySelector(
				'[data-voice-activity="requesting"], [data-voice-activity="recording"], [data-voice-activity="transcribing"]'
			));
		}
		const player = {
			state: "idle", // idle | loading | playing | paused
			key: null,     // 当前队列标识：`${sessionId}:${messageId}` 或 `autoplay:${seq}`
			queue: [],
			// 待播队列：不打断时（interruptOnNew=false）新回复排队，当前队列自然播完自动补读
			backlog: [],
			index: 0,
			audio: null,
			error: null,
			streamingKey: null, // 流式朗读中：队列暂时播空时保持 loading，等下一段到达
			waitingForSegment: false,
			listeners: new Set(),
			_tick: 0,
			subscribe(fn) {
				player.listeners.add(fn);
				return () => player.listeners.delete(fn);
			},
			getSnapshot() {
				return player._tick;
			},
			_emit() {
				player._tick += 1;
				for (const fn of player.listeners) {
					try { fn(player); } catch { /* 忽略订阅者异常 */ }
				}
			},
			_stopAudio() {
				if (player.audio) {
					const a = player.audio;
					player.audio = null;
					a.pause();
					try { a.src = ""; a.load(); } catch { /* 忽略 */ }
				}
			},
			stop() {
					player.streamingKey = null;
					player.waitingForSegment = false;
					player._stopAudio();
					player.state = "idle";
					player.key = null;
					player.queue = [];
					player.index = 0;
					player.error = null;
					player.backlog = [];
					player.loop = false;
					player._emit();
				},
				play(key, segments, opts) {
					// 打断式播放（barge-in）：停止当前并清空待播队列
					player.stop();
					player._start(key, segments, opts);
				},
				// 排队式播放：空闲则直接播；正在播则进入待播队列，当前队列播完自动补读
				enqueue(key, segments, opts) {
					const list = segments || [];
					if (list.length === 0) {
						player.error = "empty";
						player._emit();
						return;
					}
					if (player.state === "idle") {
						player._start(key, list, opts);
					} else {
						player.backlog.push({ key, segments: list, opts });
					}
					player._emit();
				},
				// 流式朗读：标记当前 key 为流式，队列暂时播空时不结束播放。
				beginStream(key) {
					player.streamingKey = key;
				},
				// 流式追加：同一 key 的后继分段接到队列尾部；若当前已播空则立刻续播。
				push(key, segments) {
					const list = segments || [];
					if (list.length === 0) return;
					if (player.key === key || player.streamingKey === key) {
						const startAt = player.queue.length;
						player.queue.push(...list);
						if (player.state === "loading" && startAt === player.index + 1) {
							player._playIndex(startAt);
						} else {
							player._emit();
						}
						return;
					}
					player.enqueue(key, list);
				},
				endStream(key) {
					if (player.streamingKey === key) {
						player.streamingKey = null;
						if (player.waitingForSegment) player._finish();
					}
				},
				_start(key, segments, opts) {
					const list = segments || [];
					if (list.length === 0) {
						player.error = "empty";
						player._emit();
						return;
					}
					player.key = key;
					player.queue = list.slice();
					player.index = 0;
					player.error = null;
					player.loop = !!(opts && opts.loop); // 循环播放（全部试听用）
					player.state = "loading";
					player._emit();
					player._playIndex(0);
				},
				// 队列自然播完：循环则从头再来；否则有待播则继续补读，再否则回到 idle
				_finish() {
					// 流式朗读还没收到 done：保持 loading，等下一段 push 到达后续播
					if (player.streamingKey && player.streamingKey === player.key) {
						player.waitingForSegment = true;
						player.state = "loading";
						player._emit();
						return;
					}
					if (player.loop && player.queue.length > 0) {
						player._playIndex(0);
					} else if (player.backlog.length) {
						const next = player.backlog.shift();
						player._start(next.key, next.segments, next.opts);
					} else {
						lastCaptions = player.queue.filter(segment => segment.text && segment.duration);
						player.stop();
					}
				},
			_playIndex(i) {
				if (lifecycle?.signal.aborted || microphoneActive()) { player.stop(); return; }
					const seg = player.queue[i];
					if (!seg) {
						player._finish();
						return;
					}
				player.index = i;
				player.waitingForSegment = false;
				const audio = new Audio(seg.url);
				player.audio = audio;
				applyPlaybackPrefs(audio);
				player.state = "playing";
				player._emit();
				audio.addEventListener("playing", () => {
					const probe = firstAudioProbe;
					if (player.audio !== audio || !probe || probe.key !== player.key) return;
					firstAudioProbe = null;
					pluginFetch("api/dsh-gsv-tts/metrics", { method: "POST", headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ provider: probe.provider, firstAudioMs: performance.now() - probe.startedAt }) }).catch(() => {});
				});
				audio.addEventListener("ended", () => {
					if (player.audio !== audio) return;
					player._playIndex(i + 1);
				});
				audio.addEventListener("error", () => {
					if (player.audio !== audio) return;
					player.stop();
					player.error = "audio-error";
					player._emit();
				});
				audio.addEventListener("timeupdate", () => {
					if (player.audio === audio) player._emit();
				});
				audio.addEventListener("pause", () => {
					if (player.audio === audio && player.state === "playing") {
						player.state = "paused";
						player._emit();
					}
				});
				audio.addEventListener("play", () => {
					if (player.audio === audio) {
						player.state = "playing";
						player._emit();
					}
				});
				audio.play().catch(() => {
					if (player.audio !== audio) return;
					player.state = "paused";
					player.error = "play-denied";
					player._emit();
				});
			},
			pause() {
				if (player.audio && player.state === "playing") {
					player.audio.pause();
					player.state = "paused";
					player._emit();
				}
			},
			resume() {
				if (player.audio && player.state === "paused") {
					player.state = "playing";
					player._emit();
					player.audio.play().catch(() => {
						player.state = "paused";
						player._emit();
					});
				}
			},
			isActive(key) {
				return (player.state === "playing" || player.state === "paused" || player.state === "loading") && player.key === key;
			},
			progress() {
				const cur0 = player.audio;
				if (cur0 && !isFinite(cur0.duration)) {
					// 流式 WAV：总长未知，只报已播时间
					return { elapsed: cur0.currentTime || 0, total: 0, index: player.index, count: player.queue.length, live: true };
				}
				let elapsed = 0;
				for (let i = 0; i < player.index; i++) elapsed += player.queue[i]?.duration || 0;
				let total = 0;
				for (const s of player.queue) total += s.duration || 0;
				const cur = player.audio;
				if (cur) {
					const d = isFinite(cur.duration) && cur.duration > 0 ? cur.duration : (player.queue[player.index]?.duration || 0);
					if (player.index < player.queue.length) {
						elapsed += Math.min(cur.currentTime || 0, d);
						total = total - (player.queue[player.index]?.duration || 0) + d;
					}
				}
				return { elapsed, total, index: player.index, count: player.queue.length };
			}
		};

		// 自动播放解锁：首次用户手势时触碰一次 AudioContext，规避浏览器自动播放策略
		function installAudioUnlock() {
			let context, timer;
			const removeListeners = () => {
				document.removeEventListener("pointerdown", unlock);
				document.removeEventListener("keydown", unlock);
			};
			const release = () => {
				clearTimeout(timer);
				if (context) { void context.close().catch(() => {}); context = null; }
			};
			const unlock = () => {
				removeListeners();
				try {
					const AC = window.AudioContext || window.webkitAudioContext;
					if (AC) {
						context = new AC();
						void context.resume().catch(() => {});
						timer = setTimeout(release, 50);
					}
				} catch { /* AudioContext unavailable */ }
			};
			document.addEventListener("pointerdown", unlock);
			document.addEventListener("keydown", unlock);
			return () => { removeListeners(); release(); };
		}

		function formatTime(sec) {
			if (!isFinite(sec) || sec < 0) sec = 0;
			const m = Math.floor(sec / 60);
			const s = Math.floor(sec % 60);
			return m + ":" + String(s).padStart(2, "0");
		}

		// 读取 NDJSON 流式朗读响应：每段到达即回调；首段 play、后续 push。
		async function readSpeakStream(resp, onSegment) {
			if (!resp.body) throw new Error("stream body missing");
			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let count = 0;
			let error = null;
			const handle = (line) => {
				const text = line.trim();
				if (!text) return;
				let msg;
				try { msg = JSON.parse(text); } catch { return; }
				if (msg.type === "segment" && msg.url) {
					count += 1;
					onSegment({ url: msg.url, duration: msg.duration || 0, text: msg.text, cues: msg.cues }, count === 1);
				} else if (msg.type === "error") {
					error = msg.message || "stream error";
				}
			};
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop();
					for (const line of lines) handle(line);
				}
				handle(buffer + decoder.decode());
				return { count, error };
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}

		// 用户主动停止：先中断流式/整段请求，再清空播放队列。
		function stopPlayback() {
			firstAudioProbe = null;
			lastCaptions = [];
			if (activeSpeak) {
				activeSpeak.abort();
				activeSpeak = null;
			}
			if (fullAbort) {
				fullAbort.abort();
				fullAbort = null;
			}
			fullBusy = false;
			if (gsvPanel) gsvPanel.style.display = "none";
			player.stop();
		}

		// ─── 整段播放 / 下载面板 ───
		// 默认朗读仍是流式（首音快）；只有点「整段」或「下载」才生成完整文件。
		let gsvPanel = null;
		let panelStyle = null;
		let unsubscribePanel = null;
		let fullCtx = null;
		let fullAbort = null;
		let fullUrl = null;
		let fullBusy = false;

		function ensurePanelStyles() {
			if (typeof document === "undefined" || panelStyle) return;
			const style = document.createElement("style");
			style.dataset.gsvPanel = "1";
			style.textContent = "._gsv_panel{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:320px;padding:10px 12px 12px;border-radius:12px;background:var(--dsw-alias-bg-elevated,#1f1f23);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.16));box-shadow:0 10px 30px rgba(0,0,0,.45);display:none;font-size:12px;font-family:inherit;text-align:left}._gsv_panel_row{display:flex;align-items:center;gap:2px}._gsv_panel_row button{background:0 0;border:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:5px 7px;border-radius:6px}._gsv_panel_row button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12))}._gsv_panel_row button:disabled{opacity:.5;cursor:default}._gsv_panel_time{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.8;white-space:nowrap;padding:0 4px}._gsv_panel_dl{color:inherit;text-decoration:none;padding:5px 7px;border-radius:6px;white-space:nowrap;cursor:pointer;opacity:.45}._gsv_panel_dl:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12))}._gsv_panel_dl[href]{opacity:1}._gsv_range{width:100%;margin:10px 0 0;accent-color:var(--dsw-alias-brand,#6e56cf);cursor:pointer}._gsv_range:disabled{opacity:.4;cursor:default}._gsv_menu{position:fixed;z-index:2147483001;display:none;min-width:160px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-elevated,#1f1f23);border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.16));box-shadow:0 8px 24px rgba(0,0,0,.4)}._gsv_menu button{display:block;width:100%;text-align:left;background:0 0;border:none;color:var(--dsw-alias-label-primary,#eee);font-size:12px;padding:7px 9px;border-radius:7px;cursor:pointer}._gsv_menu button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12))}";
			document.head.appendChild(style);
			panelStyle = style;
		}

		function ensurePanel() {
			if (gsvPanel || typeof document === "undefined" || !document.body) return gsvPanel;
			ensurePanelStyles();
			const el = document.createElement("div");
			el.className = "_gsv_panel";
			const row = document.createElement("div");
			row.className = "_gsv_panel_row";
			const mk = (label, title, onClick) => {
				const b = document.createElement("button");
				b.type = "button";
				b.textContent = label;
				b.title = title;
				b.addEventListener("click", onClick);
				return b;
			};
			const toggle = mk("⏸", "暂停 / 继续", () => {
				if (player.state === "playing") player.pause();
				else if (player.state === "paused") player.resume();
			});
			const stop = mk("⏹", "停止", () => stopPlayback());
			const full = mk("整段", "生成整段音频（可拖动进度）", () => { void loadFull(true); });
			const time = document.createElement("span");
			time.className = "_gsv_panel_time";
			time.textContent = "0:00 / 0:00";
			const dl = document.createElement("a");
			dl.className = "_gsv_panel_dl";
			dl.textContent = "⬇";
			dl.title = "整段下载";
			dl.setAttribute("download", "speech.wav");
			dl.addEventListener("click", async (e) => {
				e.preventDefault();
				const context = fullCtx;
				if (!fullUrl) await loadFull(false);
				if (!fullUrl || fullCtx !== context) return;
				const a = document.createElement("a");
				a.href = fullUrl;
				a.download = downloadName(fullUrl);
				document.body.appendChild(a);
				a.click();
				a.remove();
			});
			const close = mk("✕", "关闭", () => stopPlayback());
			row.append(toggle, stop, full, time, dl, close);
			const controls = document.createElement("div");
			controls.className = "_gsv_panel_row _gsv_secondary";
			const previous = mk("上一句", "播放上一句", () => jumpSentence(-1));
			const next = mk("下一句", "播放下一句", () => jumpSentence(1));
			const speed = document.createElement("select");
			speed.setAttribute("aria-label", "播放倍速");
			for (const rate of [0.75, 1, 1.25, 1.5, 1.75, 2]) {
				const option = document.createElement("option");
				option.value = String(rate);
				option.textContent = rate + "×";
				speed.appendChild(option);
			}
			speed.value = String(playbackPrefs.speed);
			speed.addEventListener("change", () => updatePlaybackPref("speed", Number(speed.value)));
			const volume = document.createElement("input");
			volume.type = "range";
			volume.min = "0"; volume.max = "1"; volume.step = "0.05";
			volume.value = String(playbackPrefs.volume);
			volume.setAttribute("aria-label", "音量");
			volume.style.width = "68px";
			volume.addEventListener("input", () => updatePlaybackPref("volume", Number(volume.value)));
			const follow = document.createElement("label");
			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.checked = playbackPrefs.follow;
			checkbox.addEventListener("change", () => updatePlaybackPref("follow", checkbox.checked));
			follow.append(checkbox, "逐句跟读");
			follow.title = "下一次朗读使用逐句播放和文字对齐";
			const subtitles = mk("SRT", "下载当前朗读字幕", downloadSubtitles);
			controls.append(previous, next, speed, volume, follow, subtitles);
			controls.style.flexWrap = "wrap";
			const caption = document.createElement("div");
			caption.className = "_gsv_caption";
			caption.style.marginTop = "6px";
			const range = document.createElement("input");
			range.type = "range";
			range.className = "_gsv_range";
			range.min = "0";
			range.max = "0";
			range.step = "0.1";
			range.value = "0";
			range.disabled = true;
			range.addEventListener("input", () => {
				const a = player.audio;
				if (!a || !isFinite(a.duration) || a.duration <= 0) return;
				const v = Math.max(0, Math.min(Number(range.value), a.duration - 0.05));
				try { a.currentTime = v; } catch { /* 忽略 */ }
				time.textContent = formatTime(v) + " / " + formatTime(a.duration);
			});
			el.append(row, range, controls, caption);
			document.body.appendChild(el);
			gsvPanel = el;
			unsubscribePanel = player.subscribe(updatePanel);
			updatePanel();
			return el;
		}

		function updatePanel() {
			if (!gsvPanel) return;
			const active = player.state !== "idle" || lastCaptions.length > 0 || Boolean(player.error);
			gsvPanel.style.display = active ? "block" : "none";
			if (!active) { globalThis.CSS?.highlights?.delete("dsh-gsv-sentence"); return; }
			const a = player.audio;
			const dur = a && isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
			const cur = a ? (a.currentTime || 0) : 0;
			const range = gsvPanel.querySelector("._gsv_range");
			const time = gsvPanel.querySelector("._gsv_panel_time");
			const toggle = gsvPanel.querySelector("button");
			const full = gsvPanel.querySelectorAll("button")[2];
			const dl = gsvPanel.querySelector("a");
			const [previous, next, subtitles] = gsvPanel.querySelectorAll("._gsv_secondary button");
			previous.disabled = player.index <= 0 || !player.queue[player.index]?.text;
			next.disabled = player.index >= player.queue.length - 1 || !player.queue[player.index]?.text;
			subtitles.disabled = !lastCaptions.length && !player.queue.some(segment => segment.text && segment.duration);
			const caption = gsvPanel.querySelector("._gsv_caption");
			renderCaption(caption, player.queue[player.index], cur);
			if (player.error && player.state === "idle") {
				caption.hidden = false;
				caption.textContent = player.error === "audio-error" ? "音频播放失败" : player.error;
			}
			range.max = String(dur || 0);
			range.disabled = !(dur > 0);
			if (document.activeElement !== range) range.value = String(Math.min(cur, dur || cur));
			time.textContent = formatTime(cur) + " / " + (dur > 0 ? formatTime(dur) : "--:--");
			toggle.textContent = player.state === "paused" ? "▶" : "⏸";
			if (full) {
				full.disabled = fullBusy || !fullCtx;
				full.textContent = fullBusy ? "生成中…" : "整段";
			}
			if (fullUrl) {
				dl.href = fullUrl;
				dl.setAttribute("download", downloadName(fullUrl));
			} else {
				dl.removeAttribute("href");
			}
		}

		function jumpSentence(direction) {
			const index = player.index + direction;
			if (index < 0 || index >= player.queue.length || !player.queue[index]?.text) return;
			player._stopAudio();
			player._playIndex(index);
		}

		function renderCaption(element, segment, time) {
			const text = segment?.text || "";
			const cue = segment?.cues?.find(item => time >= item.start && time < item.end);
			let boundary = -1;
			let from = 0;
			if (cue) for (const item of segment.cues) {
				const match = text.indexOf(item.text, from);
				if (item === cue) { boundary = match; break; }
				if (match >= 0) from = match + item.text.length;
			}
			const key = text + "\n" + (cue?.start ?? "");
			if (element.dataset.cue === key) return;
			element.dataset.cue = key;
			element.hidden = !text;
			element.textContent = text;
			if (boundary >= 0) {
				const mark = document.createElement("mark");
				mark.textContent = cue.text;
				element.replaceChildren(text.slice(0, boundary), mark, text.slice(boundary + cue.text.length));
			}
			const highlights = globalThis.CSS?.highlights;
			highlights?.delete("dsh-gsv-sentence");
			const turn = text && document.querySelector("._gsv_turn_active");
			if (!turn || !highlights || typeof Highlight === "undefined") return;
			const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const node = walker.currentNode;
				const start = node.textContent.indexOf(text);
				if (start < 0) continue;
				const range = document.createRange();
				range.setStart(node, start);
				range.setEnd(node, start + text.length);
				highlights.set("dsh-gsv-sentence", new Highlight(range));
				break;
			}
		}

		function downloadSubtitles() {
			const stamp = seconds => new Date(Math.max(0, Math.round(seconds * 1000))).toISOString().slice(11, 23).replace(".", ",");
			let offset = 0;
			const entries = [];
			for (const segment of player.queue.length ? player.queue : lastCaptions) {
				if (segment.text && segment.duration > 0) {
					entries.push((entries.length + 1) + "\n" + stamp(offset) + " --> " + stamp(offset + segment.duration) + "\n" + segment.text);
				}
				offset += segment.duration || 0;
			}
			if (!entries.length) return;
			const url = URL.createObjectURL(new Blob([entries.join("\n\n"), "\n"], { type: "application/x-subrip;charset=utf-8" }));
			const link = document.createElement("a");
			link.href = url;
			link.download = "speech.srt";
			link.click();
			let timer;
			const dispose = onDeactivate(() => {
				clearTimeout(timer);
				URL.revokeObjectURL(url);
			});
			if (!lifecycle?.signal.aborted) timer = setTimeout(dispose, 1000);
		}

		function downloadName(url) {
			return new URL(url, document.baseURI).searchParams.get("file") || "speech.wav";
		}

		function showPanel(ctx) {
			fullAbort?.abort();
			fullAbort = null;
			lastCaptions = [];
			fullCtx = ctx ? { ...ctx, followText: playbackPrefs.follow } : null;
			fullUrl = null;
			fullBusy = false;
			ensurePanel();
			if (gsvPanel) gsvPanel.style.display = "block";
			updatePanel();
		}

		async function loadFull(play) {
			if (!fullCtx || fullBusy) return;
			if (fullUrl && play) {
				player.play("full:" + Date.now(), [{ url: fullUrl, duration: 0 }]);
				return;
			}
			const context = fullCtx;
			if (activeSpeak) {
				activeSpeak.abort();
				activeSpeak = null;
			}
			if (!play) player.stop();
			const ac = new AbortController();
			fullAbort = ac;
			fullBusy = true;
			updatePanel();
			try {
				const resp = await pluginFetch("api/dsh-gsv-tts/speak/full", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(context),
					signal: ac.signal
				});
				const data = await resp.json().catch(() => ({}));
				if (ac.signal.aborted || fullCtx !== context) return;
				if (!resp.ok || !data.audioUrl) throw new Error(data.message || ("HTTP " + resp.status));
				fullUrl = data.audioUrl;
				if (play) {
					player.play("full:" + Date.now(), [{ url: data.audioUrl, duration: data.duration || 0 }]);
				}
			} catch (e) {
				if (!(e && e.name === "AbortError")) {
					try { console.warn("[dsh-gsv-tts] 整段生成失败:", e); } catch { /* 忽略 */ }
				}
			} finally {
				if (fullAbort === ac) {
					fullAbort = null;
					fullBusy = false;
					updatePanel();
				}
			}
		}

		// 消费 /speak 的三种响应：NDJSON 分段、流式 WAV、旧 JSON 分段
		async function playSpeakResponse(resp, key, signal, onStart, startedAt = performance.now()) {
			signal?.throwIfAborted();
			if (microphoneActive()) return;
			const ctype = resp.headers.get("content-type") || "";
			if (!resp.ok) {
				const data = await resp.json().catch(() => ({}));
				throw new Error(data.message || ("HTTP " + resp.status));
			}
			const provider = resp.headers.get("X-DSH-GSV-Provider");
			if (provider) firstAudioProbe = { key, provider, startedAt };
			if (ctype.includes("application/x-ndjson")) {
				try {
					const { count, error } = await readSpeakStream(resp, (seg, first) => {
						signal?.throwIfAborted();
						if (first) {
							player.play(key, [seg]);
							player.beginStream(key);
							onStart?.();
						} else {
							player.push(key, [seg]);
						}
					});
					if (error) throw new Error(error);
					if (count === 0) throw new Error("no audio");
				} finally {
					player.endStream(key);
				}
				return;
			}
			const data = await resp.json().catch(() => ({}));
			signal?.throwIfAborted();
			if (data.streamUrl) {
				// 流式 WAV：<audio> 边下边播，首音≈引擎首块
				player.play(key, [{ url: data.streamUrl, duration: 0, live: true }]);
				onStart?.();
				return;
			}
			let segments = data.segments;
			if ((!segments || segments.length === 0) && data.audioUrl) {
				segments = [{ url: data.audioUrl, duration: data.audioLen || 0 }];
			}
			if (!segments || segments.length === 0) throw new Error(data.error || "no audio");
			player.play(key, segments);
			onStart?.();
			if (data.error) throw new Error(data.error);
		}

		// 选中文字朗读：同样走流式 /speak（body.text），首音快
		async function startSelectionRead(text) {
			if (microphoneActive()) return;
			const startedAt = performance.now();
			if (activeSpeak) {
				activeSpeak.abort();
				activeSpeak = null;
			}
			const ac = new AbortController();
			activeSpeak = ac;
			const key = "selection:" + Date.now();
			showPanel({ text });
			try {
				const resp = await pluginFetch("api/dsh-gsv-tts/speak", {
					method: "POST",
					headers: { "Content-Type": "application/json", "Accept": acceptSpeech() },
					body: JSON.stringify({ text }),
					signal: ac.signal
				});
				await playSpeakResponse(resp, key, ac.signal, undefined, startedAt);
			} catch (e) {
				if (!(e && e.name === "AbortError")) {
					try { console.warn("[dsh-gsv-tts] 朗读选中失败:", e); } catch { /* 忽略 */ }
				}
			} finally {
				if (activeSpeak === ac) activeSpeak = null;
			}
		}

		// ─── 选中文字 → 浮出「朗读选中」 ───
		let gsvChip = null;
		let gsvChipText = "";
		function hideChip() { if (gsvChip) gsvChip.style.display = "none"; }
		function ensureChip() {
			if (gsvChip || typeof document === "undefined" || !document.body) return gsvChip;
			const b = document.createElement("button");
			b.type = "button";
			b.style.cssText = "position:fixed;z-index:2147483001;display:none;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-elevated,#1f1f23);color:var(--dsw-alias-label-primary,#eee);border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.18));box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit";
			b.addEventListener("mousedown", (e) => e.preventDefault());
			b.addEventListener("click", async () => {
				const text = gsvChipText;
				hideChip();
				if (!text) return;
				await startSelectionRead(text);
			});
			document.body.appendChild(b);
			gsvChip = b;
			return b;
		}
		function selectionInfo() {
			const sel = window.getSelection && window.getSelection();
			if (!sel || sel.isCollapsed) return null;
			const text = String(sel.toString() || "").trim();
			if (text.length < 2 || text.length > 6000) return null;
			const node = sel.anchorNode;
			const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
			if (!el) return null;
			if (el.closest("textarea, input, [contenteditable='true'], [contenteditable='']")) return null;
			const inChat = el.closest("[data-conversation-scroll]") || el.closest("[data-turn-tail]");
			if (!inChat && document.querySelector("[data-conversation-scroll]")) return null;
			let rect = null;
			try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { /* 忽略 */ }
			return { text, rect };
		}
		function showChipAt(x, y, text) {
			const b = ensureChip();
			if (!b) return;
			gsvChipText = text;
			b.textContent = "🔊 朗读选中（" + text.length + " 字）";
			b.style.display = "block";
			const w = 190, h = 34;
			b.style.left = Math.max(4, Math.min(x, (window.innerWidth || 800) - w)) + "px";
			b.style.top = Math.max(4, Math.min(y, (window.innerHeight || 600) - h)) + "px";
		}
		function installSelectionMenu() {
			if (typeof document === "undefined" || typeof window === "undefined") return () => {};
			const capture = { capture: true };
			let timer;
			const onUp = (e) => {
				if (gsvChip && e.target === gsvChip) return;
				clearTimeout(timer);
				timer = setTimeout(() => {
					const info = selectionInfo();
					if (!info) { hideChip(); return; }
					const r = info.rect;
					if (r) showChipAt(r.right + 12, r.bottom + 8, info.text);
					else showChipAt(80, 120, info.text);
				}, 0);
			};
			const onDown = (e) => { if (gsvChip && e.target === gsvChip) return; hideChip(); };
			const onKey = (e) => { if (e.key === "Escape") hideChip(); };
			document.addEventListener("mouseup", onUp, capture);
			document.addEventListener("mousedown", onDown, capture);
			document.addEventListener("keydown", onKey, capture);
			window.addEventListener("scroll", hideChip, capture);
			return () => {
				document.removeEventListener("mouseup", onUp, capture);
				document.removeEventListener("mousedown", onDown, capture);
				document.removeEventListener("keydown", onKey, capture);
				window.removeEventListener("scroll", hideChip, capture);
				clearTimeout(timer);
				hideChip();
				gsvChip?.remove();
				gsvChip = null;
			};
		}

		// ─── 朗读按钮（conversation.chat.assistant-actions 插槽） ───
		function ReadAloudButton({ messageId, sessionId, t }) {
			const [busy, setBusy] = react.useState(false);
			const [failure, setFailure] = react.useState(null);
			const rootRef = react.useRef(null);
			const key = (sessionId || "s") + ":" + (messageId || "m");
			react.useSyncExternalStore(player.subscribe, player.getSnapshot);
			const active = player.isActive(key);
			const paused = active && player.state === "paused";
			const progress = active ? player.progress() : null;
			const onRead = react.useCallback(async () => {
				if (microphoneActive()) return;
				const startedAt = performance.now();
				setBusy(true);
				setFailure(null);
				if (activeSpeak) {
					activeSpeak.abort();
					activeSpeak = null;
				}
				const ac = new AbortController();
				activeSpeak = ac;
				showPanel({ sessionId, messageId });
				try {
					const resp = await pluginFetch("api/dsh-gsv-tts/speak", {
						method: "POST",
						headers: { "Content-Type": "application/json", "Accept": acceptSpeech() },
						body: JSON.stringify({ sessionId, messageId }),
						signal: ac.signal
					});
					await playSpeakResponse(resp, key, ac.signal, undefined, startedAt);
				} catch (e) {
					if (!(e && e.name === "AbortError")) setFailure(String((e && e.message) || e));
				} finally {
					if (activeSpeak === ac) activeSpeak = null;
					setBusy(false);
				}
			}, [key, sessionId, messageId]);
			// 高亮正在朗读的那条消息（插槽 DOM 位于带 data-turn-tail 的消息根节点内）
			react.useEffect(() => {
				if (!active) return;
				const el = rootRef.current;
				const turn = el && el.closest("[data-turn-tail]");
				if (!turn) return;
				turn.classList.add("_gsv_turn_active");
				return () => turn.classList.remove("_gsv_turn_active");
			}, [active]);
			const progressText = progress
				? (progress.total > 0
					? formatTime(progress.elapsed) + " / " + formatTime(progress.total) + (progress.count > 1 ? " · " + (progress.index + 1) + "/" + progress.count : "")
					: formatTime(progress.elapsed) + (progress.live ? " · 生成中…" : ""))
				: null;
			return jsx.jsxs("div", { ref: rootRef, style: { display: "inline-flex", alignItems: "center", gap: 2 }, children: [
				active ? jsx.jsxs(react.Fragment, { children: [
					jsx.jsx(primitives.Tooltip, {
						label: paused ? t("resume") : t("pause"),
						side: "bottom",
						children: jsx.jsx("button", {
							type: "button",
							className: "_gsv_action _gsv_action_active" + (paused ? " _gsv_paused" : ""),
							"aria-label": paused ? t("resume") : t("pause"),
							onClick: paused ? () => player.resume() : () => player.pause(),
							children: paused ? "▶" : "⏸"
						})
					}),
					jsx.jsx(primitives.Tooltip, {
						label: t("stop"),
						side: "bottom",
						children: jsx.jsx("button", {
							type: "button",
							className: "_gsv_action",
							"aria-label": t("stop"),
							onClick: () => stopPlayback(),
							children: "⏹"
						})
					}),
					progressText !== null && jsx.jsx("span", { className: "_gsv_progress", children: progressText })
				] }) : jsx.jsx(primitives.Tooltip, {
					label: busy ? t("reading") : t("read"),
					side: "bottom",
					children: jsx.jsx("button", {
						type: "button",
						className: "_gsv_action",
						"aria-label": t("read"),
						disabled: busy,
						onClick: onRead,
						children: busy ? "…" : "🔊"
					})
				}),
				failure !== null && jsx.jsx("span", { className: "_gsv_failure", role: "status", title: failure, children: failure })
			] });
		}

		// ─── 设置 section 错误边界：任何渲染错误都显示为红字，而不是被宿主静默吞成空白 ───
		class GsvErrorBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(e) {
				return { error: String((e && e.message) || e) };
			}
			componentDidCatch(e, info) {
				try { console.error("[dsh-gsv-tts] settings render error:", e, info); } catch { /* 忽略 */ }
			}
			render() {
				if (this.state.error !== null) {
					return react.createElement("div", {
						style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12, marginTop: 6, whiteSpace: "pre-wrap" },
						children: "设置渲染错误: " + this.state.error
					});
				}
				return this.props.children;
			}
		}

		// ─── 设置卡片（settings.plugin.item 插槽） ───
		function TtsSettingsCard({ scope, t }) {
			const lifetime = lifecycle?.signal;
			const settingsFetch = (url, options) => pluginFetch(url, options, lifetime);
			// 防御：settings 作用域异常（如服务端命名空间未注册）时显示错误而非整段空白
			const [snapshot, setSnapshot] = react.useState(() => {
				try {
					return scope.getSnapshot();
				} catch (e) {
					return { error: String((e && e.message) || e) };
				}
			});
			react.useEffect(() => {
				try {
					return onDeactivate(scope.subscribe(() => setSnapshot(scope.getSnapshot())), lifetime);
				} catch {
					return () => {};
				}
			}, [scope]);
			// 订阅播放器状态：试听按钮/批量进度随播放变化刷新
			react.useSyncExternalStore(player.subscribe, player.getSnapshot);
			const value = (snapshot && snapshot.value) || {};
			const writable = !!(snapshot && snapshot.writable);
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [changingVoice, setChangingVoice] = react.useState(false);
			const voiceWrite = react.useRef(false);
			const [error, setError] = react.useState(null);
			const [speechMetrics, setSpeechMetrics] = react.useState(null);
			const [modelIntegrity, setModelIntegrity] = react.useState(null);
			const [previewBusy, setPreviewBusy] = react.useState(null); // 单条:索引 | 批量:"all" | null
			const [previewError, setPreviewError] = react.useState(null);
			// ─── 音色市场状态：必须在下方提前 return 之前声明（hook 数量跨渲染一致，否则 React #310） ───
			const [market, setMarket] = react.useState(null); // { source, trusted, version, voices }
			const [marketLoading, setMarketLoading] = react.useState(false);
			const [marketBusy, setMarketBusy] = react.useState(null); // 'install:<id>' | 'remove:<id>' | null
			const [marketError, setMarketError] = react.useState(null);
			const [confirmInstall, setConfirmInstall] = react.useState(null); // { pkg }
			const [confirmRemove, setConfirmRemove] = react.useState(null); // { id, name }
			// ─── 4.0.0 简单模式状态（同样必须在提前 return 之前声明） ───
			const [edgeVoices, setEdgeVoices] = react.useState([]);
			const [providerHealth, setProviderHealth] = react.useState(null); // { available, rateLimited?, message? } | null
			const [cloudBusy, setCloudBusy] = react.useState(null); // 'one' | 'all' | null
			// 提供方目录：模式 Tab / 字段 / 能力由服务端 /provider/catalog 决定，客户端不再硬编码分支
			const [providerCatalog, setProviderCatalog] = react.useState(DEFAULT_PROVIDER_CATALOG);
			react.useEffect(() => {
				let alive = true;
				settingsFetch("api/dsh-gsv-tts/provider/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
					.then((r) => r.json())
					.then((d) => { if (alive && Array.isArray(d.providers) && d.providers.length) setProviderCatalog(d.providers); })
					.catch(() => {});
				return onDeactivate(() => { alive = false; }, lifetime);
			}, []);
			const valueJson = JSON.stringify(value);
			const previousValue = react.useRef(value);
			react.useEffect(() => {
				const previous = previousValue.current;
				previousValue.current = value;
				setDraft(current => {
					const next = structuredClone(value);
					for (const field of Object.keys(current || {})) {
						if (JSON.stringify(current[field]) !== JSON.stringify(previous[field])
							&& JSON.stringify(previous[field]) === JSON.stringify(value[field])) {
							next[field] = current[field];
						}
					}
					return next;
				});
			}, [valueJson]);
			// provider 判定：迁移写回完成前默认按 gsv 展示（服务端已写回后快照即含 provider）
			const provider = draft && providerCatalog.some((p) => p.id === draft.provider)
				? draft.provider
				: (providerCatalog.some((p) => p.id === 'gsv') ? 'gsv' : (providerCatalog[0] ? providerCatalog[0].id : 'gsv'));
			// 目录驱动：能力决定显示哪些字段，而不是枚举 provider 名
			const descriptor = providerCatalog.find((p) => p.id === provider) || DEFAULT_PROVIDER_CATALOG.find((p) => p.id === 'gsv') || DEFAULT_PROVIDER_CATALOG[0];
			const caps = descriptor.capabilities;
			const cloudVoices = provider === "deepseek" ? DEEPSEEK_VOICE_OPTIONS : provider === "edge" ? edgeVoices : [];
			// Edge 音色按需加载。DeepSeek 使用固定的内置列表。
			react.useEffect(() => {
				if (draft === null || !caps.network) return;
				let alive = true;
				setProviderHealth(null);
				let loadedVoices = edgeVoices.length > 0;
				const load = async () => {
					if (provider === 'edge' && !loadedVoices) {
						try {
							const vr = await settingsFetch("api/dsh-gsv-tts/provider/voices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
							const vd = await vr.json().catch(() => ({}));
							if (alive && vd.voices && vd.voices.length) {
								loadedVoices = true;
								setEdgeVoices(vd.voices);
							}
						} catch { /* 忽略 */ }
					}
					try {
						const hr = await settingsFetch("api/dsh-gsv-tts/provider/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
						const hd = await hr.json().catch(() => ({}));
						if (alive) setProviderHealth({ available: !!hd.available, rateLimited: !!hd.rateLimited, message: hd.message || null });
					} catch (e) {
						if (alive) setProviderHealth({ available: false, rateLimited: false, message: String((e && e.message) || e) });
					}
				};
				load();
				const timer = setInterval(load, 60000); // 每分钟轻量刷新一次（服务端退避缓存）
				return onDeactivate(() => { alive = false; clearInterval(timer); }, lifetime);
			}, [provider, draft === null ? 0 : 1, provider === 'deepseek' ? String((draft && draft.deepseekApiKey) || '') : '']);
			const persistVoice = async (kind, voice) => {
				const resp = await settingsFetch("api/dsh-gsv-tts/settings/voice", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ provider: kind, voice }),
				});
				const selection = await resp.json();
				lifetime?.throwIfAborted();
				if (!resp.ok) throw new Error(selection.message || t("saveRejected"));
				setDraft(current => ({ ...current, ...selection }));
			};
			const changeVoice = async (kind, voice) => {
				if (voiceWrite.current) return;
				voiceWrite.current = true;
				setChangingVoice(true);
				setError(null);
				try {
					await persistVoice(kind, voice);
					if (kind !== provider && kind === "gsv" && draft.engineMode === "always") {
						void settingsFetch("api/dsh-gsv-tts/engine/start", { method: "POST" }).catch(() => {});
					}
				} catch (error) {
					setError(String(error?.message || error));
				} finally {
					voiceWrite.current = false;
					setChangingVoice(false);
				}
			};
			const switchProvider = kind => {
				if (kind !== provider) void changeVoice(kind);
			};
			// ─── 云端音色试听：单条（当前选中）+ 全部（串行合成→排队播放，防限流） ───
			const cloudPreview = async (voiceId) => {
				if (!voiceId) return;
				const key = "cloud:" + voiceId;
				if (player.isActive(key)) { player.stop(); return; }
				setCloudBusy("one");
				setPreviewError(null);
				try {
					const resp = await settingsFetch("api/dsh-gsv-tts/provider/preview", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ voice: voiceId, provider })
					});
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok || !data.audioUrl) throw new Error(data.message || "no audio");
					if (!lifetime?.aborted) player.play(key, [{ url: data.audioUrl, duration: data.audioLen || 0 }]);
				} catch (e) {
					setPreviewError(String((e && e.message) || e));
				} finally {
					setCloudBusy(null);
				}
			};
			const cloudPreviewAll = async () => {
				if (player.isActive("cloud:all")) { player.stop(); return; }
				const voices = cloudVoices || [];
				if (voices.length === 0) return;
				setCloudBusy("all");
				setPreviewError(null);
				try {
					let first = true;
					const errs = [];
					for (const v of voices) {
						if (lifetime?.aborted) return;
						try {
							const resp = await settingsFetch("api/dsh-gsv-tts/provider/preview", {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ voice: v.id, provider })
							});
							const data = await resp.json().catch(() => ({}));
							if (!resp.ok || !data.audioUrl) { errs.push(data.message || ("HTTP " + resp.status)); continue; }
							if (lifetime?.aborted) return;
							const seg = [{ url: data.audioUrl, duration: data.audioLen || 0 }];
							if (first) { player.play("cloud:all", seg); first = false; }
							else { player.enqueue("cloud:all", seg); }
						} catch (e) {
							errs.push(String((e && e.message) || e));
						}
					}
					if (errs.length) setPreviewError(errs.join("；"));
				} finally {
					setCloudBusy(null);
				}
			};
			const dirty = draft !== null && JSON.stringify(draft) !== valueJson;
			if (draft === null) return null;
			if (snapshot && snapshot.error) {
				return jsx.jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12, marginTop: 6 }, children: t("cardLoadFailed") + "：" + snapshot.error });
			}
			if (snapshot && snapshot.status === "unavailable") {
				return jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 6 }, children: t("cardUnavailable") });
			}
			if (snapshot && snapshot.status === "loading") {
				return jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 6 }, children: t("cardLoading") });
			}
			const voiceOptions = provider === "custom" ? [] : caps.voiceSource !== "presets"
				? cloudVoices.map((v) => ({ id: v.id, label: provider === "edge" ? v.name + " (" + v.id + ")" : v.name }))
				: (draft.voices || []).map((v) => ({ id: v.name, label: v.name }));
			if (provider === "edge" && voiceOptions.length && draft.defaultVoice && !voiceOptions.some(o => o.id === draft.defaultVoice)) {
				voiceOptions.unshift({ id: draft.defaultVoice, label: draft.defaultVoice });
			}
			// 当前生效音色：显式选择优先，空则取第一个（与朗读实际行为一致）
			const effectiveVoice = draft.defaultVoice || (voiceOptions.length ? voiceOptions[0].id : "");
			const currentLabel = voiceOptions.find((o) => o.id === effectiveVoice)?.label || "";
			const patchField = (field, next) => setDraft({ ...draft, [field]: next });
			const patchVoice = (index, field, next) => {
				const voices = (draft.voices || []).map((v, i) => i === index ? { ...v, [field]: next } : v);
				patchField("voices", voices);
			};
			const addVoice = () => patchField("voices", [...(draft.voices || []), { name: "", speakerAudioPath: "", promptAudioPath: "", promptText: "" }]);
			const removeVoice = (index) => patchField("voices", (draft.voices || []).filter((_, i) => i !== index));
			// ─── 音色试听（未保存的草稿音色也可直接试听） ───
			const previewKey = (i, name) => "preview:" + i + ":" + (name || "");
			const previewOne = async (i) => {
				const v = (draft.voices || [])[i];
				if (!v) return;
				const key = previewKey(i, v.name);
				if (player.isActive(key)) { player.stop(); return; }
				setPreviewBusy(i);
				setPreviewError(null);
				try {
					const resp = await settingsFetch("api/dsh-gsv-tts/preview", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ voice: { name: v.name ?? "", speakerAudioPath: v.speakerAudioPath ?? "", promptAudioPath: v.promptAudioPath ?? "", promptText: v.promptText ?? "" } })
					});
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok) throw new Error(data.message || ("HTTP " + resp.status));
					if (!data.audioUrl) throw new Error("no audio");
					if (!lifetime?.aborted) player.play(key, [{ url: data.audioUrl, duration: data.audioLen || 0 }]);
				} catch (e) {
					setPreviewError(String((e && e.message) || e));
				} finally {
					setPreviewBusy(null);
				}
			};
			const previewAll = async () => {
				if (player.isActive("preview:all")) { player.stop(); return; }
				const voices = draft.voices || [];
				if (voices.length === 0) return;
				setPreviewBusy("all");
				setPreviewError(null);
				try {
					const results = await Promise.all(voices.map(async (v) => {
						try {
							const resp = await settingsFetch("api/dsh-gsv-tts/preview", {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ voice: { name: v.name ?? "", speakerAudioPath: v.speakerAudioPath ?? "", promptAudioPath: v.promptAudioPath ?? "", promptText: v.promptText ?? "" } })
							});
							const data = await resp.json().catch(() => ({}));
							if (!resp.ok || !data.audioUrl) return { error: data.message || ("HTTP " + resp.status) };
							return { url: data.audioUrl, duration: data.audioLen || 0 };
						} catch (e) {
							return { error: String((e && e.message) || e) };
						}
					}));
					const ok = results.filter((r) => r.url);
					const errs = results.filter((r) => r.error);
					if (!lifetime?.aborted && ok.length > 0) player.play("preview:all", ok, { loop: true });
					if (errs.length > 0) setPreviewError(errs.map((r) => r.error).join("；"));
				} finally {
					setPreviewBusy(null);
				}
			};
			const batchActive = player.isActive("preview:all");
			const batchProgress = batchActive ? player.progress() : null;
			const batchProgressText = batchProgress
				? formatTime(batchProgress.elapsed) + " / " + formatTime(batchProgress.total) + " · " + (batchProgress.index + 1) + "/" + batchProgress.count + " 🔁"
				: null;
			// ─── 音色市场（注册表：拉取 / 两阶段安装 / 卸载确认） ───
			const marketLoad = async () => {
				setMarketLoading(true);
				setMarketError(null);
				try {
					const resp = await settingsFetch("api/dsh-gsv-tts/registry/list", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({})
					});
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok || data.ok === false) throw new Error(data.message || ("HTTP " + resp.status));
					setMarket(data);
				} catch (e) {
					setMarketError(String((e && e.message) || e));
				} finally {
					setMarketLoading(false);
				}
			};
			const marketPreview = async (pkg) => {
				setMarketError(null);
				try {
					const resp = await settingsFetch("api/dsh-gsv-tts/preview", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ voice: { name: pkg.name, speakerAudioPath: pkg.speaker, promptAudioPath: pkg.prompt, promptText: pkg.promptText } })
					});
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok || !data.audioUrl) throw new Error(data.message || "no audio");
					if (!lifetime?.aborted) player.play("market:" + pkg.id, [{ url: data.audioUrl, duration: data.audioLen || 0 }]);
				} catch (e) {
					setMarketError(String((e && e.message) || e));
				}
			};
			const marketInstall = async (pkg, confirm) => {
				setMarketBusy("install:" + pkg.id);
				setMarketError(null);
				try {
					const resp = await settingsFetch("api/dsh-gsv-tts/registry/install", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: pkg.id, confirm: confirm === true })
					});
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok) throw new Error(data.message || ("HTTP " + resp.status));
					if (data.ok) {
						setConfirmInstall(null);
						await marketLoad();
					} else if (data.needsConfirm) {
						setConfirmInstall(pkg);
					} else {
						throw new Error(data.message || "安装失败");
					}
				} catch (e) {
					setMarketError(String((e && e.message) || e));
				} finally {
					setMarketBusy(null);
				}
			};
			const marketRemoveById = async (id, deleteFiles) => {
				setMarketBusy("remove:" + id);
				setMarketError(null);
				try {
					const resp = await settingsFetch("api/dsh-gsv-tts/registry/remove", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id, deleteFiles })
					});
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok || !data.ok) throw new Error(data.message || ("HTTP " + resp.status));
					setConfirmRemove(null);
					await marketLoad();
				} catch (e) {
					setMarketError(String((e && e.message) || e));
				} finally {
					setMarketBusy(null);
				}
			};
			const save = async () => {
				setSaving(true);
				setError(null);
				try {
					const base = (snapshot && snapshot.base) || {};
					let rejected = 0;
					for (const field of ["apiUrl", "autoPlay", "liveReply", "interruptOnNew",
						"deepseekApiKey", "deepseekApiKeyEnv", "deepseekAutoCharsPerDay",
						"customBaseUrl", "customModel", "customKeyRef", "customInstructions", "customFormat",
						"gsvSpeed", "gsvModelManifest", "lexicon", "timeout", "installDir", "voices"]) {
						const next = field === "deepseekApiKey" ? (draft.deepseekApiKey ?? "") : field === "deepseekApiKeyEnv" ? (draft.deepseekApiKeyEnv ?? "") : field === "lexicon" ? (draft.lexicon ?? "") : draft[field];
						if (next === undefined) continue;
						const baseVal = base[field];
						// DSH 0.2：set/unset 返回宿主是否接受写入（false = 被拒绝），需要显式提示
						const accepted = baseVal !== void 0 && JSON.stringify(next) === JSON.stringify(baseVal)
							? await scope.unset(field)
							: await scope.set(field, next);
						if (accepted === false) rejected += 1;
					}
					if (rejected > 0) setError(t("saveRejected"));
					else if ((draft.defaultVoice ?? "") !== (value.defaultVoice ?? "")) {
						await persistVoice(provider, draft.defaultVoice ?? "");
					}
				} catch (e) {
					setError(String((e && e.message) || e));
				} finally {
					setSaving(false);
				}
			};
			const inputStyle = { boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", width: "100%", color: "var(--dsw-alias-label-primary)", font: "inherit", borderRadius: 8, padding: "6px 8px", fontSize: 13 };
			const labelStyle = { display: "block", color: "var(--dsw-alias-label-secondary)", fontSize: 12, margin: "10px 0 4px" };
			const rowStyle = { display: "flex", gap: 8, alignItems: "center", marginBottom: 6 };
			const linkBtn = { cursor: "pointer", border: "none", background: "0 0", color: "var(--dsw-alias-brand,#6e56cf)", fontSize: 12, padding: 0 };
			const dangerBtn = { cursor: "pointer", border: "none", background: "0 0", color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12, padding: 0 };
			const primaryBtn = { cursor: "pointer", border: "none", borderRadius: 14, height: 26, padding: "0 12px", fontSize: 12, background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)" };
			return jsx.jsxs("div", { children: [
				jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 2 }, children: t("cardDesc") }),
				!writable && jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 6 }, children: t("readOnly") }),
				// ─── 4.0.0 模式切换 Tab + 品质角标 ───
				jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }, children: [
					jsx.jsx("span", { style: { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary)" }, children: t("mode.title") + "：" }),
					...providerCatalog.map((p) => jsx.jsx("button", {
						type: "button",
						disabled: !writable || saving || changingVoice,
						onClick: () => switchProvider(p.id),
						style: { cursor: "pointer", border: "1px solid " + (provider === p.id ? "var(--dsw-alias-brand,#6e56cf)" : "var(--dsw-alias-border-l2)"), background: provider === p.id ? "var(--dsw-alias-interactive-bg-hover)" : "0 0", color: "var(--dsw-alias-label-secondary)", borderRadius: 14, padding: "4px 12px", fontSize: 12 },
						children: p.i18nKey ? t(p.i18nKey) : p.label
					}, p.id)),
					jsx.jsx("span", { style: { fontSize: 12, fontWeight: 600, color: descriptor.badge === "local" ? "var(--dsw-alias-success, #30a46c)" : "var(--dsw-alias-label-tertiary)" }, children: descriptor.badge === "local" ? t("mode.badgeLocal") : descriptor.badge === "official" ? t("mode.badgeOfficial") : t("mode.badgeCloud") })
				] }),
				jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginTop: 4 }, children: provider === "deepseek" ? t("mode.officialDesc") : provider === "edge" ? t("mode.quickDesc") : provider === "custom" ? descriptor.description : t("mode.proDesc") }),
				caps.network && providerHealth !== null && jsx.jsx("div", { style: { fontSize: 12, marginTop: 4, color: providerHealth.available ? "var(--dsw-alias-success, #30a46c)" : "var(--dsw-alias-danger, #e5484d)" }, children: providerHealth.available ? t("mode.healthOk") : (providerHealth.rateLimited ? t("mode.healthBusy") : (providerHealth.message || t("mode.healthDown"))) }),
				caps.network && providerHealth !== null && !providerHealth.available && jsx.jsx("button", { type: "button", disabled: !writable || saving || changingVoice, onClick: () => switchProvider("gsv"), style: linkBtn, children: t("mode.switchPro") }),
				caps.needsKey && jsx.jsx(react.Fragment, { children: [
					jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginTop: 6 }, children: t("field.apiKeyReuse") }),
					jsx.jsx("label", { style: labelStyle, children: t("field.apiKey") }),
					jsx.jsx("input", { style: inputStyle, disabled: !writable, type: "password", value: draft.deepseekApiKey ?? "", placeholder: t("field.apiKeyHint"), onChange: (e) => patchField("deepseekApiKey", e.target.value) }),
					jsx.jsx("label", { style: labelStyle, children: t("field.apiKeyRef") }),
					jsx.jsx("input", { style: inputStyle, disabled: !writable, value: draft.deepseekApiKeyEnv ?? "", placeholder: "DEEPSEEK_API_KEY", onChange: (e) => patchField("deepseekApiKeyEnv", e.target.value) }),
					jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginTop: 4 }, children: t("field.apiKeyRefHint") })
				] }),
				provider === "custom" && jsx.jsxs(react.Fragment, { children: [
					...[
						["customBaseUrl", "Base URL", "http://127.0.0.1:8880/v1"],
						["customModel", "TTS model", "kokoro"],
						["customKeyRef", "Credential reference", "CUSTOM_TTS_API_KEY"],
						["customInstructions", "Voice instructions", ""],
					].map(([field, label, placeholder]) => jsx.jsxs("label", { style: labelStyle, children: [
						label, jsx.jsx("input", { style: inputStyle, disabled: !writable, value: draft[field] ?? "",
							placeholder, onChange: e => patchField(field, e.target.value) })
					] }, field)),
					jsx.jsxs("label", { style: labelStyle, children: ["Response format",
						jsx.jsxs("select", { style: inputStyle, disabled: !writable, value: draft.customFormat ?? "pcm",
							onChange: e => patchField("customFormat", e.target.value), children: [
								jsx.jsx("option", { value: "pcm", children: "PCM (24 kHz)" }),
								jsx.jsx("option", { value: "wav", children: "WAV" })
							] })
					] })
				] }),
				jsx.jsx("label", { style: labelStyle, children: caps.voiceSource !== "presets" ? t("field.cloudVoice") : t("field.defaultVoice") }),
				voiceOptions.length > 0
					? jsx.jsx("select", { style: inputStyle, disabled: !writable || changingVoice || saving, value: effectiveVoice, onChange: (e) => {
						const voice = e.target.value;
						if (provider === "gsv" && !(value.voices || []).some(preset => preset.name === voice)) patchField("defaultVoice", voice);
						else void changeVoice(provider, voice);
					}, children: [
						...voiceOptions.map((o) => jsx.jsx("option", { key: o.id, value: o.id, children: o.label }))
					] })
					: jsx.jsx("input", { style: inputStyle, disabled: !writable, value: draft.defaultVoice ?? "", placeholder: t("field.defaultVoiceHint"), onChange: (e) => patchField("defaultVoice", e.target.value) }),
				jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginTop: 4 }, children: t("currentVoice") + "：" + (currentLabel || t("voice.default")) }),
				caps.voiceSource !== "presets" && jsx.jsx("div", { style: { display: "flex", gap: 12, alignItems: "center", marginTop: 4, flexWrap: "wrap" }, children: [
					jsx.jsx("button", { type: "button", disabled: !effectiveVoice || cloudBusy === "one", onClick: () => cloudPreview(effectiveVoice), style: linkBtn, children: player.isActive("cloud:" + effectiveVoice) ? t("stop") : t("voice.preview") }),
					cloudVoices.length > 1 && jsx.jsx("button", { type: "button", disabled: cloudBusy === "all", onClick: cloudPreviewAll, style: linkBtn, children: player.isActive("cloud:all") ? t("stop") : t("voice.previewAllSeq") })
				] }),
				caps.voiceSource !== "presets" && previewError !== null && jsx.jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12, marginTop: 6 }, children: previewError }),
				// ─── 仅本地专业（GSV）模式的字段 ───
				caps.voiceSource === "presets" && jsx.jsx(react.Fragment, { children: [
					jsx.jsx("label", { style: labelStyle, children: t("field.apiUrl") }),
					jsx.jsx("input", { style: inputStyle, disabled: !writable, value: draft.apiUrl ?? "", placeholder: t("field.apiUrlHint"), onChange: (e) => patchField("apiUrl", e.target.value) }),
					jsx.jsx("label", { style: labelStyle, children: t("field.timeout") }),
					jsx.jsx("input", { style: inputStyle, disabled: !writable, type: "number", value: draft.timeout ?? 30000, onChange: (e) => patchField("timeout", Number(e.target.value)) }),
					jsx.jsx("label", { style: labelStyle, children: t("field.installDir") }),
					jsx.jsx("input", { style: inputStyle, disabled: !writable, value: draft.installDir ?? "", onChange: (e) => patchField("installDir", e.target.value) }),
					jsx.jsx("label", { style: labelStyle, children: t("field.synthesisSpeed") }),
					jsx.jsx("input", { style: inputStyle, disabled: !writable, type: "number", min: .5, max: 2, step: .1,
						value: draft.gsvSpeed ?? 1, onChange: e => patchField("gsvSpeed", Number(e.target.value)) }),
					jsx.jsx("label", { style: labelStyle, children: t("field.modelManifest") }),
					jsx.jsx("input", { style: inputStyle, disabled: !writable, value: draft.gsvModelManifest ?? "",
						onChange: e => patchField("gsvModelManifest", e.target.value) }),
					jsx.jsx("button", { type: "button", style: linkBtn, onClick: async () => {
						try {
							const response = await settingsFetch("api/dsh-gsv-tts/engine/model-integrity");
							const result = await response.json();
							setModelIntegrity(result.verified ? result.version + " · SHA-256 ✓ × " + result.checked
								: result.message || "No manifest configured");
						} catch (error) { setModelIntegrity(String(error)); }
					}, children: t("field.modelIntegrity") }),
					modelIntegrity && jsx.jsx("div", { role: "status", children: modelIntegrity })
				] }),
				jsx.jsx("label", { style: { ...labelStyle, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }, children: jsx.jsxs(react.Fragment, { children: [
					jsx.jsx("input", { type: "checkbox", disabled: !writable, checked: !!draft.autoPlay, onChange: (e) => patchField("autoPlay", e.target.checked) }),
					t("field.autoPlay")
				] }) }),
				jsx.jsxs("label", { style: labelStyle, children: [
					jsx.jsx("input", { type: "checkbox", disabled: !writable || !draft.autoPlay, checked: !!draft.liveReply,
						onChange: e => patchField("liveReply", e.target.checked) }), t("field.liveReply")
				] }),
				provider === "deepseek" && jsx.jsxs("label", { style: labelStyle, children: [
					t("field.deepseekBudget"), jsx.jsx("input", { type: "number", min: 0, step: 1, style: inputStyle,
						disabled: !writable, value: draft.deepseekAutoCharsPerDay ?? "",
						onChange: e => patchField("deepseekAutoCharsPerDay", e.target.value === "" ? null : Number(e.target.value)) })
				] }),
				jsx.jsx("button", { type: "button", style: linkBtn, onClick: async () => {
					try { setSpeechMetrics(await (await settingsFetch("api/dsh-gsv-tts/metrics")).json()); }
					catch (error) { setSpeechMetrics({ message: String(error) }); }
				}, children: t("field.usage") }),
				speechMetrics && jsx.jsx("pre", { style: { whiteSpace: "pre-wrap", fontSize: 11 }, children:
					speechMetrics.message || [
						speechMetrics.day + " · DeepSeek: " + speechMetrics.deepseekCharacters + " (" +
							speechMetrics.deepseekAutomaticCharacters + " auto)",
						...(speechMetrics.providers || []).map(metric => metric.provider +
							" · first P50/P95: " + (metric.firstAudioP50 ?? "—") + "/" + (metric.firstAudioP95 ?? "—") +
							" ms · cancel P95: " + (metric.cancelP95 ?? "—") + " ms · cache: " + metric.cacheHits +
							" · cancelled: " + (metric.cancellationRate == null ? "—" : Math.round(metric.cancellationRate * 100) + "%") +
							" · errors: " + metric.failed)
					].join("\n")
				}),
				jsx.jsx("label", { style: { ...labelStyle, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }, children: jsx.jsxs(react.Fragment, { children: [
					jsx.jsx("input", { type: "checkbox", disabled: !writable, checked: draft.interruptOnNew !== false, onChange: (e) => patchField("interruptOnNew", e.target.checked) }),
					t("field.interruptOnNew")
				] }) }),
				jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginTop: 2 }, children: t("field.interruptOnNewHint") }),
				jsx.jsx("label", { style: labelStyle, children: t("field.lexicon") }),
				jsx.jsx("textarea", { style: { ...inputStyle, minHeight: 64, fontFamily: "ui-monospace, Consolas, monospace", lineHeight: 1.5 }, disabled: !writable, value: draft.lexicon ?? "", placeholder: t("field.lexiconHint"), onChange: (e) => patchField("lexicon", e.target.value) }),
				jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginTop: 4 }, children: t("field.lexiconDesc") }),
				// ─── 仅本地专业（GSV）模式的音色预设 + 市场 ───
				caps.voiceSource === "presets" && jsx.jsx(react.Fragment, { children: [
					jsx.jsx("label", { style: labelStyle, children: t("field.voices") }),
					(draft.voices || []).map((v, i) => {
						const isReg = v.source === "registry"; // 注册表音色只读托管
						return jsx.jsxs("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: 8, marginBottom: 8 }, children: [
							jsx.jsx("input", { style: inputStyle, disabled: !writable || isReg, value: v.name ?? "", placeholder: t("voice.name"), onChange: (e) => patchVoice(i, "name", e.target.value) }),
							jsx.jsx("input", { style: { ...inputStyle, marginTop: 4 }, disabled: !writable || isReg, value: v.speakerAudioPath ?? "", placeholder: t("voice.speaker"), onChange: (e) => patchVoice(i, "speakerAudioPath", e.target.value) }),
							jsx.jsx("input", { style: { ...inputStyle, marginTop: 4 }, disabled: !writable || isReg, value: v.promptAudioPath ?? "", placeholder: t("voice.prompt"), onChange: (e) => patchVoice(i, "promptAudioPath", e.target.value) }),
							jsx.jsx("input", { style: { ...inputStyle, marginTop: 4 }, disabled: !writable || isReg, value: v.promptText ?? "", placeholder: t("voice.promptText"), onChange: (e) => patchVoice(i, "promptText", e.target.value) }),
							jsx.jsx("div", { style: { display: "flex", gap: 10, marginTop: 6, alignItems: "center" }, children: [
								jsx.jsx("button", { type: "button", disabled: previewBusy === i, onClick: () => previewOne(i), style: linkBtn, children: previewBusy === i ? t("voice.previewing") : (player.isActive(previewKey(i, v.name)) ? t("stop") : t("voice.preview")) }),
								isReg ? jsx.jsxs(react.Fragment, { children: [
									jsx.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11 }, children: t("market.registryTag") }),
									writable && jsx.jsx("button", { type: "button", disabled: marketBusy === "remove:" + v.id, onClick: () => setConfirmRemove({ id: v.id, name: v.name }), style: dangerBtn, children: marketBusy === "remove:" + v.id ? "…" : t("market.uninstall") })
								] }) : (writable && jsx.jsx("button", { type: "button", onClick: () => removeVoice(i), style: { cursor: "pointer", border: "none", background: "0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 12, padding: 0 }, children: t("voice.remove") }))
							] })
						] }, i);
					}),
					(draft.voices || []).length > 0 && jsx.jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 }, children: [
						jsx.jsx("button", { type: "button", disabled: previewBusy === "all", onClick: previewAll, style: { cursor: "pointer", border: "none", background: "0 0", color: "var(--dsw-alias-brand,#6e56cf)", fontSize: 13, padding: 0 }, children: previewBusy === "all" ? t("voice.previewing") : (batchActive ? t("stop") : t("voice.previewAll")) }),
						batchProgressText !== null && jsx.jsx("span", { className: "_gsv_progress", children: batchProgressText })
					] }),
					previewError !== null && jsx.jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12, marginTop: 6 }, children: previewError }),
					writable && jsx.jsx("button", { type: "button", onClick: addVoice, style: { cursor: "pointer", border: "1px dashed var(--dsw-alias-border-l2)", background: "0 0", color: "var(--dsw-alias-label-secondary)", borderRadius: 8, padding: "4px 10px", fontSize: 13 }, children: t("voice.add") }),
					jsx.jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: 14, paddingTop: 8 }, children: [
					jsx.jsx("div", { style: { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary)" }, children: t("market.title") }),
					jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 2 }, children: t("market.desc") }),
					jsx.jsx("a", { href: "https://taoruiliu19.github.io/gsv-market/", target: "_blank", rel: "noopener noreferrer", style: { display: "inline-block", marginTop: 4, fontSize: 12, color: "var(--dsw-alias-brand,#6e56cf)", textDecoration: "none" }, children: "🌐 " + t("market.website") }),
					market === null
						? jsx.jsx("button", { type: "button", disabled: marketLoading, onClick: marketLoad, style: { cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "0 0", color: "var(--dsw-alias-label-secondary)", borderRadius: 8, padding: "4px 10px", fontSize: 13, marginTop: 8 }, children: marketLoading ? t("market.loading") : t("market.load") })
						: jsx.jsxs(react.Fragment, { children: [
							jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12 }, children: [
								jsx.jsx("span", { style: { color: market.trusted ? "var(--dsw-alias-success, #30a46c)" : "var(--dsw-alias-danger, #e5484d)", fontWeight: 600 }, children: market.source === "bundled" ? t("market.sourceBundled") + " · " + t("market.trusted") : t("market.sourceRemote") + " · " + t("market.untrusted") }),
								jsx.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "v" + market.version }),
								jsx.jsx("button", { type: "button", onClick: marketLoad, style: linkBtn, children: t("market.refresh") })
							] }),
							(market.voices || []).map((pkg) => jsx.jsxs("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: 8, marginBottom: 8, marginTop: 8 }, children: [
								jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
									jsx.jsx("span", { style: { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary)" }, children: pkg.name }),
									pkg.trusted
										? jsx.jsx("span", { style: { color: "var(--dsw-alias-success, #30a46c)", fontSize: 11 }, children: t("market.trusted") })
										: jsx.jsx("span", { style: { color: "var(--dsw-alias-warning,#f5a524)", fontSize: 11 }, children: t("market.untrusted") }),
									pkg.installed && jsx.jsx("span", { style: { color: "var(--dsw-alias-success, #30a46c)", fontSize: 11 }, children: t("market.installed") })
								] }),
								jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginTop: 2 }, children: (pkg.author || "—") + " · " + pkg.license }),
								jsx.jsxs("div", { style: { display: "flex", gap: 10, marginTop: 6, alignItems: "center" }, children: [
									jsx.jsx("button", { type: "button", onClick: () => marketPreview(pkg), style: linkBtn, children: player.isActive("market:" + pkg.id) ? t("stop") : t("voice.preview") }),
									pkg.installed
										? jsx.jsx("button", { type: "button", disabled: !writable || marketBusy === "remove:" + pkg.id, onClick: () => setConfirmRemove({ id: pkg.id, name: pkg.name }), style: dangerBtn, children: marketBusy === "remove:" + pkg.id ? "…" : t("market.uninstall") })
										: jsx.jsx("button", { type: "button", disabled: !writable || marketBusy === "install:" + pkg.id, onClick: () => marketInstall(pkg, false), style: linkBtn, children: marketBusy === "install:" + pkg.id ? "…" : t("market.install") })
								] })
							] }, pkg.id))
						] }),
					confirmInstall !== null && jsx.jsx("div", { style: { border: "1px solid var(--dsw-alias-warning,#f5a524)", borderRadius: 8, padding: 8, marginTop: 8 }, children: [
						jsx.jsx("div", { style: { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary)" }, children: t("market.confirmInstallTitle") }),
						jsx.jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, marginTop: 4 }, children: t("market.confirmInstallBody") }),
						jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 2 }, children: (confirmInstall.author || "—") + " · " + confirmInstall.license }),
						jsx.jsxs("div", { style: { display: "flex", gap: 10, marginTop: 8 }, children: [
							jsx.jsx("button", { type: "button", onClick: () => marketInstall(confirmInstall, true), style: primaryBtn, children: t("market.confirm") }),
							jsx.jsx("button", { type: "button", onClick: () => setConfirmInstall(null), style: linkBtn, children: t("market.cancel") })
						] })
					] }),
					confirmRemove !== null && jsx.jsx("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: 8, marginTop: 8 }, children: [
						jsx.jsx("div", { style: { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary)" }, children: t("market.confirmRemoveTitle") + " " + confirmRemove.name }),
						jsx.jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, marginTop: 4 }, children: t("market.confirmRemoveBody") }),
						jsx.jsxs("div", { style: { display: "flex", gap: 10, marginTop: 8 }, children: [
							jsx.jsx("button", { type: "button", onClick: () => marketRemoveById(confirmRemove.id, true), style: primaryBtn, children: t("market.removeDelete") }),
							jsx.jsx("button", { type: "button", onClick: () => marketRemoveById(confirmRemove.id, false), style: linkBtn, children: t("market.removeKeep") }),
							jsx.jsx("button", { type: "button", onClick: () => setConfirmRemove(null), style: linkBtn, children: t("market.cancel") })
						] })
					] }),
					marketError !== null && jsx.jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12, marginTop: 6 }, children: marketError })
				] }),
				] }),
				jsx.jsx("div", { style: { display: "flex", gap: 8, marginTop: 12, alignItems: "center" }, children: [
					jsx.jsx("button", { type: "button", disabled: !writable || saving, onClick: save, style: { cursor: "pointer", border: "none", borderRadius: 14, height: 28, padding: "0 14px", fontSize: 13, background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)" }, children: saving ? t("saving") : t("save") }),
					dirty && jsx.jsx("button", { type: "button", onClick: () => setDraft(structuredClone(value)), style: { cursor: "pointer", border: "none", background: "0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 13, padding: 0 }, children: t("discard") }),
					dirty && jsx.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 }, children: t("unsaved") }),
					error !== null && jsx.jsx("span", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12 }, children: error })
				] })
			] });
		}

		// ─── 引擎设置项（settings.section，与"模型""插件"同级） ───
		function EngineSection({ scope, t }) {
			const [status, setStatus] = react.useState({ loading: true, running: false, busy: false, message: null, phase: "idle" });
			const [modeError, setModeError] = react.useState(null);
			// 当前 TTS 模式（云端模式隐藏本地引擎开关，避免重叠）
			const [snap, setSnap] = react.useState(() => {
				try { return scope.getSnapshot(); } catch { return null; }
			});
			react.useEffect(() => {
				try { return onDeactivate(scope.subscribe(() => setSnap(scope.getSnapshot()))); } catch { return () => {}; }
			}, [scope]);
			const sectionProvider = snap?.value?.provider || "gsv";
			const refresh = react.useCallback(async () => {
				try {
					const resp = await pluginFetch("api/dsh-gsv-tts/engine/status");
					const data = await resp.json();
					setStatus((s) => ({ ...s, loading: false, running: !!data.running, message: data.message || null }));
				} catch (e) {
					setStatus((s) => ({ ...s, loading: false, message: String((e && e.message) || e) }));
				}
			}, []);
			react.useEffect(() => { refresh(); }, [refresh]);
			const toggle = async () => {
				const target = status.running ? "off" : "on";
				const signal = lifecycle?.signal;
				setStatus((s) => ({ ...s, busy: true, message: null, phase: target }));
				const failed = e => {
					if (!signal?.aborted) setStatus(s => ({ ...s, busy: false, phase: "idle", message: String(e?.message || e) }));
				};
				try {
					const resp = await pluginFetch("api/dsh-gsv-tts/engine/" + (target === "on" ? "start" : "stop"), { method: "POST" });
					const data = await resp.json();
					if (target === "on" && !data.running) {
						// 启动较慢：轮询直到就绪（最多 ~90s）
						const deadline = Date.now() + 90000;
						const poll = async () => {
							if (signal?.aborted) return;
							if (Date.now() > deadline) {
								await refresh();
								setStatus((s) => ({ ...s, busy: false, phase: "idle" }));
								return;
							}
							const sResp = await pluginFetch("api/dsh-gsv-tts/engine/status");
							const sData = await sResp.json();
							if (sData.running) {
								setStatus({ loading: false, running: true, busy: false, message: null, phase: "idle" });
							} else {
								let timer;
								const cancel = onDeactivate(() => clearTimeout(timer));
								if (!signal?.aborted) timer = setTimeout(() => {
									cancel();
									void poll().catch(failed);
								}, 3000);
							}
						};
						await poll();
						return;
					}
					setStatus({ loading: false, running: !!data.running, busy: false, message: data.message || null, phase: "idle" });
				} catch (e) {
					failed(e);
				}
			};
			const rowStyle = { display: "flex", alignItems: "center", gap: 10, marginTop: 12 };
			const engineMode = (snap && snap.value && snap.value.engineMode) === "always" ? "always" : "eco";
			const switchEngineMode = async (mode) => {
				if (mode === engineMode) return;
				setModeError(null);
				try {
					const accepted = await scope.set("engineMode", mode);
					if (accepted === false) {
						setModeError(t("engineMode.saveFailed"));
						return;
					}
					// 切到常驻：如果引擎还没起，顺手启动并预热
					if (mode === "always" && !status.running) void toggle();
				} catch (e) {
					setModeError(String((e && e.message) || e));
				}
			};
			const modeCard = (mode, title, desc) => jsx.jsxs("button", {
				type: "button",
				onClick: () => switchEngineMode(mode),
				style: {
					flex: "1 1 240px",
					minWidth: 220,
					textAlign: "left",
					cursor: "pointer",
					font: "inherit",
					borderRadius: 10,
					padding: "10px 12px",
					border: "1px solid " + (engineMode === mode ? "var(--dsw-alias-brand, #6e56cf)" : "var(--dsw-alias-border-l2)"),
					background: engineMode === mode ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
					color: "inherit",
				},
				children: [
					jsx.jsx("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }, children: title }),
					jsx.jsx("div", { style: { fontSize: 11, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)", marginTop: 3 }, children: desc }),
				],
			});
			const statusText = status.phase === "on" ? t("engineStarting") : status.phase === "off" ? t("engineStopping") : status.running ? t("engineRunning") : t("engineStopped");
			return jsx.jsx(GsvErrorBoundary, { children: jsx.jsxs("div", { children: [
				sectionProvider === "gsv" && jsx.jsx(react.Fragment, { children: [
					jsx.jsx("div", { style: { fontWeight: 600, fontSize: 14, color: "var(--dsw-alias-label-primary)" }, children: t("engineTitle") }),
					jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 2 }, children: t("engineDesc") }),
					jsx.jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, marginTop: 12 }, children: t("engineMode.title") }),
					jsx.jsxs("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }, children: [
						modeCard("always", t("engineMode.always"), t("engineMode.alwaysDesc")),
						modeCard("eco", t("engineMode.eco"), t("engineMode.ecoDesc")),
					] }),
					modeError !== null && jsx.jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12, marginTop: 6 }, children: modeError }),
					jsx.jsxs("div", { style: rowStyle, children: [
						jsx.jsx("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, children: jsx.jsxs(react.Fragment, { children: [
							jsx.jsx("input", { type: "checkbox", disabled: status.busy, checked: status.running, onChange: toggle }),
							jsx.jsx("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" }, children: status.running ? t("engineOff") : t("engineOn") })
						] }) }),
						jsx.jsx("span", { style: { fontSize: 12, color: status.running ? "var(--dsw-alias-success, #30a46c)" : "var(--dsw-alias-label-tertiary)" }, children: statusText })
					] }),
					status.message !== null && jsx.jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12, marginTop: 6 }, children: status.message })
				] }),
				sectionProvider !== "gsv" && jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 2 }, children: t("engineNotNeeded") }),
				jsx.jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: 16, paddingTop: 8 }, children: jsx.jsx(TtsSettingsCard, { scope, t }) }),
				jsx.jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: 16, paddingTop: 8 }, children: jsx.jsx(HelpBlock, { t }) })
			] }) });
		}

		// ─── 帮助文档（渲染在"声音设置"内部） ───
		const HELP_DOC = [
			{ title: "一、下载安装语音引擎（GSV-TTS-Lite）", steps: [
				"方式一（推荐）：让 agent 调用 tts_setup_engine 工具自动安装——检测 Python → 安装 gsv-tts-lite → 克隆仓库 → 安装依赖 → 部署流式 API → 启动服务。",
				"方式二（手动）：",
				"1. 安装 Python 3.10+（推荐 3.12），并确保 pip 可用",
				"2. 安装核心包：pip install gsv-tts-lite==0.4.7",
				"3. 克隆仓库：git clone https://github.com/chinokikiss/GSV-TTS-Lite.git",
				"4. 安装 API 依赖：pip install -r <仓库>/API/requirements.txt",
				"5. 把插件自带的 scripts/dsh_stream_api.py 复制到 <仓库>/API/ 目录",
				"6. 下载模型（s1v3.ckpt、s2Gv2ProPlus.pth 等）放入 <仓库>/models/",
				"7. 启动：python <仓库>/API/dsh_stream_api.py -p 9880 --models_dir <仓库>/models",
				"8. 回到本页，打开引擎开关，等待“运行中”"
			] },
			{ title: "二、添加音色", steps: [
				"1. 在“音色预设”下点击“添加音色”",
				"2. 填写四个字段：",
				"   · 音色名称：如“拉菲”，tts_speak 与朗读按钮按它选择",
				"   · 参考音频路径：目标音色的参考音频（决定声音像谁），如 D:\\GSV\\GSV-TTS-Lite\\examples\\laffey.mp3",
				"   · 提示音频路径：语调/情感参考音频，如 D:\\GSV\\GSV-TTS-Lite\\examples\\AnAn.ogg",
				"   · 提示文本：提示音频对应的文字（引擎不支持留空自动转写，请务必填写）",
				"3. 可先点击每条音色旁的“试听”，用固定文案听效果（未保存也能试听）；“全部试听（循环）”会循环播放所有音色，方便对比",
				"4. 点击“保存”，立即生效，无需重启",
				"5. 默认音色留空则使用列表第一个音色"
			] },
			{ title: "三、常见问题", steps: [
				"· 引擎未启动：打开本页顶部的开关启动（模型加载约 15~90 秒）",
				"· 参考音频：必须是引擎服务端能访问的本地路径或可访问 URL",
				"· 模型缺失：首次启动会提示，把模型放入 models 目录即可",
				"· 引擎示例音频：<仓库>/examples/ 下有 laffey.mp3、AnAn.ogg 可直接试用"
			] }
		];
		function HelpBlock({ t }) {
			const blockStyle = { marginTop: 16 };
			const titleStyle = { fontWeight: 600, fontSize: 14, color: "var(--dsw-alias-label-primary)" };
			const itemStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: 13, lineHeight: 1.8, marginTop: 6, whiteSpace: "pre-wrap" };
			return jsx.jsxs("div", { children: [
				jsx.jsx("div", { style: { fontWeight: 600, fontSize: 14, color: "var(--dsw-alias-label-primary)" }, children: t("helpTitle") }),
				HELP_DOC.map((sec) => jsx.jsxs("div", { style: blockStyle, children: [
					jsx.jsx("div", { style: titleStyle, children: sec.title }),
					sec.steps.map((step) => jsx.jsx("div", { style: itemStyle, children: step }))
				] }, sec.title))
			] });
		}

		// ─── 自动朗读轮询（常驻，仅 autoPlay 开启时生效；热更新读取最新配置） ───
		function AutoPlayObserver({ sessionId, scope }) {
			react.useEffect(() => {
				if (!sessionId) return;
				const ac = new AbortController();
				const keyPrefix = "autoplay:" + sessionId + ":";
				let cursor;
				let enabled = false;
				let polling = false;
				let pending = null;
				let playingAttempt;
				let lastPoll = -Infinity;
				const post = (path, data, signal, accept) => pluginFetch("api/dsh-gsv-tts/autoplay/" + path, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...(accept ? { Accept: accept } : {}) },
					body: JSON.stringify({ sessionId, ...data }),
					signal
				});
				const tick = async () => {
					const cfg = scope.getSnapshot()?.value;
					if (!cfg?.autoPlay) {
						if (enabled) {
							enabled = false;
							cursor = undefined;
							pending?.controller.abort();
							pending = null;
							if (player.key?.startsWith(keyPrefix)) player.stop();
						}
						return;
					}
					enabled = true;
					if (document.hidden || microphoneActive() || polling) return;
					const now = performance.now();
					if (now - lastPoll < (cfg.liveReply ? 245 : 1950)) return;
					lastPoll = now;
					polling = true;
					try {
						const sinceSeq = cursor;
						const resp = await post("poll", { sinceSeq }, ac.signal);
						if (!resp.ok) return;
						const next = await resp.json();
						if (!Number.isSafeInteger(next.seq) || ac.signal.aborted || cursor !== sinceSeq
							|| !scope.getSnapshot()?.value?.autoPlay) return;
						if (pending?.attempt && next.cancelled?.includes(pending.attempt)) {
							pending.controller.abort();
							pending = null;
						}
						if (playingAttempt && next.cancelled?.includes(playingAttempt) && player.key?.startsWith(keyPrefix)) player.stop();
						if (!next.messageId) {
							cursor = next.seq;
							return;
						}
						if (pending?.seq === next.seq) return;
						if (next.attemptId && (pending?.attempt === next.attemptId ||
							(playingAttempt === next.attemptId && player.key?.startsWith(keyPrefix) && player.state !== "idle"))) return;
						if (!cfg.interruptOnNew && (player.state !== "idle" || activeSpeak)) return;
						activeSpeak?.abort();
						const controller = new AbortController();
						const item = { seq: next.seq, attempt: next.attemptId, controller };
						pending = item;
						activeSpeak = controller;
						const signal = AbortSignal.any([ac.signal, controller.signal]);
						void (async () => {
							try {
								const speech = await post("speak", { seq: next.seq, messageId: next.messageId }, signal,
									acceptSpeech());
								if (speech.status === 404) return; // 消息刚被回收，重新轮询。
								await playSpeakResponse(speech, keyPrefix + next.messageId, signal, () => {
									cursor = next.seq;
									playingAttempt = next.attemptId;
									showPanel(next.attemptId ? null : { sessionId, messageId: next.messageId });
								}, now);
							} catch (error) {
								if (pending !== item) return;
								cursor = next.seq; // 合成失败或主动取消后，不自动重复付费请求。
								if (!signal.aborted) {
									player.error = String(error?.message || error);
									player._emit();
								}
							} finally {
								if (pending === item) pending = null;
								if (activeSpeak === controller) activeSpeak = null;
							}
						})();
					} catch (error) {
						if (!ac.signal.aborted) console.warn("[dsh-gsv-tts] 自动朗读轮询失败:", error);
					} finally {
						polling = false;
					}
				};
				void tick();
				const timer = setInterval(tick, 250);
				const unsubscribe = scope.subscribe(() => { void tick(); });
				return onDeactivate(() => {
					clearInterval(timer);
					unsubscribe();
					ac.abort();
					if (player.key?.startsWith(keyPrefix)) player.stop();
				});
			}, [sessionId, scope]);
			return null;
		}

		// ─── 插件主体 ───
		// DSH 0.2+：设置作用域由 configForms 服务提供（旧 settingsScope 已移除）；
		// configForms.get(namespace) 返回带 getSnapshot/subscribe/set/unset 的表单控制器。
		const inject = ["slots", "locale", "configForms"];
		function bindSettingsScope(ctx) {
			try {
				return ctx.configForms.get("dsh-gsv-tts");
			} catch (e) {
				return { getSnapshot: () => ({ status: "unavailable", error: String((e && e.message) || e) }), subscribe: () => () => {} };
			}
		}
		function apply(ctx) {
			lifecycle = new AbortController();
			const controller = lifecycle;
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "gsv-tts: dictionaries");
			// 朗读按钮
			ctx.slots.inject("conversation.chat.assistant-actions", () => {
				const dispose = ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "read-aloud",
					order: 20,
					locale: NS,
					inject: (sessionId) => ({ sessionId })
				}, ReadAloudButton);
				return () => { dispose(); };
			});
			// 引擎设置项（与"模型""插件"同级）：引擎开关 + 声音设置（TTS 配置）+ 帮助文档
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "engine",
				order: 20,
				label: () => t("engineNav"),
				locale: NS,
				inject: () => ({ scope: bindSettingsScope(ctx), t: ctx.locale.bind(NS) })
			}, EngineSection));
			// 整段播放/下载面板 + 选中文字朗读浮钮（默认流式朗读，只有点「整段」才生成完整文件）
			ctx.effect(() => {
				const hasDocument = typeof document !== "undefined";
				if (hasDocument) installActionStyles();
				const unlock = hasDocument && typeof window !== "undefined" ? installAudioUnlock() : () => {};
				ensurePanel();
				const selection = installSelectionMenu();
				const microphone = typeof MutationObserver !== "undefined" && typeof document !== "undefined"
					? new MutationObserver(() => {
						if (microphoneActive() && (player.state !== "idle" || activeSpeak || fullAbort)) stopPlayback();
					}) : null;
				if (microphone && document.body) microphone.observe(document.body,
					{ childList: true, subtree: true, attributes: true, attributeFilter: ["data-voice-activity"] });
				return () => {
					controller.abort();
					selection();
					unlock();
					microphone?.disconnect();
					unsubscribePanel?.();
					unsubscribePanel = null;
					stopPlayback();
					player.listeners.clear();
					fullCtx = fullUrl = null;
					gsvPanel?.remove();
					gsvPanel = null;
					panelStyle?.remove();
					panelStyle = null;
					actionStyle?.remove();
					actionStyle = null;
					globalThis.CSS?.highlights?.delete("dsh-gsv-sentence");
				};
			}, "gsv-tts: player-panel");
			const scope = bindSettingsScope(ctx);
			ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
				name: "conversation.input.overlay",
				id: "dsh-gsv-tts-autoplay",
				inject: sessionId => ({ sessionId, scope })
			}, AutoPlayObserver));
		}

		exports.apply = apply;
		exports.inject = inject;
		// 额外导出播放器单例：仅供自动化测试驱动，宿主仅使用 apply/inject
		exports.player = player;
		return module.exports;
	}
});
