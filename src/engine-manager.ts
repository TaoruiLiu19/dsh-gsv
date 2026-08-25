import { execFileSync, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync, openSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * GSV-TTS-Lite 引擎进程管理：启动（detached，宿主退出后仍存活）、停止、状态查询。
 * 单个实例跨配置热更新存活，避免 reconfigure 丢失子进程引用。
 */
export interface EngineStatus {
  running: boolean;
  port: number;
  message?: string;
}

export interface EngineActionResult {
  ok: boolean;
  running: boolean;
  message: string;
}

interface PythonCmd {
  bin: string;
  prefix: string[];
}

export class EngineManager {
  private child: ChildProcess | null = null;
  private apiUrl = 'http://localhost:9880';
  private installDir = './GSV-TTS-Lite';

  /** 配置热更新时同步（进程引用保留）。 */
  configure(apiUrl: string, installDir: string): void {
    this.apiUrl = apiUrl;
    this.installDir = installDir;
  }

  private get port(): number {
    try {
      return parseInt(new URL(this.apiUrl).port) || 9880;
    } catch {
      return 9880;
    }
  }

  /** 引擎是否响应（以 API 健康检查为准）。 */
  async status(): Promise<EngineStatus> {
    const port = this.port;
    try {
      const resp = await fetch(this.apiUrl, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) return { running: true, port };
    } catch {
      // 未运行
    }
    return { running: false, port, message: '引擎未响应' };
  }

  /** 启动引擎：已运行则直接返回；否则 detached 拉起并等待就绪。 */
  async start(): Promise<EngineActionResult> {
    const current = await this.status();
    if (current.running) return { ok: true, running: true, message: '引擎已在运行' };

    const script = join(this.installDir, 'API', 'dsh_stream_api.py');
    if (!existsSync(script)) {
      return { ok: false, running: false, message: `未找到引擎脚本：${script}（请先运行 tts_setup_engine 或检查 installDir）` };
    }
    const python = this.detectPython();
    if (!python) return { ok: false, running: false, message: '未检测到 Python（请安装 Python 3.10+）' };

    const apiDir = join(this.installDir, 'API');
    const modelsDir = existsSync(join(this.installDir, 'models'))
      ? join(this.installDir, 'models')
      : join(this.installDir, 'API', 'models');
    const port = this.port;

    const logPath = join(tmpdir(), 'dsh-gsv-tts-engine.log');
    const out = openSync(logPath, 'a');
    const child = spawn(python.bin, [...python.prefix, script, '-p', String(port), '--models_dir', modelsDir], {
      cwd: apiDir,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    this.child = child;
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });

    // 等待就绪（模型加载可能较慢）
    const ready = await this.waitForReady(90000);
    if (ready) return { ok: true, running: true, message: '引擎已启动' };
    return {
      ok: false,
      running: false,
      message: `引擎正在启动（模型加载需要时间），日志：${logPath}。稍后刷新状态确认。`,
    };
  }

  /** 停止引擎：终止由本管理器拉起的进程；外部托管进程不受影响。 */
  async stop(): Promise<EngineActionResult> {
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.kill();
      } catch {
        // 忽略
      }
    }
    await new Promise((r) => setTimeout(r, 800));
    const current = await this.status();
    return {
      ok: !current.running,
      running: current.running,
      message: current.running ? '引擎仍在运行（可能由外部进程托管，未能停止）' : '引擎已停止',
    };
  }

  private detectPython(): PythonCmd | null {
    const candidates: Array<[string, string[]]> = [
      ['python', []],
      ['python3', []],
      ['py', ['-3']],
    ];
    for (const [bin, prefix] of candidates) {
      try {
        execFileSync(bin, [...prefix, '--version'], { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
        return { bin, prefix };
      } catch {
        continue;
      }
    }
    return null;
  }

  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(this.apiUrl, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) return true;
      } catch {
        // 未就绪
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  }
}
