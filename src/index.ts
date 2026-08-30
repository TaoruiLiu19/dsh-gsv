import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TTSService } from './tts.service.js';
import { VoiceManager } from './voice-manager.js';
import { EngineSetup } from './setup.js';
import { AudioStore } from './audio-store.js';
import { EngineManager } from './engine-manager.js';
import { TextCleaner, MAX_SEGMENTED_TEXT_LENGTH } from './text-cleaner.js';
import type { Config as PluginConfig, HealthCheckResult, SetupResult } from './types.js';

export const name = 'dsh-gsv-tts';
export const inject = ['tools', 'webServer', 'settings'];

/** 音色试听固定文案：含长短句、数字与语气词，便于靠耳朵对比音色。 */
const PREVIEW_TEXT = '这是一段音色试听：你好，欢迎使用本地语音引擎。今天的天气很好，我们出发去爬山吧，一二三四五！';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Config: any = Schema.object({
  apiUrl: Schema.string().default('http://localhost:9880').description('GSV-TTS-Lite API 服务地址'),
  voices: Schema.array(Schema.object({
    name: Schema.string().description('音色名称'),
    speakerAudioPath: Schema.string().description('目标音色参考音频路径').role('path'),
    promptAudioPath: Schema.string().description('提示音频路径（声音克隆必需）').role('path'),
    promptText: Schema.string().description('提示文本（对应提示音频的文字，留空时若引擎支持 ASR 会自动转写，否则合成报错）').default(''),
  })).default([]).description('音色预设列表，可在设置中自定义'),
  defaultVoice: Schema.string().description('默认音色名称（留空则使用列表第一个）').default(''),
  autoPlay: Schema.boolean().default(false).description('是否自动朗读助手回复'),
  interruptOnNew: Schema.boolean().default(true).description('自动朗读时，新回复是否打断当前朗读（关闭则朗读中跳过新回复，避免叠音）'),
  timeout: Schema.number().default(30000).description('请求超时时间（毫秒）'),
  installDir: Schema.string().default('./GSV-TTS-Lite').description('GSV-TTS-Lite 引擎安装目录'),
});

export function apply(ctx: any, config: PluginConfig) {
  // 可热更新的运行态：设置面板（settings 命名空间）修改后重建
  let current: PluginConfig = config;
  let voiceManager = new VoiceManager(current);
  let audioStore = new AudioStore(`http://${ctx.webServer.host}:${ctx.webServer.port}`);
  let tts = new TTSService(current, audioStore);
  let setup = new EngineSetup(current.apiUrl, current.installDir);
  // 引擎进程管理：单实例跨配置热更新存活（避免 reconfigure 丢失子进程引用）
  const engineManager = new EngineManager();

  // 自动朗读通知状态：服务端只在有新回复时递增 seq 并暂存清洗后的文本，
  // 由前端轮询 /autoplay/poll 感知并按需触发合成播放（打断策略在前端执行）。
  const autoPlay = { seq: 0, text: null as string | null };

  const reconfigure = (next: PluginConfig) => {
    current = next;
    voiceManager = new VoiceManager(next);
    tts = new TTSService(next, audioStore);
    setup = new EngineSetup(next.apiUrl, next.installDir);
    engineManager.configure(next.apiUrl, next.installDir);
  };

  // 设置面板命名空间：base = cordis 配置，settings.yaml 用户层覆盖，变更热生效
  try {
    const settingsScope = ctx.settings.register('dsh-gsv-tts', Config, { base: config });
    reconfigure(settingsScope.get());
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
        const preset = voiceManager.get();
        if (!preset) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '未配置音色' }));
          return;
        }
        try {
          const r = await tts.synthesizeSegments(autoPlay.text, preset);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            segments: r.segments,
            audioUrl: r.segments[0]?.url ?? null,
            audioLen: r.totalLen,
            voiceUsed: preset.name,
            error: r.error,
          }));
        } catch (e: any) {
          // 引擎未启动是最常见失败：给出明确原因
          const engine = await engineManager.status();
          if (!engine.running) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: '语音引擎未启动，请到 设置 → 引擎 打开开关' }));
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
          const r = await tts.synthesize(PREVIEW_TEXT, {
            name,
            speakerAudioPath,
            promptAudioPath,
            promptText: String(v.promptText ?? ''),
          });
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
        const preset = voiceManager.get();
        if (!preset) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: '未配置音色' }));
          return;
        }
        try {
          // 渐进分段合成：按句切分逐段落地，返回可顺序播放的 URL 队列
          const r = await tts.synthesizeSegments(text, preset);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            segments: r.segments,
            audioUrl: r.segments[0]?.url ?? null,
            audioLen: r.totalLen,
            voiceUsed: preset.name,
            error: r.error,
          }));
        } catch (e: any) {
          // 引擎未启动是最常见失败：给出明确原因
          const engine = await engineManager.status();
          if (!engine.running) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: '语音引擎未启动，请到 设置 → 引擎 打开开关' }));
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
      const preset = voiceManager.get(args.voice);
      if (!preset) {
        const available = voiceManager.list().map((v) => v.name).join(', ');
        throw new Error(`未找到音色 "${args.voice}"。可用音色: ${available || '（无）'}`);
      }
      const r = await tts.synthesize(args.text, preset, exec.signal);
      return { audioUrl: r.audioUrl, audioLen: r.audioLen, voiceUsed: preset.name };
    },
  });

  // ─── 工具 2: tts_list_voices ─── 列出所有可用音色 ───
  const listVoicesTool = defineTool({
    name: 'tts_list_voices',
    description: '列出所有已配置的音色预设，返回名称和参考音频路径。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
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
      render() {
        const voices = voiceManager.list();
        const lines = voices.map((v) =>
          `- **${v.name}**${v.name === voiceManager.defaultName ? '（默认）' : ''}: ${v.speakerAudioPath}`
        );
        return [
          { type: 'text', text: `可用音色：\n${lines.join('\n')}` },
        ];
      },
    },
    async execute() {
      const voices = voiceManager.list().map((v) => ({
        name: v.name,
        speakerAudioPath: v.speakerAudioPath,
        isDefault: v.name === voiceManager.defaultName,
      }));
      return { voices, defaultVoice: voiceManager.defaultName };
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

  // ─── 注册所有工具 ───
  ctx.tools.register(speakTool);
  ctx.tools.register(listVoicesTool);
  ctx.tools.register(healthCheckTool);
  ctx.tools.register(setupEngineTool);

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
