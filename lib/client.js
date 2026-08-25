// dsh-gsv-tts 客户端插件（手写 bundle，遵循 DSH client module 格式）
// - 消息操作区（复制/点赞旁）增加"朗读"按钮：朗读该条助手结果（不含思考），调用宿主 /dsh-gsv-tts/speak
// - 设置 → 插件配置：dsh-gsv-tts 设置卡片（音色、自动朗读、API 等，保存后热生效）
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
		const css = "._gsv_action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex;font-size:14px}._gsv_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}._gsv_action:disabled{cursor:default;opacity:.4}._gsv_failure{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-left:6px}";
		const tagId = "dsh-gsv-tts/read-button.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-gsv-tts";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ─── 文案 ───
		const NS = "gsv-tts";
		const zh = {
			"read": "朗读结果",
			"reading": "朗读中…",
			"cardTitle": "声音设置",
			"cardDesc": "调整 TTS 音色、自动朗读等设置，保存后即时生效。",
			"field.apiUrl": "API 地址",
			"field.apiUrlHint": "GSV-TTS-Lite 服务地址",
			"field.defaultVoice": "默认音色",
			"field.defaultVoiceHint": "留空使用第一个音色",
			"field.autoPlay": "自动朗读助手回复",
			"field.timeout": "请求超时（毫秒）",
			"field.installDir": "引擎安装目录",
			"field.voices": "音色预设",
			"voice.name": "音色名称",
			"voice.speaker": "参考音频路径",
			"voice.prompt": "提示音频路径",
			"voice.promptText": "提示文本",
			"voice.add": "添加音色",
			"voice.remove": "删除",
			"save": "保存",
			"saving": "保存中…",
			"discard": "放弃修改",
			"readOnly": "本部署的设置只读。",
			"unsaved": "未保存",
			"engineNav": "声音设置",
			"engineTitle": "语音引擎（GSV-TTS-Lite）",
			"engineDesc": "启动或停止本地 TTS 引擎。默认关闭，需要朗读时再打开。",
			"engineOn": "启动引擎",
			"engineOff": "停止引擎",
			"engineRunning": "运行中",
			"engineStopped": "已停止",
			"engineStarting": "启动中…（模型加载需要一些时间）",
			"engineStopping": "停止中…",
			"helpTitle": "帮助"
		};
		const en = {
			"read": "Read result",
			"reading": "Reading…",
			"cardTitle": "Voice Settings",
			"cardDesc": "Adjust TTS voices and auto-read; changes apply instantly.",
			"field.apiUrl": "API URL",
			"field.apiUrlHint": "GSV-TTS-Lite service URL",
			"field.defaultVoice": "Default voice",
			"field.defaultVoiceHint": "Empty uses the first voice",
			"field.autoPlay": "Auto-read assistant replies",
			"field.timeout": "Timeout (ms)",
			"field.installDir": "Engine install directory",
			"field.voices": "Voices",
			"voice.name": "Name",
			"voice.speaker": "Speaker audio path",
			"voice.prompt": "Prompt audio path",
			"voice.promptText": "Prompt text",
			"voice.add": "Add voice",
			"voice.remove": "Remove",
			"save": "Save",
			"saving": "Saving…",
			"discard": "Discard",
			"readOnly": "Settings are read-only in this deployment.",
			"unsaved": "Unsaved",
			"engineNav": "Voice Settings",
			"engineTitle": "Speech Engine (GSV-TTS-Lite)",
			"engineDesc": "Start or stop the local TTS engine. Off by default; turn on to read aloud.",
			"engineOn": "Start engine",
			"engineOff": "Stop engine",
			"engineRunning": "Running",
			"engineStopped": "Stopped",
			"engineStarting": "Starting… (model loading takes a while)",
			"engineStopping": "Stopping…",
			"helpTitle": "Help"
		};

		// ─── 朗读按钮（conversation.chat.assistant-actions 插槽） ───
		function ReadAloudButton({ messageId, sessionId, t }) {
			const [busy, setBusy] = react.useState(false);
			const [failure, setFailure] = react.useState(null);
			const onRead = react.useCallback(async () => {
				setBusy(true);
				setFailure(null);
				try {
					const resp = await fetch("/dsh-gsv-tts/speak", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ sessionId, messageId })
					});
					const data = await resp.json().catch(() => ({}));
					if (!resp.ok) throw new Error(data.message || ("HTTP " + resp.status));
					if (!data.audioUrl) throw new Error("no audio url");
					const audio = new Audio(data.audioUrl);
					await audio.play();
				} catch (e) {
					setFailure(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			}, [sessionId, messageId]);
			return jsx.jsxs(react.Fragment, { children: [
				jsx.jsx(primitives.Tooltip, {
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

		// ─── 设置卡片（settings.plugin.item 插槽） ───
		const FIELD_LABELS = ["apiUrl", "defaultVoice", "timeout", "installDir"];
		function TtsSettingsCard({ scope, t }) {
			const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot());
			react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
			const value = (snapshot && snapshot.value) || {};
			const writable = !!(snapshot && snapshot.writable);
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [error, setError] = react.useState(null);
			const valueJson = JSON.stringify(value);
			react.useEffect(() => {
				setDraft(structuredClone(value));
			}, [valueJson]);
			const dirty = draft !== null && JSON.stringify(draft) !== valueJson;
			if (draft === null) return null;
			const patchField = (field, next) => setDraft({ ...draft, [field]: next });
			const patchVoice = (index, field, next) => {
				const voices = (draft.voices || []).map((v, i) => i === index ? { ...v, [field]: next } : v);
				patchField("voices", voices);
			};
			const addVoice = () => patchField("voices", [...(draft.voices || []), { name: "", speakerAudioPath: "", promptAudioPath: "", promptText: "" }]);
			const removeVoice = (index) => patchField("voices", (draft.voices || []).filter((_, i) => i !== index));
			const save = async () => {
				setSaving(true);
				setError(null);
				try {
					const base = (snapshot && snapshot.base) || {};
					for (const field of ["apiUrl", "defaultVoice", "autoPlay", "timeout", "installDir", "voices"]) {
						const next = draft[field];
						const baseVal = base[field];
						if (baseVal !== void 0 && JSON.stringify(next) === JSON.stringify(baseVal)) {
							await scope.unset(field);
						} else {
							await scope.set(field, next);
						}
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
			return jsx.jsxs("div", { children: [
				jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 2 }, children: t("cardDesc") }),
				!writable && jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 6 }, children: t("readOnly") }),
				jsx.jsx("label", { style: labelStyle, children: t("field.apiUrl") }),
				jsx.jsx("input", { style: inputStyle, disabled: !writable, value: draft.apiUrl ?? "", placeholder: t("field.apiUrlHint"), onChange: (e) => patchField("apiUrl", e.target.value) }),
				jsx.jsx("label", { style: labelStyle, children: t("field.defaultVoice") }),
				jsx.jsx("input", { style: inputStyle, disabled: !writable, value: draft.defaultVoice ?? "", placeholder: t("field.defaultVoiceHint"), onChange: (e) => patchField("defaultVoice", e.target.value) }),
				jsx.jsx("label", { style: labelStyle, children: t("field.timeout") }),
				jsx.jsx("input", { style: inputStyle, disabled: !writable, type: "number", value: draft.timeout ?? 30000, onChange: (e) => patchField("timeout", Number(e.target.value)) }),
				jsx.jsx("label", { style: labelStyle, children: t("field.installDir") }),
				jsx.jsx("input", { style: inputStyle, disabled: !writable, value: draft.installDir ?? "", onChange: (e) => patchField("installDir", e.target.value) }),
				jsx.jsx("label", { style: { ...labelStyle, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }, children: jsx.jsxs(react.Fragment, { children: [
					jsx.jsx("input", { type: "checkbox", disabled: !writable, checked: !!draft.autoPlay, onChange: (e) => patchField("autoPlay", e.target.checked) }),
					t("field.autoPlay")
				] }) }),
				jsx.jsx("label", { style: labelStyle, children: t("field.voices") }),
				(draft.voices || []).map((v, i) => jsx.jsxs("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: 8, marginBottom: 8 }, children: [
					jsx.jsx("input", { style: inputStyle, disabled: !writable, value: v.name ?? "", placeholder: t("voice.name"), onChange: (e) => patchVoice(i, "name", e.target.value) }),
					jsx.jsx("input", { style: { ...inputStyle, marginTop: 4 }, disabled: !writable, value: v.speakerAudioPath ?? "", placeholder: t("voice.speaker"), onChange: (e) => patchVoice(i, "speakerAudioPath", e.target.value) }),
					jsx.jsx("input", { style: { ...inputStyle, marginTop: 4 }, disabled: !writable, value: v.promptAudioPath ?? "", placeholder: t("voice.prompt"), onChange: (e) => patchVoice(i, "promptAudioPath", e.target.value) }),
					jsx.jsx("input", { style: { ...inputStyle, marginTop: 4 }, disabled: !writable, value: v.promptText ?? "", placeholder: t("voice.promptText"), onChange: (e) => patchVoice(i, "promptText", e.target.value) }),
					writable && jsx.jsx("button", { type: "button", onClick: () => removeVoice(i), style: { marginTop: 6, cursor: "pointer", border: "none", background: "0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 12, padding: 0 }, children: t("voice.remove") })
				], }, i)),
				writable && jsx.jsx("button", { type: "button", onClick: addVoice, style: { cursor: "pointer", border: "1px dashed var(--dsw-alias-border-l2)", background: "0 0", color: "var(--dsw-alias-label-secondary)", borderRadius: 8, padding: "4px 10px", fontSize: 13 }, children: t("voice.add") }),
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
			const refresh = react.useCallback(async () => {
				try {
					const resp = await fetch("/dsh-gsv-tts/engine/status");
					const data = await resp.json();
					setStatus((s) => ({ ...s, loading: false, running: !!data.running, message: data.message || null }));
				} catch (e) {
					setStatus((s) => ({ ...s, loading: false, message: String((e && e.message) || e) }));
				}
			}, []);
			react.useEffect(() => { refresh(); }, [refresh]);
			const toggle = async () => {
				const target = status.running ? "off" : "on";
				setStatus((s) => ({ ...s, busy: true, message: null, phase: target }));
				try {
					const resp = await fetch("/dsh-gsv-tts/engine/" + (target === "on" ? "start" : "stop"), { method: "POST" });
					const data = await resp.json();
					if (target === "on" && !data.running) {
						// 启动较慢：轮询直到就绪（最多 ~90s）
						const deadline = Date.now() + 90000;
						const poll = async () => {
							if (Date.now() > deadline) {
								await refresh();
								setStatus((s) => ({ ...s, busy: false, phase: "idle" }));
								return;
							}
							const sResp = await fetch("/dsh-gsv-tts/engine/status");
							const sData = await sResp.json();
							if (sData.running) {
								setStatus({ loading: false, running: true, busy: false, message: null, phase: "idle" });
							} else {
								setTimeout(poll, 3000);
							}
						};
						poll();
						return;
					}
					setStatus({ loading: false, running: !!data.running, busy: false, message: data.message || null, phase: "idle" });
				} catch (e) {
					setStatus((s) => ({ ...s, busy: false, phase: "idle", message: String((e && e.message) || e) }));
				}
			};
			const rowStyle = { display: "flex", alignItems: "center", gap: 10, marginTop: 12 };
			const statusText = status.phase === "on" ? t("engineStarting") : status.phase === "off" ? t("engineStopping") : status.running ? t("engineRunning") : t("engineStopped");
			return jsx.jsxs("div", { children: [
				jsx.jsx("div", { style: { fontWeight: 600, fontSize: 14, color: "var(--dsw-alias-label-primary)" }, children: t("engineTitle") }),
				jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginTop: 2 }, children: t("engineDesc") }),
				jsx.jsxs("div", { style: rowStyle, children: [
					jsx.jsx("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, children: jsx.jsxs(react.Fragment, { children: [
						jsx.jsx("input", { type: "checkbox", disabled: status.busy, checked: status.running, onChange: toggle }),
						jsx.jsx("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" }, children: status.running ? t("engineOff") : t("engineOn") })
					] }) }),
					jsx.jsx("span", { style: { fontSize: 12, color: status.running ? "var(--dsw-alias-success, #30a46c)" : "var(--dsw-alias-label-tertiary)" }, children: statusText })
				] }),
				status.message !== null && jsx.jsx("div", { style: { color: "var(--dsw-alias-danger, #e5484d)", fontSize: 12, marginTop: 6 }, children: status.message }),
				jsx.jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: 16, paddingTop: 8 }, children: jsx.jsx(TtsSettingsCard, { scope, t }) }),
				jsx.jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: 16, paddingTop: 8 }, children: jsx.jsx(HelpBlock, { t }) })
			] });
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
				"3. 点击“保存”，立即生效，无需重启",
				"4. 默认音色留空则使用列表第一个音色"
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

		// ─── 插件主体 ───
		const inject = ["slots", "locale", "settingsScope"];
		function apply(ctx) {
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
				inject: () => ({ scope: ctx.settingsScope.bind({ namespace: "dsh-gsv-tts" }), t: ctx.locale.bind(NS) })
			}, EngineSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
