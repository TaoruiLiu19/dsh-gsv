import { randomUUID } from 'node:crypto';
import { TTS_API_PATH, type AudioStore } from './audio-store.js';
import { getProviderDescriptor, GSV_ENGINE, PROVIDER_CATALOG } from './catalog.js';
import { enginePaths, type EngineManager } from './engine-manager.js';
import { HttpError, json, readJson, streamResponse } from './http.js';
import { LiveSpeechQueue, type AssistantFrame } from './live-speech.js';
import { verifyModelManifest } from './model-manifest.js';
import type { SpeechStats } from './speech-stats.js';
import { parseLexicon, previewLexicon } from './lexicon.js';
import { type SpeechJob, type TTSService } from './tts.service.js';
import type { Config, ProviderKind } from './types.js';
import type { VoiceRegistryManager } from './voice-registry.js';
import { selectVoice } from './voice-selection.js';

interface SessionMessage {
  id?: string;
  content?: { type: string; text?: string }[];
}

interface SessionEvent {
  type: string;
  data?: { message?: SessionMessage };
}

interface Session {
  id: string;
  snapshotEvents(): SessionEvent[];
}

type Method = 'GET' | 'HEAD' | 'POST';
interface RoutesContext {
  sessions: { get(id: string): Session | undefined };
  effect(register: () => (() => void) | void): void;
  on(event: 'session/event', handler: (session: Session, event: SessionEvent) => void): void;
  on(event: 'agent/assistant-stream', handler: (payload: { agent: { session: Session }; frame: AssistantFrame }) => void,
    options: { global: true }): void;
  connection: {
    fetch: {
      register(route: {
        path: string;
        methods: Method[];
        requestBody: 'buffered';
        fetch(request: Request): Promise<Response>;
      }): void;
    };
  };
}

