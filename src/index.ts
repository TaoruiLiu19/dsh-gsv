import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { TTSService } from './tts.service.js';
import { VoiceManager } from './voice-manager.js';
import { EngineSetup } from './setup.js';
import type { VoicePreset, HealthCheckResult, SetupResult } from './types.js';

export const name = 'dsh-gsv-tts';
export const inject = ['tools'];

export interface Config {
  apiUrl: string;
  voices: VoicePreset[];
  defaultVoice: string;
  autoPlay: boolean;
  timeout: number;
  installDir: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Config: any = Schema.object({
  apiUrl: Schema.string().default('http://localhost:9880').description('GSV-TTS-Lite API 服务地址'),
  voices: Schema.array(Schema.object({
    name: Schema.string().description('音色名称'),
    speakerAudioPath: Schema.string().description('目标音色参考音频路径').role('path'),
    promptAudioPath: Schema.string().description('提示音频路径（声音克隆必需）').role('path'),
    promptText: Schema.string().description('提示文本（对应提示音频的文字，留空走 ASR 自动转录）').default(''),
  })).description('音色预设列表，可在设置中自定义'),
  defaultVoice: Schema.string().description('默认音色名称（留空则使用列表第一个）').default(''),
  autoPlay: Schema.boolean().default(false).description('是否自动朗读助手回复'),
  timeout: Schema.number().default(30000).description('请求超时时间（毫秒）'),
  installDir: Schema.string().default('./GSV-TTS-Lite').description('GSV-TTS-Lite 引擎安装目录'),
});

export function apply(ctx: any, config: Config) {
  const voiceManager = new VoiceManager(config);
  const tts = new TTSService(config);
  const setup = new EngineSetup(config.apiUrl, config.installDir);

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
    async execute(args: { text: string; voice?: string }) {
      const preset = voiceManager.get(args.voice);
      if (!preset) {
        const available = voiceManager.list().map((v) => v.name).join(', ');
        throw new Error(`未找到音色 "${args.voice}"。可用音色: ${available || '（无）'}`);
      }
      const r = await tts.synthesize(args.text, preset);
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

  // ─── 自动朗读：监听 session/event ───
  if (config.autoPlay) {
    ctx.on('session/event', (session: unknown, event: { type: string; data: { message: { content: Array<{ type: string; text?: string }> } } }) => {
      if (event.type !== 'assistant/message') return;
      const text = (event.data.message.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join('');
      if (text) {
        const preset = voiceManager.get();
        if (preset) {
          tts.synthesize(text, preset).catch((e: unknown) => {
            ctx.logger?.warn?.('auto TTS fail', e);
          });
        }
      }
    });
  }
}
