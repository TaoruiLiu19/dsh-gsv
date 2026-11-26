import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TTSService } from './tts.service.js';
import { VoiceManager } from './voice-manager.js';
import { EngineSetup } from './setup.js';
import { AudioStore } from './audio-store.js';
import { EngineManager, enginePaths } from './engine-manager.js';
import { VoiceRegistryManager } from './voice-registry.js';
import { resolveProvider } from './migration.js';
import { SCHEMA_VERSION, snapshotConfig, storedProvider } from './config.js';
import { DeepseekProvider } from './providers/deepseek.js';
import { CustomSpeechProvider } from './providers/custom.js';
import { SpeechStats, usageLedgerPath } from './speech-stats.js';
import { GsvProvider } from './providers/gsv.js';
import { registerPlaybackRoutes } from './playback-routes.js';
import { selectVoice } from './voice-selection.js';
import {
  GSV_ENGINE,
  defaultVoiceFor,
  getProviderDescriptor,
  isValidVoiceId,
  providerIds,
} from './catalog.js';
import { entriesForProvider, parseLexicon, previewLexicon } from './lexicon.js';
import { buildDoctorReport, describeCredentialSource, type EngineFacts, type SetupFacts } from './doctor.js';
import type { Config as PluginConfig, HealthCheckResult, ProviderKind, SetupResult } from './types.js';

export const name = 'dsh-gsv-tts';
export const inject = ['tools', 'webServer', 'settings', 'sessions', 'connection'];

/** 插件 profile 条目 id（= 设置命名空间）；正常安装即包名。 */
const DEFAULT_ENTRY_ID = 'dsh-gsv-tts';

/** 音色试听固定文案：含长短句、数字与语气词，便于靠耳朵对比音色。 */
const PREVIEW_TEXT = '这是一段音色试听：你好，欢迎使用本地语音引擎。今天的天气很好，我们出发去爬山吧，一二三四五！';

