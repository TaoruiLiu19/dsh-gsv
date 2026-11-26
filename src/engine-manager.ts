import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GSV_ENGINE } from './catalog.js';
import { verifyModelManifest } from './model-manifest.js';

export interface EngineConfig {
  apiUrl: string;
  installDir: string;
  gsvModelManifest?: string;
}

export interface EngineStatus {
  running: boolean;
  port: number;
  message?: string;
}

export interface EngineActionResult extends EngineStatus {
  ok: boolean;
  message: string;
}

const SCRIPT = fileURLToPath(new URL(`../${GSV_ENGINE.startScript}`, import.meta.url));

export function enginePaths(directory: string) {
  const root = resolve(directory);
  const source = join(root, 'engine-source');
  const venv = join(root, '.venv');
  const modelDirs = [join(root, 'models'), join(root, 'API', 'models'), join(source, 'models')];
  return {
    root,
    source,
    venv,
    python: process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python'),
    models: modelDirs.find(path => existsSync(path)) ?? modelDirs[0],
    log: join(root, 'logs', 'engine.log'),
  };
}

function managedPort(value: string): number {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('托管引擎只支持本机 HTTP 端口。外部引擎请独立管理。');
  }
  return url.port ? Number(url.port) : 80;
}

export class EngineManager {
  private child: { process: ChildProcess; port: number; token: string } | undefined;
  private operation: { promise: Promise<EngineActionResult>; cancel: AbortController } | undefined;
  private readonly lifetime = new AbortController();

  constructor(private readonly getConfig: () => EngineConfig, private readonly script = SCRIPT) {}

  headers(apiUrl: string): Record<string, string> {
    const child = this.child;
    if (child) {
      try {
        if (managedPort(apiUrl) === child.port) return { Authorization: `Bearer ${child.token}` };
      } catch { /* 外部引擎不接收托管进程的凭据 */ }
    }
    return {};
  }

  async status(config = this.getConfig(), signal?: AbortSignal): Promise<EngineStatus> {
    let port = 0;
    try {
      const url = new URL(config.apiUrl);
      port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      const timeout = AbortSignal.timeout(2000);
      const response = await fetch(url, {
        headers: this.headers(config.apiUrl), redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      const info = response.ok ? await response.json() : undefined;
      if (info?.message === 'DSH-GSV-TTS Stream API') return { running: true, port };
    } catch { /* 未就绪 */ }
    return { running: false, port, message: '未检测到 GSV 流式引擎' };
  }

  start(config = this.getConfig(), signal = this.lifetime.signal): Promise<EngineActionResult> {
    if (this.operation) return this.operation.promise;
    const cancel = new AbortController();
    const promise = this.startManaged(config, AbortSignal.any([signal, this.lifetime.signal, cancel.signal]))
      .finally(() => { this.operation = undefined; });
    this.operation = { promise, cancel };
    return promise;
  }

  private async startManaged(config: EngineConfig, signal: AbortSignal): Promise<EngineActionResult> {
    signal.throwIfAborted();
    const current = await this.status(config, signal);
    if (current.running) return { ...current, ok: true, message: '引擎已在运行' };
    let port: number;
    try {
      port = managedPort(config.apiUrl);
    } catch (error) {
      return { ...current, ok: false, message: (error as Error).message };
    }
    if (this.child && this.child.port !== port) {
      return { ...current, ok: false, message: '请先停止现有引擎，再切换端口。' };
    }

    const paths = enginePaths(config.installDir);
    if (!existsSync(paths.python) || !existsSync(join(paths.source, 'pyproject.toml')) || !existsSync(this.script)) {
      return { ...current, ok: false, message: '本地引擎尚未安装，请先运行 tts_setup_engine。' };
    }

    const deadline = AbortSignal.timeout(120000);
    const waiting = AbortSignal.any([signal, deadline]);
    let launchError = '';
    try {
      waiting.throwIfAborted();
      if (!this.child) {
        await verifyModelManifest(paths.models, config.gsvModelManifest ?? '', waiting);
        mkdirSync(dirname(paths.log), { recursive: true });
        const fd = openSync(paths.log, 'a');
        const token = randomUUID();
        try {
          const child = spawn(paths.python, ['-I', this.script, '--models_dir', paths.models, '--port', String(port)], {
            cwd: paths.source,
            env: { ...process.env, DSH_GSV_ENGINE_TOKEN: token },
            stdio: ['ignore', fd, fd],
            windowsHide: true,
          });
          this.child = { process: child, port, token };
          const clearChild = () => { if (this.child?.process === child) this.child = undefined; };
          child.once('error', error => { launchError = error.message; clearChild(); });
          child.once('exit', code => { launchError = `退出码 ${code}`; clearChild(); });
        } finally {
          closeSync(fd);
        }
      }
      while (this.child) {
        waiting.throwIfAborted();
        if ((await this.status(config, waiting)).running) {
          return { ok: true, running: true, port, message: '引擎已启动' };
        }
        await delay(500, undefined, { signal: waiting });
      }
    } catch (error) {
      if (signal.aborted) {
        await this.terminate();
        signal.throwIfAborted();
      }
      launchError ||= deadline.aborted ? '等待引擎就绪超时' : (error as Error).message;
      await this.terminate();
    }
    return { ok: false, running: false, port, message: `引擎启动失败（${launchError || '进程退出'}），日志：${paths.log}` };
  }

  private async terminate(): Promise<void> {
    const child = this.child?.process;
    if (!child) return;
    const exit = once(child, 'close', { signal: AbortSignal.timeout(5000) });
    child.kill();
    await exit.catch(() => {});
  }

  async stop(): Promise<EngineActionResult> {
    const operation = this.operation;
    operation?.cancel.abort();
    await operation?.promise.catch(() => {});
    await this.terminate();
    const current = await this.status();
    return {
      ...current,
      ok: !current.running,
      message: current.running ? '引擎仍在运行，请检查是否由外部托管。' : '引擎已停止',
    };
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    await this.operation?.promise.catch(() => {});
    await this.terminate();
  }
}
