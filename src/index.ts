import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TTSService } from './tts.service.js';
import { VoiceManager } from './voice-manager.js';
import { EngineSetup } from './setup.js';
import { AudioStore } from './audio-store.js';
import { EngineManager } from './engine-manager.js';
import { TextCleaner, MAX_SEGMENTED_TEXT_LENGTH } from './text-cleaner.js';
import { VoiceRegistryManager } from './voice-registry.js';
import { resolveProvider } from './migration.js';
import { SCHEMA_VERSION, snapshotConfig, storedProvider } from './config.js';
import { wavHeader, float32ToInt16 } from './wav-stream.js';
import { EDGE_FALLBACK_VOICE, isEdgeVoiceId } from './providers/edge.js';
import { DEEPSEEK_DEFAULT_VOICE, DeepseekProvider, isDeepseekVoiceId } from './providers/deepseek.js';
import type { Config as PluginConfig, HealthCheckResult, ProviderKind, SetupResult, VoicePreset } from './types.js';

export const name = 'dsh-gsv-tts';
export const inject = ['tools', 'webServer', 'settings'];

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
  autoPlay: live(Schema.boolean().default(false).description('是否自动朗读助手回复')),
  engineMode: live(Schema.union([Schema.const('always'), Schema.const('eco')]).default('eco').description('引擎启动方式：always=常驻模式（性能优先，自动启动并预热）/ eco=节能模式（资源优先，不后台启动，与旧版一致）')),
  interruptOnNew: live(Schema.boolean().default(true).description('自动朗读时，新回复是否打断当前朗读（关闭则朗读中跳过新回复，避免叠音）')),
  timeout: live(Schema.number().min(1).default(30000).description('请求超时时间（毫秒）')),
  installDir: live(Schema.string().default('./GSV-TTS-Lite').description('GSV-TTS-Lite 引擎安装目录')),
  voiceRegistryUrl: live(Schema.string().default('https://taoruiliu19.github.io/gsv-market/voices.json').description('音色市场远端清单地址（默认指向在线试听站点；留空则仅用包内离线清单）')),
  schemaVersion: live(Schema.number().default(SCHEMA_VERSION).description('配置结构版本')),
  provider: live(Schema.union([Schema.const('gsv'), Schema.const('edge'), Schema.const('deepseek')]).description('TTS 引擎：gsv 本地克隆 / edge 云端简单模式 / deepseek 官方语音（按字符计费）')),
  deepseekApiKey: live(Schema.string().default('').description('DeepSeek 官方语音 API Key（可选覆盖；留空默认复用 Harness 凭据服务里的 DEEPSEEK_API_KEY）')),
  deepseekApiKeyEnv: live(Schema.string().default('DEEPSEEK_API_KEY').description('凭据引用名：默认复用 Harness 已保存的 DEEPSEEK_API_KEY（模型设置页那个），留空则不查凭据服务')),
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

  const audioStore = new AudioStore(audioOrigin);
  const voiceManager = new VoiceManager(readConfig);
  // 凭据服务（可能存在也可能不存在）：用于复用 Harness 已保存的 DEEPSEEK_API_KEY，
  // 与模型鉴权读取同一份凭据，用户在插件里不必再填一次 Key。
  const credentialsOf = () => {
    try {
      return ctx.get?.('credentials');
    } catch {
      return undefined;
    }
  };
  const deepseekProvider = new DeepseekProvider({ getConfig: () => readConfig(), credentials: credentialsOf });
  const tts = new TTSService(readConfig, audioStore, { voiceManager, deepseek: deepseekProvider });
  const setup = new EngineSetup(readConfig);
  // 引擎进程管理：单实例跨配置热更新存活（避免重载丢失子进程引用）
  const engineManager = new EngineManager();
  const engineCtl = () => {
    const cfg = readConfig();
    engineManager.configure(cfg.apiUrl, cfg.installDir);
    return engineManager;
  };

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

  // 插件加载时后台拉起引擎（默认开启，可在设置里关闭），把 15–90 秒模型加载移出点击路径。
  let autoStartStarted = false;
  const autoStartEngine = async (): Promise<void> => {
    if (autoStartStarted) return;
    autoStartStarted = true;
    const cfg = readConfig();
    if (cfg.provider !== 'gsv' || cfg.engineMode !== 'always') return;
    try {
      const result = await engineCtl().start();
      if (result.ok) void prewarmDefaultVoice();
    } catch {
      // 引擎启动失败时保持原状，用户仍可手动启动
    }
  };
  setTimeout(() => { void autoStartEngine(); }, 1500);

  // 兼容旧配置：provider 是云端（edge/deepseek）但 defaultVoice 仍是另一种模式的音色时，
  // 云端口播会以 1007 / 400 失败。自动把默认音色修成该模式的默认音色（gsv 配置不动）。
  ctx.effect(() => {
    let disposed = false;
    const run = async () => {
      try { await ctx.root?.loader?.await?.(); } catch { /* 精简宿主 */ }
      if (disposed) return;
      const cfg = readConfig();
      if (!cfg.defaultVoice) return;
      let fallback: string | null = null;
      if (cfg.provider === 'edge' && !isEdgeVoiceId(cfg.defaultVoice)) fallback = EDGE_FALLBACK_VOICE;
      if (cfg.provider === 'deepseek' && !isDeepseekVoiceId(cfg.defaultVoice)) fallback = DEEPSEEK_DEFAULT_VOICE;
      if (fallback === null) return;
      try {
        await ctx.settings.update(entryId, { defaultVoice: fallback });
      } catch {
        // 只读部署或设置服务未就绪：运行时仍由对应 Provider 回退
      }
    };
    void run();
    return () => { disposed = true; };
  }, 'gsv-tts: repair-cloud-voice');

  // 自动朗读通知状态：服务端只在有新回复时递增 seq 并暂存清洗后的文本，
  // 由前端轮询 /autoplay/poll 感知并按需触发合成播放（打断策略在前端执行）。
  const autoPlay = { seq: 0, text: null as string | null };

  // 5.0.0 provider 迁移守卫：旧配置没有 provider 字段时落定一次并写回设置，
  // 之后设置面板切换直接走 settings.update，运行态始终读最新值。
  ctx.effect(() => {
    let disposed = false;
    const run = async () => {
      try {
        // 等 Loader 挂载完成：设置服务只对已激活条目暴露 describe/update。
        await ctx.root?.loader?.await?.();
      } catch {
        // 精简宿主 / 测试环境没有 loader：直接执行
      }
      if (disposed) return;
      try {
        const raw = storedProvider(config?.provider);
        if (raw === 'gsv' || raw === 'edge' || raw === 'deepseek') return;
        const provider = resolveProvider(raw, readConfig().voices);
        await ctx.settings.update(entryId, { provider, schemaVersion: SCHEMA_VERSION });
        ctx.logger?.info?.('dsh-gsv-tts 已落定 provider=%s', provider);
      } catch (e) {
        ctx.logger?.warn?.('dsh-gsv-tts provider 迁移写回失败', e);
      }
    };
    void run();
    return () => {
      disposed = true;
    };
  }, 'gsv-tts: provider migration');

  // 音色注册表核心（工具与 HTTP 路由共享）：写回走 settings.update → volatile 配置就地热更新
  const voiceRegistry = new VoiceRegistryManager({
    getConfig: () => readConfig(),
    writeConfig: async (patch) => {
      await ctx.settings.update(entryId, patch);
    },
  });

  /** 当前 provider 的默认音色：云端（edge/deepseek）→ defaultVoice 或空串（服务端回落默认）；gsv → 本地预设或 null。 */
  const resolveVoice = (): VoicePreset | string | null => {
    const cfg = readConfig();
    if (cfg.provider !== 'gsv') return cfg.defaultVoice || '';
    const preset = voiceManager.get();
    return preset ?? null;
  };

  /** 合成失败分支：gsv 时优先给出"引擎未启动"明确原因；edge 时原样返回云端错误。 */
  const failSynthesis = async (res: any, e: unknown): Promise<void> => {
    const msg = String((e as Error)?.message ?? e);
    if (readConfig().provider === 'gsv') {
      const engineStatus = await engineCtl().status();
      if (!engineStatus.running) {
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

  // 流式朗读：返回未知长度的 WAV，浏览器 <audio> 边下边播；断开即中断引擎。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-gsv-tts/speak/stream',
    handler: async (req: any, res: any) => {
      const token = new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get('token') ?? '';
      const entry = streamTokens.get(token);
      if (!entry || entry.expires < Date.now()) {
        streamTokens.delete(token);
        json(res, 404, { message: '朗读流已过期，请重新点击朗读' });
        return;
      }
      streamTokens.delete(token);

      const ac = new AbortController();
      let closed = false;
      res.on?.('close', () => {
        closed = true;
        ac.abort();
      });
      try {
        let headerSent = false;
        for await (const chunk of tts.streamPcm(entry.text, entry.voice, ac.signal)) {
          if (closed) break;
          if (!headerSent) {
            res.writeHead(200, {
              'Content-Type': 'audio/wav',
              'Cache-Control': 'no-store',
              'X-Accel-Buffering': 'no',
              'Accept-Ranges': 'none',
            });
            res.write(wavHeader(chunk.sampleRate));
            headerSent = true;
          }
          if (!res.write(float32ToInt16(chunk.data))) {
            await Promise.race([once(res, 'drain'), once(res, 'close')]);
          }
        }
        if (closed) {
          try { res.end(); } catch { /* 已断开 */ }
          return;
        }
        if (!headerSent) {
          json(res, 500, { message: '引擎没有返回音频数据' });
          return;
        }
        res.end();
      } catch (e: any) {
        if (!res.headersSent) json(res, 500, { message: String(e?.message ?? e) });
        else {
          try { res.end(); } catch { /* 已断开 */ }
        }
      }
    },
  }));

  // 引擎启停（设置 → 引擎 开关调用）
  const json = (res: any, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  /** 客户端是否请求流式 WAV（<audio> 直接播放，首音≈引擎首块）。 */
  const wantsWavStream = (req: any): boolean => {
    const accept = String(req?.headers?.accept ?? '');
    const url = String(req?.url ?? '');
    return accept.includes('audio/wav') || /[?&]stream=wav(?:&|$)/.test(url);
  };

  // 流式 WAV 的一次性令牌：POST /speak 只做文本/音色解析并返回 URL，
  // 真正的合成为 GET，浏览器 <audio> 可边下边播，且不会把长文本塞进 URL。
  const streamTokens = new Map<string, { text: string; voice: VoicePreset; expires: number }>();
  const createStreamToken = (text: string, voice: VoicePreset): string => {
    const now = Date.now();
    for (const [key, value] of streamTokens) {
      if (value.expires < now || streamTokens.size > 64) streamTokens.delete(key);
    }
    const token = randomUUID();
    streamTokens.set(token, { text, voice, expires: now + 60000 });
    return token;
  };

  /** 客户端是否请求流式朗读（NDJSON）。 */
  const wantsStream = (req: any): boolean => {
    const accept = String(req?.headers?.accept ?? '');
    const url = String(req?.url ?? '');
    return accept.includes('application/x-ndjson') || /[?&]stream=1(?:&|$)/.test(url);
  };

  /**
   * 流式朗读：按段合成，每段完成立刻以 NDJSON 推给浏览器。
   * 首段完成即可开始播放，不必等整条回复全部分段合成完。
   */
  const streamSegments = async (req: any, res: any, text: string, voice: VoicePreset | string): Promise<void> => {
    let parts: string[];
    try {
      parts = tts.planSegments(text);
    } catch (e: any) {
      json(res, 400, { message: String(e?.message ?? e) });
      return;
    }
    const ac = new AbortController();
    let closed = false;
    const onClose = () => {
      // 客户端停止/切歌/关页：中断引擎，避免旧请求占着推理锁
      closed = true;
      ac.abort();
    };
    res.on?.('close', onClose);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj: Record<string, unknown>) => {
      if (closed) return;
      try {
        res.write(JSON.stringify(obj) + '\n');
      } catch {
        // 连接已断，交给 close 事件收尾
      }
    };
    send({ type: 'start', total: parts.length });
    let totalLen = 0;
    try {
      for (let i = 0; i < parts.length; i++) {
        const r = await tts.synthesize(parts[i], voice, ac.signal);
        totalLen += r.audioLen;
        send({ type: 'segment', index: i, total: parts.length, url: r.audioUrl, duration: r.audioLen });
      }
      send({ type: 'done', totalLen });
    } catch (e: any) {
      if (!ac.signal.aborted) send({ type: 'error', message: String(e?.message ?? e) });
    } finally {
      res.off?.('close', onClose);
      try {
        res.end();
      } catch {
        // 已关闭
      }
    }
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/engine/status',
    handler: async (_req: any, res: any) => {
      try {
        json(res, 200, await engineCtl().status());
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
        const result = await engineCtl().start();
        if (result.ok) void prewarmDefaultVoice();
        json(res, 200, result);
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
        json(res, 200, await engineCtl().stop());
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
    handler: async (req: any, res: any) => {
      try {
        // 切换模式时客户端会在写回配置前先取目标 provider 的音色，
        // 因此允许 body/query 显式指定；未指定时用当前配置。
        const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
        const url = new URL(String(req.url ?? '/'), 'http://localhost');
        const requested = body.provider ?? url.searchParams.get('provider');
        const provider: ProviderKind =
          requested === 'edge' || requested === 'gsv' || requested === 'deepseek' ? requested : readConfig().provider;
        json(res, 200, { provider, voices: await tts.listVoices(provider) });
      } catch (e: any) {
        json(res, 500, { message: String(e?.message ?? e) });
      }
    },
  }));
  // 当前 provider 的健康（edge = 试合成退避；deepseek = 免费 /models 探活；gsv = 引擎状态）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/provider/health',
    handler: async (req: any, res: any) => {
      try {
        // 切换模式时客户端可能在写回配置前先探目标 provider，因此允许显式指定
        const body = (await readJson(req).catch(() => ({}))) as { provider?: unknown };
        const requested = body.provider;
        const provider: ProviderKind =
          requested === 'gsv' || requested === 'edge' || requested === 'deepseek' ? requested : readConfig().provider;
        json(res, 200, { provider, ...(await tts.health(provider)) });
      } catch (e: any) {
        json(res, 500, { message: String(e?.message ?? e) });
      }
    },
  }));
  // 云端音色试听：voice = 云端音色 id，provider = edge|deepseek（缺省跟随当前云端模式）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/provider/preview',
    handler: async (req: any, res: any) => {
      try {
        const body = (await readJson(req)) as { voice?: unknown; provider?: unknown };
        const voice = body.voice;
        if (typeof voice !== 'string' || !voice) {
          json(res, 400, { message: '缺少云端音色 id' });
          return;
        }
        // 客户端显式带 provider；旧客户端不带时按当前模式（gsv 时仍回退 edge，保持老行为）
        const current = readConfig().provider;
        const requested: ProviderKind =
          body.provider === 'deepseek' || body.provider === 'edge'
            ? body.provider
            : current === 'gsv'
              ? 'edge'
              : current;
        const r = await tts.synthesize(PREVIEW_TEXT, voice, undefined, requested);
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
        if (wantsWavStream(req) && typeof voice !== 'string') {
          const token = createStreamToken(autoPlay.text, voice);
          json(res, 200, { streamUrl: `/dsh-gsv-tts/speak/stream?token=${token}`, voiceUsed: voice.name });
          return;
        }
        if (wantsStream(req)) {
          await streamSegments(req, res, autoPlay.text, voice);
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
          const engineStatus = await engineCtl().status();
          if (!engineStatus.running) {
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
        const body = JSON.parse(raw || '{}');
        const { sessionId, messageId } = body;
        // 支持直接传 text（选中文字朗读），否则按 sessionId+messageId 取助手消息
        let text = typeof body.text === 'string' ? TextCleaner.clean(body.text) : '';
        if (!text) {
          if (!sessionId || !messageId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: '缺少 sessionId/messageId 或 text' }));
            return;
          }
          const sessions = ctx.get('sessions');
          const session = sessions?.get(sessionId);
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: '会话不存在' }));
            return;
          }
          // DSH 0.2+：同步读取整段事件日志请用 snapshotEvents()（events/log 已不再保证存在）。
          const events: Array<{ type?: string; data?: { message?: { id?: string; content?: Array<{ type?: string; text?: string }> } } }> =
            typeof session.snapshotEvents === 'function'
              ? session.snapshotEvents()
              : (session.events ?? session.eventsSnapshot ?? session.log ?? []);
          let content: Array<{ type?: string; text?: string }> = [];
          for (const ev of events) {
            if (ev.type === 'assistant/message' && ev.data?.message?.id === messageId) {
              content = ev.data?.message?.content ?? [];
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
          text = TextCleaner.clean(rawText);
        }
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '没有可朗读的文本（可能只包含代码/链接/表格等）' }));
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
        if (wantsWavStream(req) && typeof voice !== 'string') {
          const token = createStreamToken(text, voice);
          json(res, 200, { streamUrl: `/dsh-gsv-tts/speak/stream?token=${token}`, voiceUsed: voice.name });
          return;
        }
        if (wantsStream(req)) {
          await streamSegments(req, res, text, voice);
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

  // 整段朗读（可选）：返回单个可 seek / 可下载的音频文件。
  // 默认朗读仍走 /speak 的流式 WAV，不牺牲首音；这里只服务于「整段播放/下载」。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-gsv-tts/speak/full',
    handler: async (req: any, res: any) => {
      try {
        const body = await readJson(req);
        let text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) {
          const { sessionId, messageId } = body as { sessionId?: string; messageId?: string };
          if (!sessionId || !messageId) {
            json(res, 400, { message: '缺少 text 或 sessionId/messageId' });
            return;
          }
          const sessions = ctx.get('sessions');
          const session = sessions?.get(sessionId);
          if (!session) {
            json(res, 404, { message: '会话不存在' });
            return;
          }
          const events: any[] = typeof session.snapshotEvents === 'function'
            ? session.snapshotEvents()
            : (session.events ?? session.eventsSnapshot ?? session.log ?? []);
          let content: any[] = [];
          for (const ev of events) {
            if (ev.type === 'assistant/message' && ev.data?.message?.id === messageId) {
              content = ev.data?.message?.content ?? [];
              break;
            }
          }
          if (!Array.isArray(content) || content.length === 0) {
            json(res, 404, { message: '未找到消息' });
            return;
          }
          text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('');
        }
        text = TextCleaner.clean(text);
        if (!text) {
          json(res, 400, { message: '没有可朗读的文本（可能只包含代码/链接/表格等）' });
          return;
        }
        if (text.length > MAX_SEGMENTED_TEXT_LENGTH) {
          json(res, 400, { message: `文本过长（${text.length} 字符），请分段朗读` });
          return;
        }
        const voice = resolveVoice();
        if (voice === null) {
          json(res, 400, { message: '未配置音色' });
          return;
        }
        const cfg = readConfig();
        if (cfg.provider === 'gsv') {
          if (typeof voice === 'string') {
            json(res, 400, { message: '本地模式需要音色预设' });
            return;
          }
          // 本地：把引擎 PCM 直接写成完整 WAV，不设超时，长回复也不会被 30 秒截断。
          const ac = new AbortController();
          const onClose = () => ac.abort();
          res.on('close', onClose);
          try {
            const r = await tts.synthesizeFullWav(text, voice, ac.signal);
            json(res, 200, {
              audioUrl: r.audioUrl,
              duration: r.duration,
              bytes: r.bytes,
              parts: r.parts,
              voiceUsed: voice.name,
            });
          } finally {
            res.off('close', onClose);
          }
          return;
        }
        if (cfg.provider === 'deepseek') {
          // 官方语音：提供方按 2000 字切分，PCM 边收边写文件（内存不随文本线性增长）
          const ac = new AbortController();
          const onClose = () => ac.abort();
          res.on('close', onClose);
          try {
            const r = await tts.synthesizeLongWav(text, typeof voice === 'string' ? voice : undefined, ac.signal);
            json(res, 200, {
              audioUrl: r.audioUrl,
              duration: r.duration,
              bytes: r.bytes,
              parts: r.parts,
              voiceUsed: typeof voice === 'string' ? voice : cfg.defaultVoice,
            });
          } finally {
            res.off('close', onClose);
          }
          return;
        }
        // 云端：按句合成后把 MP3 串成一个文件。
        // Edge 输出固定 24 kHz / 48 kbps CBR，拼接文件无 Xing 头时直接按字节换算时长。
        const ac = new AbortController();
        let aborted = false;
        const onClose = () => { aborted = true; ac.abort(); };
        res.on('close', onClose);
        try {
          const parts = tts.planSegments(text);
          const chunks: Buffer[] = [];
          for (const part of parts) {
            if (aborted) throw new Error('已取消');
            const r = await tts.synthesize(part, voice, ac.signal);
            const fileName = String(r.audioUrl).split('/').pop() as string;
            chunks.push(readFileSync(join(audioStore.directory, fileName)));
          }
          const merged = Buffer.concat(chunks);
          const saved = audioStore.saveRaw(`reply_${Date.now()}_${randomUUID().slice(0, 8)}.mp3`, merged);
          json(res, 200, {
            audioUrl: saved.url,
            duration: merged.length * 8 / 48000,
            bytes: merged.length,
            parts: parts.length,
            voiceUsed: voice,
          });
        } finally {
          res.off('close', onClose);
        }
      } catch (e: any) {
        json(res, 500, { message: String(e?.message ?? e) });
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
    timeoutMs: readConfig().timeout,
    async execute(args: { text: string; voice?: string }, exec: { signal: AbortSignal }) {
      const cfg = readConfig();
      if (cfg.provider !== 'gsv') {
        // 云端模式（edge / deepseek）：voice 参数即云端音色 id（不填用 defaultVoice）
        const r = await tts.synthesize(args.text, args.voice, exec.signal);
        const fallback = cfg.provider === 'deepseek' ? DEEPSEEK_DEFAULT_VOICE : 'edge-default';
        return { audioUrl: r.audioUrl, audioLen: r.audioLen, voiceUsed: args.voice || cfg.defaultVoice || fallback };
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
        const mode =
          value.provider === 'deepseek'
            ? 'DeepSeek 官方语音'
            : value.provider === 'edge'
              ? 'Edge 云端'
              : '本地克隆模式';
        const lines = value.voices.map((v) =>
          `- **${v.name}**${v.isDefault ? '（默认）' : ''}: ${v.speakerAudioPath}`
        );
        return [{ type: 'text', text: `可用音色（${mode}）：\n${lines.join('\n') || '（无）'}` }];
      },
    },
    async execute() {
      const cfg = readConfig();
      const provider: ProviderKind = cfg.provider;
      if (provider === 'edge' || provider === 'deepseek') {
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
    if (!readConfig().autoPlay) return;
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
