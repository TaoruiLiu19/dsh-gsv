import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TTSService } from './tts.service.js';
import { VoiceManager } from './voice-manager.js';
import { EngineSetup } from './setup.js';
import { AudioStore } from './audio-store.js';
import { EngineManager } from './engine-manager.js';
import { TextCleaner, MAX_SEGMENTED_TEXT_LENGTH } from './text-cleaner.js';
import { VoiceRegistryManager } from './voice-registry.js';
import { resolveProvider } from './migration.js';
import type { Config as PluginConfig, HealthCheckResult, ProviderKind, SetupResult, VoicePreset } from './types.js';

export const name = 'dsh-gsv-tts';
export const inject = ['tools', 'webServer', 'settings'];

/** 音色试听固定文案：含长短句、数字与语气词，便于靠耳朵对比音色。 */
const PREVIEW_TEXT = '这是一段音色试听：你好，欢迎使用本地语音引擎。今天的天气很好，我们出发去爬山吧，一二三四五！';

/** 当前配置结构版本（迁移守卫落点）。 */
const SCHEMA_VERSION = 1;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Config: any = Schema.object({
  apiUrl: Schema.string().default('http://localhost:9880').description('GSV-TTS-Lite API 服务地址'),
  voices: Schema.array(Schema.object({
    name: Schema.string().description('音色名称'),
    speakerAudioPath: Schema.string().description('目标音色参考音频路径').role('path'),
    promptAudioPath: Schema.string().description('提示音频路径（声音克隆必需）').role('path'),
    promptText: Schema.string().description('提示文本（对应提示音频的文字，留空时若引擎支持 ASR 会自动转写，否则合成报错）').default(''),
    id: Schema.string().description('注册表来源 id（注册表安装音色用）').default(''),
    source: Schema.string().description('音色来源：user 自定义 / registry 注册表安装').default('user'),
  })).default([]).description('音色预设列表，可在设置中自定义'),
  defaultVoice: Schema.string().description('默认音色（gsv=预设名 / edge=云端音色 id，留空用第一个）').default(''),
  autoPlay: Schema.boolean().default(false).description('是否自动朗读助手回复'),
  interruptOnNew: Schema.boolean().default(true).description('自动朗读时，新回复是否打断当前朗读（关闭则朗读中跳过新回复，避免叠音）'),
  timeout: Schema.number().default(30000).description('请求超时时间（毫秒）'),
  installDir: Schema.string().default('./GSV-TTS-Lite').description('GSV-TTS-Lite 引擎安装目录'),
  voiceRegistryUrl: Schema.string().default('').description('音色市场远端清单地址（留空使用包内离线清单）'),
  schemaVersion: Schema.number().default(SCHEMA_VERSION).description('配置结构版本'),
  provider: Schema.union([Schema.const('gsv'), Schema.const('edge')]).description('TTS 引擎：gsv 本地专业 / edge 云端简单模式（初始化分派，勿手动改）'),
  quotaDaily: Schema.union([Schema.number().min(0), Schema.const(null)]).default(null).description('云端简单模式每日配额（null=不限量，仅引导用）'),
});