interface Services {
  config(): Config;
  tts: TTSService;
  audio: AudioStore;
  engine: EngineManager;
  registry: VoiceRegistryManager;
  previewText: string;
  prewarm(): Promise<void>;
  stats?: SpeechStats;
  writeVoiceSelection?(patch: ReturnType<typeof selectVoice>): Promise<void>;
}
const MAX_STREAM_TICKETS = 64;
const TICKET_TTL = 60_000;

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function speechText(message?: SessionMessage): string {
  return (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('');
}

export function registerPlaybackRoutes(ctx: RoutesContext, services: Services): void {
  const { config, tts, audio, engine, registry, previewText, prewarm, stats } = services;
  const lifetime = new AbortController();
  const tickets = new Map<string, { job: SpeechJob; expires: number; attempt?: AbortSignal }>();
  const autoplay = new WeakMap<Session, LiveSpeechQueue>();
  let selection = Promise.resolve();
  ctx.effect(() => () => {
    lifetime.abort();
    tickets.clear();
  });

  function route(path: string, methods: Method[], handler: (request: Request) => Response | Promise<Response>): void {
    ctx.connection.fetch.register({
      path: TTS_API_PATH + path,
      methods,
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const active = new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) });
          active.signal.throwIfAborted();
          return await handler(active);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = error instanceof HttpError ? error.status : 500;
          return json({ ok: false, message }, status);
        }
      },
    });
  }

  function sessionById(id: unknown): Session {
    const session = typeof id === 'string' ? ctx.sessions.get(id) : undefined;
    if (!session) throw new HttpError(404, '会话不存在');
    return session;
  }

  async function readSpeech(request: Request): Promise<SpeechJob> {
    const body = await readJson(request);
    const id = string(body.messageId);
    let text: string | undefined;
    if (body.sessionId !== undefined || id) {
      const session = sessionById(body.sessionId);
      const event = session.snapshotEvents().find(event => event.type === 'assistant/message' && event.data?.message?.id === id);
      if (!id || !event) throw new HttpError(404, '该会话中没有对应的助手消息');
      text = speechText(event.data?.message);
    } else {
      text = string(body.text);
    }
    return { ...prepare(text ?? ''), followText: body.followText === true };
  }

  function prepare(text: string, snapshot = config()): SpeechJob {
    try { return tts.prepareJob(text, undefined, undefined, undefined, snapshot); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  }

  function queueWav(job: SpeechJob, attempt?: AbortSignal): Response {
    const now = Date.now();
    for (const [token, value] of tickets) {
      if (value.expires <= now || tickets.size >= MAX_STREAM_TICKETS) tickets.delete(token);
    }
    const token = randomUUID();
    tickets.set(token, { job, expires: now + TICKET_TTL, attempt });
    return json({
      streamUrl: `${TTS_API_PATH}/speak/stream?token=${token}`,
      voiceUsed: typeof job.voice === 'string' ? job.voice : job.voice.name,
    });
  }

  async function* tracked<T>(job: SpeechJob, source: AsyncGenerator<T>, signal: AbortSignal): AsyncGenerator<T> {
    let cancelledAt = 0;
    const abort = () => { cancelledAt = performance.now(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      yield* source;
      if (!signal.aborted) stats?.record(job.config.provider, 'finish');
    } catch (error) {
      if (!signal.aborted) stats?.record(job.config.provider, 'failure');
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) stats?.record(job.config.provider, 'cancel', cancelledAt ? performance.now() - cancelledAt : 0);
    }
  }

  function segments(request: Request, job: SpeechJob): Response {
    const encode = new TextEncoder();
    return streamResponse(request, 'application/x-ndjson; charset=utf-8', async function* (signal) {
      let totalLen = 0;
      try {
        for await (const segment of tracked(job, tts.streamSegments(job, signal), signal)) {
          if (!segment.index) yield encode.encode(JSON.stringify({ type: 'start', total: segment.total }) + '\n');
          totalLen += segment.duration;
          yield encode.encode(JSON.stringify({ type: 'segment', ...segment }) + '\n');
        }
        yield encode.encode(JSON.stringify({ type: 'done', totalLen }) + '\n');
      } catch (error) {
        if (!signal.aborted) yield encode.encode(JSON.stringify({ type: 'error', message: (error as Error).message }) + '\n');
      }
    });
  }

  async function speak(request: Request, job: SpeechJob, attempt?: AbortSignal): Promise<Response> {
    if (attempt) request = new Request(request.url, {
      method: request.method, headers: request.headers, signal: AbortSignal.any([request.signal, attempt]),
    });
    request.signal.throwIfAborted();
    const accept = request.headers.get('accept') ?? '';
    const voiceUsed = typeof job.voice === 'string' ? job.voice : job.voice.name;
    let response;
    if (job.config.provider !== 'edge' && accept.includes('audio/wav')) {
      const cached = tts.cachedComplete(job);
      if (!cached && job.automatic && job.config.provider === 'deepseek' && !tts.hasWavInFlight(job)) {
        stats?.checkAutomaticBudget(job.text, job.config.deepseekAutoCharsPerDay ?? null);
      }
      response = cached
        ? json({ segments: [{ url: cached.audioUrl, duration: cached.duration }], voiceUsed })
        : queueWav(job, attempt);
    } else if (accept.includes('application/x-ndjson')) {
      response = segments(request, { ...job, followText: job.followText || !accept.includes('audio/wav') });
    } else {
      const result = await tts.synthesizeJobSegments(job, request.signal);
      response = json({ ...result, audioUrl: result.segments[0]?.url ?? null, audioLen: result.totalLen, voiceUsed });
    }
    response.headers.set('X-DSH-GSV-Provider', job.config.provider);
    return response;
  }

  route('/audio', ['GET', 'HEAD'], request => audio.serve(request));
  route('/speak', ['POST'], async request => speak(request, await readSpeech(request)));
  route('/speak/stream', ['GET'], request => {
    const token = new URL(request.url).searchParams.get('token') ?? '';
    const ticket = tickets.get(token);
    tickets.delete(token);
    if (!ticket || ticket.expires <= Date.now() || ticket.attempt?.aborted) throw new HttpError(404, '朗读流已过期，请重新点击朗读');
    const active = ticket.attempt ? new Request(request, { signal: AbortSignal.any([request.signal, ticket.attempt]) }) : request;
    return streamResponse(active, 'audio/wav', signal => tracked(ticket.job, tts.liveWav(ticket.job, signal), signal));
  });
  route('/speak/full', ['POST'], async request => {
    const job = await readSpeech(request);
    return json({ ...await tts.complete(job, request.signal), voiceUsed: typeof job.voice === 'string' ? job.voice : job.voice.name });
  });

  route('/engine/status', ['GET'], async request => json(await engine.status(config(), request.signal)));
  route('/engine/model-integrity', ['GET'], async request => {
    const settings = config();
    try {
      return json(await verifyModelManifest(enginePaths(settings.installDir).models, settings.gsvModelManifest, request.signal));
    } catch (error) { throw new HttpError(422, (error as Error).message); }
  });
  route('/metrics', ['GET', 'POST'], async request => {
    if (request.method === 'GET') return json(stats?.snapshot() ?? {});
    const { provider, firstAudioMs } = await readJson(request);
    if (typeof provider !== 'string' || !getProviderDescriptor(provider)
      || typeof firstAudioMs !== 'number' || !Number.isFinite(firstAudioMs) || firstAudioMs < 0 || firstAudioMs > 600000) {
      throw new HttpError(400, '无效的首音指标');
    }
    stats?.record(provider as ProviderKind, 'firstAudio', firstAudioMs);
    return json({ ok: true });
  });
  route('/engine/start', ['POST'], async request => {
    const result = await engine.start(config(), request.signal);
    if (result.ok) void prewarm();
    return json(result);
  });
  route('/engine/stop', ['POST'], async () => json(await engine.stop()));

  const provider = (value: unknown, fallback = config().provider): ProviderKind =>
    typeof value === 'string' && getProviderDescriptor(value) ? value as ProviderKind : fallback;
  route('/provider/catalog', ['POST'], () => json({
    providers: PROVIDER_CATALOG, engines: [GSV_ENGINE], current: config().provider,
  }));
  route('/settings/voice', ['POST'], async request => {
    if (!services.writeVoiceSelection) throw new HttpError(503, '声音设置不可写');
    const input = await readJson(request);
    if (typeof input.provider !== 'string' || !getProviderDescriptor(input.provider) ||
      (input.voice !== undefined && typeof input.voice !== 'string')) {
      throw new HttpError(400, '请选择有效的语音提供方和音色');
    }
    const job = selection.then(async () => {
      request.signal.throwIfAborted();
      const patch = selectVoice(config(), input.provider as ProviderKind, input.voice as string | undefined);
      await services.writeVoiceSelection!(patch);
      return patch;
    });
    selection = job.then(() => {}, () => {});
    return json(await job);
  });
  route('/provider/voices', ['POST'], async request => {
    const kind = provider((await readJson(request)).provider);
    return json({ provider: kind, voices: await tts.listVoices(kind) });
  });
  route('/provider/health', ['POST'], async request => {
    const kind = provider((await readJson(request)).provider);
    return json({ provider: kind, ...await tts.health(kind) });
  });
  route('/provider/preview', ['POST'], async request => {
    const body = await readJson(request);
    const voice = string(body.voice);
    if (!voice) throw new HttpError(400, '缺少云端音色 id');
    const current = config().provider;
    const kind = provider(body.provider, current === 'gsv' ? 'edge' : current);
    const audio = await tts.synthesize(previewText, voice, request.signal, kind);
    return json({ audioUrl: audio.audioUrl, audioLen: audio.audioLen, voiceUsed: voice });
  });
  route('/lexicon/preview', ['POST'], async request => {
    const body = await readJson(request);
    const text = string(body.text);
    if (!text) throw new HttpError(400, '缺少 text');
    const cfg = config();
    const lexicon = typeof body.lexicon === 'string' ? body.lexicon : cfg.lexicon;
    return json({ provider: cfg.provider, ...previewLexicon(text, parseLexicon(lexicon), cfg.provider) });
  });
  route('/preview', ['POST'], async request => {
    const body = await readJson(request);
    const voice = body.voice as Record<string, unknown> | undefined;
    const speakerAudioPath = string(voice?.speakerAudioPath);
    const promptAudioPath = string(voice?.promptAudioPath);
    if (!speakerAudioPath || !promptAudioPath) throw new HttpError(400, '试听需要参考音频与提示音频路径');
    const name = string(voice?.name) ?? '试听音色';
    try {
      const audio = await tts.synthesize(previewText, {
        name, speakerAudioPath, promptAudioPath, promptText: string(voice?.promptText) ?? '',
      }, request.signal, 'gsv');
      return json({ audioUrl: audio.audioUrl, audioLen: audio.audioLen, voiceUsed: name });
    } catch (error) {
      request.signal.throwIfAborted();
      if (!(await engine.status(config(), request.signal)).running) throw new HttpError(503, '语音引擎未启动');
      throw error;
    }
  });
  route('/registry/list', ['POST'], async request => json(await registry.list(string((await readJson(request)).registryUrl))));
  route('/registry/install', ['POST'], async request => {
    const { id, confirm } = await readJson(request);
    if (typeof id !== 'string' || !id) throw new HttpError(400, '缺少 id');
    return json(await registry.install(id, confirm === true));
  });
  route('/registry/remove', ['POST'], async request => {
    const { id, deleteFiles } = await readJson(request);
    if (typeof id !== 'string' || !id) throw new HttpError(400, '缺少 id');
    return json(await registry.remove(id, deleteFiles !== false));
  });

  function queue(session: Session) {
    let queue = autoplay.get(session);
    if (!queue) {
      queue = new LiveSpeechQueue();
      autoplay.set(session, queue);
    }
    return queue;
  }

  route('/autoplay/poll', ['POST'], async request => {
    const { sessionId, sinceSeq } = await readJson(request);
    const state = queue(sessionById(sessionId));
    const latest = state.sequence;
    const control = state.cancelled.length ? { cancelled: state.cancelled } : {};
    if (!config().autoPlay || !Number.isSafeInteger(sinceSeq) || Number(sinceSeq) > latest) {
      return json({ seq: latest, ...control });
    }
    const remaining = state.items.filter(item => item.seq > Number(sinceSeq));
    const last = remaining.at(-1);
    const next = config().interruptOnNew
      ? last?.attemptId ? remaining.find(item => item.attemptId === last.attemptId) : last
      : remaining[0];
    return json(next ? { seq: next.seq, messageId: next.messageId, attemptId: next.attemptId, ...control } : { seq: latest, ...control });
  });
  route('/autoplay/speak', ['POST'], async request => {
    const { sessionId, seq, messageId } = await readJson(request);
    if (!config().autoPlay) throw new HttpError(409, '自动朗读已关闭');
    const item = autoplay.get(sessionById(sessionId))?.items.find(item => item.seq === seq && item.messageId === messageId);
    if (!item) throw new HttpError(404, '这条自动朗读消息已过期');
    return speak(request, { ...prepare(item.text, item.config), automatic: true }, item.signal);
  });
  ctx.on('session/event', (session, event) => {
    const settings = config();
    if (!settings.autoPlay || event.type !== 'assistant/message') return;
    const message = event.data?.message;
    const text = speechText(message);
    if (!message?.id || !text.trim()) return;
    queue(session).commit(message.id, text, settings.liveReply);
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const settings = config();
    if (!ctx.sessions.get(agent.session.id)) return;
    if (settings.autoPlay && settings.liveReply) queue(agent.session).accept(frame, settings);
    else autoplay.get(agent.session)?.accept(frame, settings);
  }, { global: true });
}