/**
 * 设置字段统一标记为 volatile（DSH 0.2+）：
 * 允许在设置面板即时编辑，保存后由宿主就地更新配置引用、不重载插件。
 * 所有读取都走 snapshotConfig()/readConfig()，因此始终拿到最新值。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const live = (schema: any): any => schema.volatile();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Config: any = Schema.object({
  apiUrl: live(Schema.string().default('http://localhost:9880').description('GSV-TTS-Lite API 服务地址')),
  voices: live(Schema.array(Schema.object({
    name: Schema.string().description('音色名称'),
    speakerAudioPath: Schema.string().description('目标音色参考音频路径').role('path'),
    promptAudioPath: Schema.string().description('提示音频路径（声音克隆必需）').role('path'),
    promptText: Schema.string().description('提示文本（对应提示音频的文字，留空时若引擎支持 ASR 会自动转写，否则合成报错）').default(''),
    id: Schema.string().description('注册表来源 id（注册表安装音色用）').default(''),
    source: Schema.string().description('音色来源：user 自定义 / registry 注册表安装').default('user'),
  })).default([]).description('音色预设列表，可在设置中自定义')),
  defaultVoice: live(Schema.string().description('默认音色（gsv=预设名 / edge=云端音色 id / deepseek=官方音色 stella|tide，留空用第一个）').default('')),
  voiceByProvider: live(Schema.dict(Schema.string()).default({}).description('各提供方上次保存的音色')),
  autoPlay: live(Schema.boolean().default(false).description('是否自动朗读助手回复')),
  liveReply: live(Schema.boolean().default(false).description('生成中的正文逐句朗读')),
  engineMode: live(Schema.union([Schema.const('always'), Schema.const('eco')]).default('eco').description('引擎启动方式：always=常驻模式（性能优先，自动启动并预热）/ eco=节能模式（资源优先，不后台启动，与旧版一致）')),
  interruptOnNew: live(Schema.boolean().default(true).description('自动朗读时，新回复是否打断当前朗读（关闭则按顺序朗读）')),
  timeout: live(Schema.number().min(1).default(30000).description('请求超时时间（毫秒）')),
  installDir: live(Schema.string().default('./GSV-TTS-Lite').description('GSV-TTS-Lite 引擎安装目录')),
  voiceRegistryUrl: live(Schema.string().default('https://taoruiliu19.github.io/gsv-market/voices.json').description('音色市场远端清单地址（默认指向在线试听站点；留空则仅用包内离线清单）')),
  schemaVersion: live(Schema.number().default(SCHEMA_VERSION).description('配置结构版本')),
  provider: live(Schema.union(providerIds().map((id) => Schema.const(id))).description('TTS 提供方（本地 GSV、Edge、官方 DeepSeek 或自定义兼容服务）')),
  deepseekApiKey: live(Schema.string().default('').description('DeepSeek 官方语音 API Key（可选覆盖；留空默认复用 Harness 凭据服务里的 DEEPSEEK_API_KEY）')),
  lexicon: live(Schema.string().default('').description('发音词典：每行 原词=读法，# 开头为注释；对所有模式生效（如 DSH=DeepSeek）')),
  deepseekApiKeyEnv: live(Schema.string().default('DEEPSEEK_API_KEY').description('凭据引用名：默认复用 Harness 已保存的 DEEPSEEK_API_KEY（模型设置页那个），留空则不查凭据服务')),
  deepseekAutoCharsPerDay: live(Schema.union([Schema.number().min(0), Schema.const(null)]).default(null).description('每日 DeepSeek 自动朗读计费字符上限（留空不限，0 禁止自动合成）')),
  customBaseUrl: live(Schema.string().default('').description('兼容 TTS 的 Base URL，例如 http://127.0.0.1:8880/v1')),
  customModel: live(Schema.string().default('kokoro')),
  customKeyRef: live(Schema.string().default('').description('DSH 凭据引用名，留空不发送密钥')),
  customInstructions: live(Schema.string().default('').description('后端支持时使用的语气、情绪或停顿指令')),
  customFormat: live(Schema.union([Schema.const('pcm'), Schema.const('wav')]).default('pcm')),
  gsvSpeed: live(Schema.number().min(0.5).max(2).default(1).description('GSV 合成语速')),
  gsvModelManifest: live(Schema.string().default('').description('可信模型版本与 SHA-256 的 JSON 清单路径')),
  quotaDaily: live(Schema.union([Schema.number().min(0), Schema.const(null)]).default(null).description('云端简单模式每日配额（null=不限量，仅引导用）')),
});

export function apply(ctx: any, config: any) {
  /** 当前生效配置快照：DSH 0.2+ 的 volatile 字段是就地更新的引用，每次读取都取最新值。 */
  const readConfig = (): PluginConfig => snapshotConfig(config);
  /** 设置命名空间 = profile 条目 id；正常安装即包名。 */
  const entryId: string = ctx.fiber?.entry?.options?.id ?? DEFAULT_ENTRY_ID;

  /** Web 服务同源地址：监听绑定前 getOrigin() 会抛错，按需读取并兜底为同源相对路径。 */
  const audioOrigin = (): string | undefined => {
    try {
      if (typeof ctx.webServer?.getOrigin === 'function') return ctx.webServer.getOrigin();
      if (ctx.webServer?.host && ctx.webServer?.port) return `http://${ctx.webServer.host}:${ctx.webServer.port}`;
    } catch {
      // 监听尚未绑定：退回同源相对路径
    }
    return undefined;
  };

  const hostPath = ctx.get?.('dshHomePath');
  const dshHomePath = typeof hostPath === 'function' ? hostPath as (...segments: string[]) => string : undefined;
  const scope = JSON.stringify([dshHomePath?.() ?? process.env.DSH_HOME ?? '', entryId]);
  const audioStore = new AudioStore(audioOrigin, scope);
  const stats = new SpeechStats(usageLedgerPath(dshHomePath, audioStore.profileDirectory));
  const voiceManager = new VoiceManager(readConfig);
  const engineManager = new EngineManager(readConfig);
  ctx.effect(() => () => engineManager.dispose());
  ctx.effect(() => () => audioStore.dispose());
  ctx.effect(() => () => stats.dispose());
  const setup = new EngineSetup(readConfig, engineManager);
  const deepseek = new DeepseekProvider({ getConfig: readConfig, credentials: () => ctx.get?.('credentials') });
  const gsv = new GsvProvider({
    getConfig: readConfig,
    voiceManager,
    headers: apiUrl => engineManager.headers(apiUrl),
    health: async () => {
      const status = await engineManager.status();
      return { available: status.running, message: status.message };
    },
  });
  let lastFailure: { at: number; provider: string; message: string } | null = null;
  const noteFailure = (error: unknown): void => {
    lastFailure = { at: Date.now(), provider: readConfig().provider, message: String((error as Error)?.message ?? error).slice(0, 300) };
  };
  const custom = new CustomSpeechProvider(readConfig, () => ctx.get?.('credentials'));
  const tts = new TTSService(readConfig, audioStore, { voiceManager, deepseek, custom, gsv, stats, onFailure: noteFailure });

  // 引擎启动后预热默认音色：缓存 speaker/prompt 特征 + 一次短推理，
  // 让用户第一次点朗读时不再付首次特征计算/首次推理的开销。
  const prewarmDefaultVoice = async (): Promise<void> => {
    const cfg = readConfig();
    if (cfg.provider !== 'gsv') return;
    const preset = voiceManager.get();
    if (!preset) return;
    try {
      await tts.warmupVoice(preset);
    } catch {
      // 预热失败不影响正常使用
    }
  };

  // 常驻模式在后台启动并尝试预热。节能模式需要手动启动。
  let autoStartStarted = false;
  const autoStartEngine = async (): Promise<void> => {
    if (autoStartStarted) return;
    autoStartStarted = true;
    const cfg = readConfig();
    if (cfg.provider !== 'gsv' || cfg.engineMode !== 'always') return;
    try {
      const result = await engineManager.start(cfg);
      if (result.ok) void prewarmDefaultVoice();
    } catch {
      // 引擎启动失败时保持原状，用户仍可手动启动
    }
  };
  ctx.effect(() => {
    const timer = setTimeout(() => { void autoStartEngine(); }, 1500);
    return () => clearTimeout(timer);
  });

  // 旧设置首次启动时为当前提供方保存已有音色，修复不适用的云端音色。
  ctx.effect(() => {
    let disposed = false;
    const run = async () => {
      try { await ctx.root?.loader?.await?.(); } catch { /* 精简宿主 */ }
      if (disposed) return;
      const cfg = readConfig();
      const descriptor = getProviderDescriptor(cfg.provider);
      if (!descriptor) return;
      const raw = storedProvider(config?.provider);
      const migrate = typeof raw !== 'string' || !providerIds().includes(raw as ProviderKind);
      const provider = migrate ? resolveProvider(raw, cfg.voices) : cfg.provider;
      const invalid = descriptor.capabilities.voiceSource !== 'presets' && Boolean(cfg.defaultVoice)
        && !isValidVoiceId(provider, cfg.defaultVoice);
      if (!migrate && !invalid) return;
      try {
        const patch = selectVoice(cfg, provider, invalid ? defaultVoiceFor(provider) : undefined);
        await ctx.settings.update(entryId, { ...patch, ...(migrate ? { schemaVersion: SCHEMA_VERSION } : {}) });
      } catch {
        // 只读部署或设置服务未就绪：运行时仍由对应 Provider 回退
      }
    };
    void run();
    return () => { disposed = true; };
  }, 'gsv-tts: migrate voice settings');

  // 音色注册表核心（工具与 HTTP 路由共享）：写回走 settings.update → volatile 配置就地热更新
  const voiceRegistry = new VoiceRegistryManager({
    getConfig: () => readConfig(),
    writeConfig: async (patch) => {
      await ctx.settings.update(entryId, patch);
    },
  });

  registerPlaybackRoutes(ctx, {
    config: readConfig, tts, audio: audioStore, engine: engineManager, registry: voiceRegistry, stats,
    previewText: PREVIEW_TEXT, prewarm: prewarmDefaultVoice,
    writeVoiceSelection: patch => ctx.settings.update(entryId, patch),
  });

  // ─── 工具 1: tts_speak ─── 将文本转换为语音 ───
  const speakTool = defineTool({
    name: 'tts_speak',
    description: '将文本转换为语音并返回可播放的音频 URL。可通过 voice 参数选择不同音色。',
    parameters: {
      text: { type: 'string', description: '要朗读的文本', required: true },
      voice: { type: 'string', description: '音色名称（不填则使用默认音色）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          audioUrl: { type: 'string' },
          audioLen: { type: 'number' },
          voiceUsed: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args: unknown, value: { audioUrl: string; audioLen: number; voiceUsed: string }) {
        return [
          {
            type: 'text',
            text: `[▶ 播放语音](${value.audioUrl})（音色: ${value.voiceUsed}，时长 ${value.audioLen.toFixed(2)}s）`,
          },
        ];
      },
    },
    timeoutMs: readConfig().timeout,
    async execute(args: { text: string; voice?: string }, exec: { signal: AbortSignal }) {
      try {
        const cfg = readConfig();
        if (cfg.provider !== 'gsv') {
          // 云端模式（edge / deepseek）：voice 参数即云端音色 id（不填用 defaultVoice）
          const r = await tts.synthesize(args.text, args.voice, exec.signal);
          const fallback = defaultVoiceFor(cfg.provider) || 'edge-default';
          return { audioUrl: r.audioUrl, audioLen: r.audioLen, voiceUsed: args.voice || cfg.defaultVoice || fallback };
        }
        const preset = voiceManager.get(args.voice);
        if (!preset) {
          const available = voiceManager.list().map((v) => v.name).join(', ');
          throw new Error(`未找到音色 "${args.voice}"。可用音色: ${available || '（无）'}`);
        }
        const r = await tts.synthesize(args.text, preset, exec.signal);
        return { audioUrl: r.audioUrl, audioLen: r.audioLen, voiceUsed: preset.name };
      } catch (e) {
        noteFailure(e);
        throw e;
      }
    },
  });

  // ─── 工具 2: tts_list_voices ─── 列出当前 provider 可用音色 ───
  const listVoicesTool = defineTool({
    name: 'tts_list_voices',
    description: '列出当前 TTS 模式下的可用音色：本地克隆（gsv）= 预设列表；Edge 云端（edge）= 微软精选声音；官方语音（deepseek）= 海星/暗潮。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          voices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                speakerAudioPath: { type: 'string' },
                isDefault: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
          defaultVoice: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args: unknown, value: { provider: string; voices: Array<{ name: string; speakerAudioPath: string; isDefault: boolean }> }) {
        const descriptor = getProviderDescriptor(value.provider);
        const mode = descriptor ? descriptor.label : value.provider;
        const lines = value.voices.map((v) =>
          `- **${v.name}**${v.isDefault ? '（默认）' : ''}: ${v.speakerAudioPath}`
        );
        return [{ type: 'text', text: `可用音色（${mode}）：\n${lines.join('\n') || '（无）'}` }];
      },
    },
    async execute() {
      const cfg = readConfig();
      const provider: ProviderKind = cfg.provider;
      const descriptor = getProviderDescriptor(provider);
      if (descriptor && descriptor.capabilities.voiceSource !== 'presets') {
        const voices = (await tts.listVoices(provider)).map((v) => ({
          name: v.name,
          speakerAudioPath: `${provider}://${v.id}`,
          isDefault: v.id === cfg.defaultVoice,
        }));
        return { provider, voices, defaultVoice: cfg.defaultVoice || '' };
      }
      const voices = voiceManager.list().map((v) => ({
        name: v.name,
        speakerAudioPath: v.speakerAudioPath,
        isDefault: v.name === voiceManager.defaultName,
      }));
      return { provider, voices, defaultVoice: voiceManager.defaultName };
    },
  });

  // ─── 工具 3: tts_health_check ─── 检查 GSV-TTS-Lite 引擎状态 ───
  const healthCheckTool = defineTool({
    name: 'tts_health_check',
    description: '检查 GSV-TTS-Lite 引擎的安装和运行状态（API、Python、pip 包、仓库）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          apiRunning: { type: 'boolean' },
          pythonInstalled: { type: 'boolean' },
          pythonVersion: { type: 'string' },
          pipPackageInstalled: { type: 'boolean' },
          repoCloned: { type: 'boolean' },
          repoPath: { type: 'string' },
          apiUrl: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args: unknown, value: HealthCheckResult) {
        const status = (ok: boolean, label: string, detail: string) =>
          `${ok ? '✅' : '❌'} ${label}: ${detail}`;
        return [
          {
            type: 'text',
            text: [
              `GSV-TTS-Lite 引擎状态：`,
              status(value.apiRunning, 'API 服务', value.apiRunning ? `运行中 (${value.apiUrl})` : '未运行'),
              status(value.pythonInstalled, 'Python', value.pythonVersion || '未安装'),
              status(value.pipPackageInstalled, 'gsv-tts-lite', value.pipPackageInstalled ? '已安装' : '未安装'),
              status(value.repoCloned, '仓库', value.repoCloned ? value.repoPath : '未克隆'),
            ].join('\n'),
          },
        ];
      },
    },
    async execute() {
      return await setup.healthCheck();
    },
  });

  // ─── 工具 4: tts_setup_engine ─── 辅助下载安装 GSV-TTS-Lite ───
  const setupEngineTool = defineTool({
    name: 'tts_setup_engine',
    description: '经用户确认后，在隔离 Python 环境中安装固定版本的 GSV-TTS-Lite 引擎并启动本机 API 服务。',
    timeoutMs: 1_200_000,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          apiUrl: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string' },
                status: { type: 'string' },
                message: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render(_args: unknown, value: SetupResult) {
        const icon = value.success ? '✅' : '⚠️';
        const steps = value.steps.map((s) => {
          const st = s.status === 'success' ? '✅' : s.status === 'failed' ? '❌' : '⏭️';
          return `${st} ${s.step}: ${s.message}`;
        });
        return [
          {
            type: 'text',
            text: `${icon} ${value.message}\n\n${steps.join('\n')}`,
          },
        ];
      },
    },
    async execute(_args, exec) {
      const cfg = readConfig();
      const approver = ctx.get?.('approval');
      if (!exec.agent || typeof approver?.request !== 'function') throw new Error('当前宿主无法确认本地引擎安装，请由用户手动安装。');
      const directory = enginePaths(cfg.installDir).root;
      const result = await approver.request({
        agent: exec.agent, toolName: 'tts_setup_engine', callId: exec.callId, signal: exec.signal,
        reason: `将在 ${directory} 下载固定版本的引擎，创建独立 Python 环境、安装依赖并启动仅本机可访问的服务。`,
      });
      exec.signal.throwIfAborted();
      if (result !== 'allowed-once') throw new Error('用户未授权安装本地语音引擎。');
      return setup.setup(cfg, exec.signal);
    },
  });

  // ─── 工具 5: tts_voice_registry ─── 列出音色市场可安装音色 ───
  const voiceRegistryTool = defineTool({
    name: 'tts_voice_registry',
    description: '列出音色市场（注册表）中的可安装音色。可传 registryUrl 覆盖默认清单源。',
    parameters: {
      registryUrl: { type: 'string', description: '清单地址（默认使用配置或包内离线清单）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          trusted: { type: 'boolean' },
          version: { type: 'string' },
          voices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                author: { type: 'string' },
                license: { type: 'string' },
                installed: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render(_args: unknown, value: { source: string; trusted: boolean; version: string; voices: Array<{ id: string; name: string; author?: string; license: string; installed: boolean }> }) {
        const trust = value.source === 'bundled' && value.trusted ? '（官方可信，安装免确认）' : '（第三方来源，安装需确认）';
        const lines = value.voices.map((v) =>
          `- **${v.name}** (\`${v.id}\`)${v.installed ? ' ✅ 已安装' : ''}\n  · 作者: ${v.author ?? '未知'} · license: ${v.license}`
        );
        return [
          { type: 'text', text: `音色市场（来源: ${value.source}${trust}，清单版本 ${value.version}）：\n${lines.join('\n')}` },
        ];
      },
    },
    async execute(args: { registryUrl?: string }) {
      return await voiceRegistry.list(args.registryUrl);
    },
  });

  // ─── 工具 6: tts_voice_install ─── 安装市场音色（两阶段确认） ───
  const voiceInstallTool = defineTool({
    name: 'tts_voice_install',
    description: '安装音色市场中的音色。第三方来源首次调用返回 needsConfirm，需要用户确认后带 confirm=true 再次调用。',
    parameters: {
      id: { type: 'string', description: '市场清单中的音色 id', required: true },
      confirm: { type: 'boolean', description: '第二阶段确认标记（第三方来源必填 true）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          needsConfirm: { type: 'boolean' },
          message: { type: 'string' },
          voice: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              id: { type: 'string' },
              source: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render(_args: unknown, value: { ok: boolean; needsConfirm?: boolean; message: string; voice?: { name: string; id: string; source: string } }) {
        const icon = value.ok ? '✅' : value.needsConfirm ? '⚠️ 需确认' : '❌';
        const text = value.needsConfirm
          ? `${icon} ${value.message}\n请向用户确认来源/作者/许可后，以 confirm=true 再次调用 tts_voice_install。`
          : `${icon} ${value.message}${value.voice ? `（${value.voice.name}, id=${value.voice.id}, ${value.voice.source}）` : ''}`;
        return [{ type: 'text', text }];
      },
    },
    async execute(args: { id: string; confirm?: boolean }) {
      return await voiceRegistry.install(args.id, args.confirm === true);
    },
  });

  // ─── 工具 7: tts_voice_remove ─── 卸载注册表安装的音色 ───
  const voiceRemoveTool = defineTool({
    name: 'tts_voice_remove',
    description: '卸载注册表安装的音色（仅限 source=registry 的音色）。deleteFiles 默认 true 同时删除本地音频文件。',
    parameters: {
      id: { type: 'string', description: '要卸载的音色 id', required: true },
      deleteFiles: { type: 'boolean', description: '是否同时删除本地音频文件（默认 true）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args: unknown, value: { ok: boolean; message: string }) {
        return [{ type: 'text', text: `${value.ok ? '✅' : '❌'} ${value.message}` }];
      },
    },
    async execute(args: { id: string; deleteFiles?: boolean }) {
      return await voiceRegistry.remove(args.id, args.deleteFiles !== false);
    },
  });

  // ─── 工具: tts_lexicon_preview ─── 只做替换预览，不合成 ───
  const lexiconPreviewTool = defineTool({
    name: 'tts_lexicon_preview',
    description: '预览发音词典会把一段文本读成什么（只做文本替换，不合成、不产生费用）。用于确认多音字/缩写修正是否命中。',
    parameters: {
      text: { type: 'string', description: '要预览的文本', required: true },
      provider: { type: 'string', description: '按哪个模式的词典作用域预览（gsv/edge/deepseek；默认当前模式）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          before: { type: 'string' },
          after: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                scope: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render(_args: unknown, value: { provider: string; before: string; after: string; hits: Array<{ from: string; to: string; scope: string }> }) {
        const lines = [
          `发音词典预览（${value.provider}）`,
          `原文：${value.before}`,
          `朗读：${value.after}`,
        ];
        if (value.hits.length === 0) lines.push('命中：无（检查拼写或作用域）');
        else lines.push('命中：', ...value.hits.map((h) => `- [${h.scope}] ${h.from} → ${h.to}`));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: { text: string; provider?: string }) {
      const cfg = readConfig();
      const requested = typeof args.provider === 'string' ? args.provider : cfg.provider;
      const provider = getProviderDescriptor(requested) ? (requested as ProviderKind) : cfg.provider;
      const result = previewLexicon(args.text, parseLexicon(cfg.lexicon), provider);
      return { provider, before: result.before, after: result.after, hits: result.hits };
    },
  });

  // ─── 工具: tts_doctor ─── 解释「为什么没声音」 ───
  const doctorTool = defineTool({
    name: 'tts_doctor',
    description:
      '诊断语音链路：当前模式、凭据来源、引擎/模型/前置条件、最近一次失败，并给出修复建议（不返回密钥）。' +
      '传 deep=true 会额外调用免费 GET /models 验证凭据，不产生合成费用。',
    parameters: {
      deep: { type: 'boolean', description: '深度探活：调用免费 GET /models 验证凭据（不产生合成费用）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          mode: { type: 'string' },
          verdict: { type: 'string' },
          credentialConfigured: { type: 'boolean' },
          credentialSource: { type: 'string' },
          probeChecked: { type: 'boolean' },
          probeOk: { type: 'boolean' },
          probeMessage: { type: 'string' },
          engineApplicable: { type: 'boolean' },
          engineRunning: { type: 'boolean' },
          engineInstalled: { type: 'boolean' },
          missingModels: { type: 'array', items: { type: 'string' } },
          pythonInstalled: { type: 'boolean' },
          pythonVersion: { type: 'string' },
          pipPackageInstalled: { type: 'boolean' },
          repoCloned: { type: 'boolean' },
          engineLog: { type: 'array', items: { type: 'string' } },
          audioFiles: { type: 'number' },
          lexiconRules: { type: 'number' },
          lastFailure: { type: 'string' },
          hints: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      render(
        _args: unknown,
        v: {
          mode: string;
          verdict: string;
          credentialConfigured: boolean;
          credentialSource: string;
          probeChecked: boolean;
          probeOk: boolean;
          probeMessage: string;
          engineApplicable: boolean;
          engineRunning: boolean;
          engineInstalled: boolean;
          missingModels: string[];
          pythonInstalled: boolean;
          pythonVersion: string;
          pipPackageInstalled: boolean;
          repoCloned: boolean;
          engineLog: string[];
          audioFiles: number;
          lexiconRules: number;
          lastFailure: string;
          hints: string[];
        },
      ) {
        const icon = v.verdict === 'ok' ? '✅' : v.verdict === 'degraded' ? '⚠️' : '❌';
        const lines = [`${icon} 语音诊断：${v.mode} · ${v.verdict}`];
        lines.push(
          v.credentialConfigured
            ? `• 凭据：已配置（${v.credentialSource}）`
            : `• 凭据：未配置`,
        );
        if (v.probeChecked) {
          lines.push(v.probeOk ? '• 探活：通过（GET /models）' : `• 探活：失败 — ${v.probeMessage || '未知原因'}`);
        }
        if (v.engineApplicable) {
          lines.push(`• 引擎：${v.engineInstalled ? (v.engineRunning ? '运行中' : '已安装未运行') : '未安装'}`);
          if (v.missingModels.length) lines.push(`• 缺失模型：${v.missingModels.join('、')}`);
          if (!v.engineRunning) {
            lines.push(
              `• 前置条件：Python ${v.pythonInstalled ? (v.pythonVersion || '已安装') : '未安装'} · ` +
                `gsv-tts-lite ${v.pipPackageInstalled ? '已安装' : '未安装'} · 仓库 ${v.repoCloned ? '已克隆' : '未克隆'}`,
            );
          }
        }
        lines.push(`• 音频缓存：${v.audioFiles} 个文件 · 发音词典：${v.lexiconRules} 条规则`);
        if (v.lastFailure) lines.push(`• 最近失败：${v.lastFailure}`);
        if (v.engineLog.length) {
          lines.push('', '引擎日志（末尾）：', ...v.engineLog.slice(-5).map((l) => `  ${l}`));
        }
        if (v.hints.length) lines.push('', '建议：', ...v.hints.map((h) => `- ${h}`));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args: { deep?: boolean }) {
      const cfg = readConfig();
      const descriptor = getProviderDescriptor(cfg.provider);
      const credential = await tts.describeCredential(cfg.provider);
      const needsEngine = descriptor?.capabilities.needsEngine ?? false;
      const needsKey = descriptor?.capabilities.needsKey ?? false;

      let probe: { checked: boolean; ok: boolean; message?: string } | undefined;
      if (args.deep && needsKey) {
        const result = await tts.checkCredential(cfg.provider);
        probe = { checked: true, ok: result.ok, message: result.message };
      }

      let engine: EngineFacts | undefined;
      let setupFacts: SetupFacts | undefined;
      let engineLog: string[] = [];
      if (needsEngine) {
        const status = await engineManager.status(cfg);
        const paths = enginePaths(cfg.installDir);
        engine = {
          running: status.running,
          apiUrl: cfg.apiUrl,
          startScriptExists: existsSync(paths.python) && existsSync(join(paths.source, 'pyproject.toml')),
          models: GSV_ENGINE.models.map(m => ({ ...m, present: existsSync(join(paths.models, m.file)) })),
        };
        try {
          const h = await setup.healthCheck();
          setupFacts = {
            pythonInstalled: h.pythonInstalled,
            pythonVersion: h.pythonVersion,
            pipPackageInstalled: h.pipPackageInstalled,
            repoCloned: h.repoCloned,
          };
        } catch {
          // 健康检查失败不影响其余诊断
        }
        try {
          const log = readFileSync(paths.log, 'utf8');
          engineLog = log
            .trimEnd()
            .split(/\r?\n/)
            .slice(-12)
            .map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 300));
        } catch {
          engineLog = [];
        }
      }

      const report = buildDoctorReport({
        provider: cfg.provider,
        descriptor,
        credential,
        engine,
        probe,
        setup: setupFacts,
        engineLog,
        audio: audioStore.stats(),
        lexiconRules: entriesForProvider(parseLexicon(cfg.lexicon), cfg.provider).length,
        lastFailure,
      });
      return {
        provider: report.provider,
        mode: report.mode,
        verdict: report.verdict,
        credentialConfigured: credential.configured,
        credentialSource: describeCredentialSource(credential.source),
        probeChecked: report.probe?.checked ?? false,
        probeOk: report.probe?.ok ?? false,
        probeMessage: report.probe?.message ?? '',
        engineApplicable: needsEngine,
        engineRunning: report.engine?.running ?? false,
        engineInstalled: report.engine?.startScriptExists ?? false,
        missingModels: (report.engine?.models ?? []).filter((m) => m.required && !m.present).map((m) => m.file),
        pythonInstalled: report.setup?.pythonInstalled ?? false,
        pythonVersion: report.setup?.pythonVersion ?? '',
        pipPackageInstalled: report.setup?.pipPackageInstalled ?? false,
        repoCloned: report.setup?.repoCloned ?? false,
        engineLog: report.engineLog,
        audioFiles: report.audio.fileCount,
        lexiconRules: report.lexiconRules,
        lastFailure: report.lastFailure
          ? `${report.lastFailure.agoSeconds} 秒前：${report.lastFailure.message}`
          : '',
        hints: report.hints,
      };
    },
  });

  // ─── 注册所有工具 ───
  ctx.tools.register(speakTool);
  ctx.tools.register(listVoicesTool);
  ctx.tools.register(healthCheckTool);
  ctx.tools.register(doctorTool);
  ctx.tools.register(lexiconPreviewTool);
  ctx.tools.register(setupEngineTool);
  ctx.tools.register(voiceRegistryTool);
  ctx.tools.register(voiceInstallTool);
  ctx.tools.register(voiceRemoveTool);
}