export function apply(ctx: any, config: PluginConfig) {
  // 可热更新的运行态：设置面板（settings 命名空间）修改后重建
  let current: PluginConfig = config;
  let voiceManager = new VoiceManager(current);
  let audioStore = new AudioStore(`http://${ctx.webServer.host}:${ctx.webServer.port}`);
  let tts = new TTSService(current, audioStore, { voiceManager });
  let setup = new EngineSetup(current.apiUrl, current.installDir);
  // 引擎进程管理：单实例跨配置热更新存活（避免 reconfigure 丢失子进程引用）
  const engineManager = new EngineManager();

  // 自动朗读通知状态：服务端只在有新回复时递增 seq 并暂存清洗后的文本，
  // 由前端轮询 /autoplay/poll 感知并按需触发合成播放（打断策略在前端执行）。
  const autoPlay = { seq: 0, text: null as string | null };

  const reconfigure = (next: PluginConfig) => {
    current = next;
    voiceManager = new VoiceManager(next);
    tts = new TTSService(next, audioStore, { voiceManager });
    setup = new EngineSetup(next.apiUrl, next.installDir);
    engineManager.configure(next.apiUrl, next.installDir);
  };

  // 设置面板命名空间：base = cordis 配置，settings.yaml 用户层覆盖，变更热生效
  let settingsScope: any = null;
  try {
    settingsScope = ctx.settings.register('dsh-gsv-tts', Config, { base: config });
    // 4.0.0 迁移守卫：读原始 user 层（describe() 的 user 字段）判定初始 provider，
    // 老用户保持 gsv、全新安装用 edge；并写回一次使客户端可见。
    let userLayer: Record<string, unknown> | undefined;
    try {
      const desc = ctx.settings.describe?.();
      userLayer = (Array.isArray(desc) ? desc.find((d: any) => d.ns === 'dsh-gsv-tts') : undefined)?.user;
    } catch {
      userLayer = undefined;
    }
    const provider = resolveProvider(userLayer);
    reconfigure({ ...settingsScope.get(), provider });
    if (userLayer !== undefined && userLayer.provider === undefined) {
      // 老用户/全新：落定 provider，保证设置面板与运行态一致（幂等）
      settingsScope.update({ provider, schemaVersion: SCHEMA_VERSION }).catch((e: unknown) => {
        ctx.logger?.warn?.('dsh-gsv-tts 迁移写回失败', e);
      });
    }
    settingsScope.watch(() => {
      try {
        reconfigure(settingsScope.get());
        ctx.logger?.info?.('dsh-gsv-tts 设置已热更新');
      } catch (e) {
        ctx.logger?.warn?.('dsh-gsv-tts 设置应用失败', e);
      }
    });
  } catch (e) {
    ctx.logger?.warn?.('dsh-gsv-tts 设置命名空间注册失败', e);
  }

  // 音色注册表核心（工具与 HTTP 路由共享）：写回走 settingsScope.update → watch 热更新
  const voiceRegistry = new VoiceRegistryManager({
    getConfig: () => current,
    writeConfig: async (patch) => {
      if (!settingsScope) throw new Error('设置服务未就绪，无法写入音色配置');
      await settingsScope.update(patch);
    },
  });

  /** 当前 provider 的默认音色：edge → defaultVoice 或空串（服务端回落第一个）；gsv → 本地预设或 null。 */
  const resolveVoice = (): VoicePreset | string | null => {
    if ((current.provider ?? 'gsv') === 'edge') return current.defaultVoice || '';
    const preset = voiceManager.get();
    return preset ?? null;
  };

  /** 合成失败分支：gsv 时优先给出"引擎未启动"明确原因；edge 时原样返回云端错误。 */
  const failSynthesis = async (res: any, e: unknown): Promise<void> => {
    const msg = String((e as Error)?.message ?? e);
    if ((current.provider ?? 'gsv') === 'gsv') {
      const engine = await engineManager.status();
      if (!engine.running) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: '语音引擎未启动，请到 设置 → 引擎 打开开关' }));
        return;
      }
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: msg }));
  };

  // 注册音频文件路由（同源，浏览器可直接播放；插件卸载时自动注销）
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-gsv-tts/audio',
    handler: (req: any, res: any) => audioStore.serve(req, res),
  }));

  // 引擎启停（设置 → 引擎 开关调用）
  const json = (res: any, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/engine/status',
    handler: async (_req: any, res: any) => {
      try {
        json(res, 200, await engineManager.status());
      } catch (e: any) {
        json(res, 500, { message: String(e?.message ?? e) });
      }
    },
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/engine/start',
    handler: async (_req: any, res: any) => {
      try {
        json(res, 200, await engineManager.start());
      } catch (e: any) {
        json(res, 500, { message: String(e?.message ?? e) });
      }
    },
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/engine/stop',
    handler: async (_req: any, res: any) => {
      try {
        json(res, 200, await engineManager.stop());
      } catch (e: any) {
        json(res, 500, { message: String(e?.message ?? e) });
      }
    },
  }));

  // ─── Provider 信息（4.0.0 简单模式） ───
  // 当前 provider 的音色列表（客户端下拉数据源）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/provider/voices',
    handler: async (_req: any, res: any) => {
      try {
        const provider: ProviderKind = current.provider ?? 'gsv';
        json(res, 200, { provider, voices: await tts.listVoices(provider) });
      } catch (e: any) {
        json(res, 500, { message: String(e?.message ?? e) });
      }
    },
  }));
  // 当前 provider 的健康（edge = 试合成退避；gsv = 引擎状态）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/provider/health',
    handler: async (_req: any, res: any) => {
      try {
        const provider: ProviderKind = current.provider ?? 'gsv';
        json(res, 200, { provider, ...(await tts.health(provider)) });
      } catch (e: any) {
        json(res, 500, { message: String(e?.message ?? e) });
      }
    },
  }));
  // 云端（Edge）音色试听：voice = 云端音色 id，强制走 edge 提供方
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/provider/preview',
    handler: async (req: any, res: any) => {
      try {
        const { voice } = await readJson(req);
        if (typeof voice !== 'string' || !voice) {
          json(res, 400, { message: '缺少云端音色 id' });
          return;
        }
        const r = await tts.synthesize(PREVIEW_TEXT, voice, undefined, 'edge');
        json(res, 200, { audioUrl: r.audioUrl, audioLen: r.audioLen, voiceUsed: voice });
      } catch (e: any) {
        json(res, 500, { message: String(e?.message ?? e) });
      }
    },
  }));

  // 自动朗读轮询：前端带着上次看到的 seq 来，服务端返回当前 seq 与新文本
  // （text 仅在 seq 前进时有意义；无新回复时返回当前 seq，前端据此判断无变化）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/autoplay/poll',
    handler: async (req: any, res: any) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const { sinceSeq } = JSON.parse(raw || '{}');
        json(res, 200, {
          seq: autoPlay.seq,
          text: typeof sinceSeq === 'number' && autoPlay.seq > sinceSeq ? autoPlay.text : null,
        });
      } catch {
        json(res, 200, { seq: autoPlay.seq, text: null });
      }
    },
  }));

  // 自动朗读合成：按 seq 取暂存文本，分段合成后返回与 /speak 相同的队列结构。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/autoplay/speak',
    handler: async (req: any, res: any) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const { seq } = JSON.parse(raw || '{}');
        if (seq !== autoPlay.seq || !autoPlay.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '没有可朗读的新回复' }));
          return;
        }
        const voice = resolveVoice();
        if (voice === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '未配置音色' }));
          return;
        }
        try {
          const r = await tts.synthesizeSegments(autoPlay.text, voice);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            segments: r.segments,
            audioUrl: r.segments[0]?.url ?? null,
            audioLen: r.totalLen,
            voiceUsed: typeof voice === 'string' ? voice : voice.name,
            error: r.error,
          }));
        } catch (e: any) {
          await failSynthesis(res, e);
        }
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: String(e?.message ?? e) }));
      }
    },
  }));

  // 音色试听：接收草稿音色完整参数（不查已保存配置——未保存的音色也能直接试听），
  // 用固定文案单次合成，返回音频 URL。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/preview',
    handler: async (req: any, res: any) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || '{}');
        const v: Record<string, unknown> = body.voice ?? {};
        const name = String(v.name ?? '试听音色');
        const speakerAudioPath = String(v.speakerAudioPath ?? '');
        const promptAudioPath = String(v.promptAudioPath ?? '');
        if (!speakerAudioPath || !promptAudioPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '试听需要填写 参考音频路径 与 提示音频路径' }));
          return;
        }
        try {
          // 试听是 GSV 克隆素材专用，强制走 gsv 提供方（edge 模式客户端会隐藏市场）
          const r = await tts.synthesize(
            PREVIEW_TEXT,
            {
              name,
              speakerAudioPath,
              promptAudioPath,
              promptText: String(v.promptText ?? ''),
            },
            undefined,
            'gsv',
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ audioUrl: r.audioUrl, audioLen: r.audioLen, voiceUsed: name }));
        } catch (e: any) {
          // 引擎未启动是最常见失败：给出明确原因
          const engine = await engineManager.status();
          if (!engine.running) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: '语音引擎未启动，请到上方打开引擎开关' }));
            return;
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: String(e?.message ?? e) }));
        }
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: String(e?.message ?? e) }));
      }
    },
  }));

  // ─── 音色市场（双通道的 HTTP 侧，与 tts_voice_* 工具共享 voiceRegistry 核心） ───
  const readJson = async (req: any): Promise<Record<string, unknown>> => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/registry/list',
    handler: async (req: any, res: any) => {
      try {
        const { registryUrl } = await readJson(req);
        json(res, 200, await voiceRegistry.list(typeof registryUrl === 'string' ? registryUrl : undefined));
      } catch (e: any) {
        json(res, 200, { ok: false, message: String(e?.message ?? e) });
      }
    },
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/registry/install',
    handler: async (req: any, res: any) => {
      try {
        const { id, confirm } = await readJson(req);
        if (typeof id !== 'string' || !id) {
          json(res, 400, { ok: false, message: '缺少 id' });
          return;
        }
        json(res, 200, await voiceRegistry.install(id, confirm === true));
      } catch (e: any) {
        json(res, 200, { ok: false, message: String(e?.message ?? e) });
      }
    },
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/registry/remove',
    handler: async (req: any, res: any) => {
      try {
        const { id, deleteFiles } = await readJson(req);
        if (typeof id !== 'string' || !id) {
          json(res, 400, { ok: false, message: '缺少 id' });
          return;
        }
        json(res, 200, await voiceRegistry.remove(id, deleteFiles !== false));
      } catch (e: any) {
        json(res, 200, { ok: false, message: String(e?.message ?? e) });
      }
    },
  }));

  // 朗读按钮调用：按 sessionId+messageId 取助手消息文本（不含思考），合成并返回音频 URL
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/speak',
    handler: async (req: any, res: any) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const { sessionId, messageId } = JSON.parse(raw || '{}');
        if (!sessionId || !messageId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '缺少 sessionId/messageId' }));
          return;
        }
        const sessions = ctx.get('sessions');
        const session = sessions?.get(sessionId);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '会话不存在' }));
          return;
        }
        const events = session.events ?? session.eventsSnapshot ?? session.log ?? [];
        let content: Array<{ type?: string; text?: string }> = [];
        for (const ev of events) {
          if (ev.type === 'assistant/message' && ev.data?.message?.id === messageId) {
            content = ev.data.message.content ?? [];
            break;
          }
        }
        if (content.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '未找到消息' }));
          return;
        }
        // 只取文本块（type === 'text'），排除思考/工具调用等；空文本判断用清洗后文本，
        // 与合成口径一致——只有代码块/链接/表格的回复应给友好提示，而不是 404
        const rawText = content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        const text = TextCleaner.clean(rawText);
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '该消息没有可朗读的文本（可能只包含代码/链接/表格等）' }));
          return;
        }
        if (text.length > MAX_SEGMENTED_TEXT_LENGTH) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: `文本过长（${text.length} 字符），请分段朗读` }));
          return;
        }
        const voice = resolveVoice();
        if (voice === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '未配置音色' }));
          return;
        }
        try {
          // 渐进分段合成：按句切分逐段落地，返回可顺序播放的 URL 队列
          const r = await tts.synthesizeSegments(text, voice);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            segments: r.segments,
            audioUrl: r.segments[0]?.url ?? null,
            audioLen: r.totalLen,
            voiceUsed: typeof voice === 'string' ? voice : voice.name,
            error: r.error,
          }));
        } catch (e: any) {
          await failSynthesis(res, e);
        }
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: String(e?.message ?? e) }));
      }
    },
  }));

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
    timeoutMs: config.timeout,
    async execute(args: { text: string; voice?: string }, exec: { signal: AbortSignal }) {
      if ((current.provider ?? 'gsv') === 'edge') {
        // 云端简单模式：voice 参数即 Edge 音色 id（不填用 defaultVoice/第一个）
        const r = await tts.synthesize(args.text, args.voice, exec.signal);
        return { audioUrl: r.audioUrl, audioLen: r.audioLen, voiceUsed: args.voice || current.defaultVoice || 'edge-default' };
      }
      const preset = voiceManager.get(args.voice);
      if (!preset) {
        const available = voiceManager.list().map((v) => v.name).join(', ');
        throw new Error(`未找到音色 "${args.voice}"。可用音色: ${available || '（无）'}`);
      }
      const r = await tts.synthesize(args.text, preset, exec.signal);
      return { audioUrl: r.audioUrl, audioLen: r.audioLen, voiceUsed: preset.name };
    },
  });

  // ─── 工具 2: tts_list_voices ─── 列出当前 provider 可用音色 ───
  const listVoicesTool = defineTool({
    name: 'tts_list_voices',
    description: '列出当前 TTS 模式下的可用音色：本地专业（gsv）= 预设列表；云端简单（edge）= 微软精选声音。',
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
        const mode = value.provider === 'edge' ? '云端简单模式' : '本地专业模式';
        const lines = value.voices.map((v) =>
          `- **${v.name}**${v.isDefault ? '（默认）' : ''}: ${v.speakerAudioPath}`
        );
        return [{ type: 'text', text: `可用音色（${mode}）：\n${lines.join('\n') || '（无）'}` }];
      },
    },
    async execute() {
      const provider: ProviderKind = current.provider ?? 'gsv';
      if (provider === 'edge') {
        const voices = (await tts.listVoices('edge')).map((v) => ({
          name: v.name,
          speakerAudioPath: `edge://${v.id}`,
          isDefault: v.id === current.defaultVoice,
        }));
        return { provider, voices, defaultVoice: current.defaultVoice || '' };
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
    description: '辅助安装 GSV-TTS-Lite 引擎：检测环境、安装 pip 包、克隆仓库、启动 API 服务。安装完成后请再次执行 tts_health_check 验证。',
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
    async execute() {
      return await setup.setup();
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

  // ─── 注册所有工具 ───
  ctx.tools.register(speakTool);
  ctx.tools.register(listVoicesTool);
  ctx.tools.register(healthCheckTool);
  ctx.tools.register(setupEngineTool);
  ctx.tools.register(voiceRegistryTool);
  ctx.tools.register(voiceInstallTool);
  ctx.tools.register(voiceRemoveTool);

  // ─── 自动朗读：监听 session/event（常驻监听，是否朗读由运行时配置决定，支持设置热切换） ───
  // 服务端只做"新回复通知"（递增 seq 并暂存清洗后文本），由前端轮询触发合成与播放，
  // 打断/防重叠（barge-in）在前端播放层执行，受 interruptOnNew 开关控制。
  ctx.on('session/event', (session: unknown, event: { type: string; data: { message: { id?: string; content: Array<{ type: string; text?: string }> } } }) => {
    if (!current.autoPlay) return;
    if (event.type !== 'assistant/message') return;
    const messageId = event.data.message?.id;
    if (!messageId) return;
    const rawText = (event.data.message.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');
    const text = TextCleaner.clean(rawText);
    if (!text || text.length > MAX_SEGMENTED_TEXT_LENGTH) return;
    if (text === autoPlay.text) return; // 同一内容重复事件不重复通知
    autoPlay.seq += 1;
    autoPlay.text = text;
    ctx.logger?.info?.('dsh-gsv-tts 自动朗读: 新回复已就绪 (seq=%d)', autoPlay.seq);
  });
}
