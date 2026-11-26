import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { enginePaths, type EngineConfig, type EngineManager } from './engine-manager.js';
import type { HealthCheckResult, SetupResult, SetupStep } from './types.js';

const command = promisify(execFile);
const GSV_REPO = 'https://github.com/chinokikiss/GSV-TTS-Lite.git';
// This revision declares gsv-tts-lite 0.4.7.
const GSV_COMMIT = '6c049397142f4c9147a85f86b6ba37546e93a188';
const REQUIREMENTS = fileURLToPath(new URL('../scripts/gsv-requirements.txt', import.meta.url));
const CONSTRAINTS = fileURLToPath(new URL('../scripts/gsv-constraints.txt', import.meta.url));
const PYTHON_COMMANDS: [string, string[]][] = [['python', []], ['python3', []], ['py', ['-3']]];

async function detectPython(signal?: AbortSignal) {
  for (const [bin, prefix] of PYTHON_COMMANDS) {
    signal?.throwIfAborted();
    try {
      const { stdout } = await command(bin, [...prefix, '-I', '-c',
        'import sys; assert sys.version_info >= (3, 10); print(sys.version.split()[0])'],
        { timeout: 5000, windowsHide: true, signal });
      return { bin, prefix, version: stdout.trim() };
    } catch { /* 尝试另一种 Python 启动方式 */ }
  }
  signal?.throwIfAborted();
  return undefined;
}

export class EngineSetup {
  constructor(
    private readonly getConfig: () => EngineConfig,
    private readonly engine: EngineManager,
  ) {}

  async healthCheck(config = this.getConfig()): Promise<HealthCheckResult> {
    const paths = enginePaths(config.installDir);
    const [status, python] = await Promise.all([this.engine.status(config), detectPython()]);
    let installed = false;
    if (existsSync(paths.python)) {
      try {
        await command(paths.python, ['-I', '-c',
          'from importlib.metadata import version; assert version("gsv-tts-lite") == "0.4.7"; version("torch"); version("fastapi"); version("uvicorn")'],
          { timeout: 5000, windowsHide: true });
        installed = true;
      } catch { /* 依赖尚未安装完整 */ }
    }
    return {
      apiRunning: status.running,
      pythonInstalled: Boolean(python),
      pythonVersion: python?.version ?? '',
      pipPackageInstalled: installed,
      repoCloned: existsSync(join(paths.source, 'pyproject.toml')),
      repoPath: paths.root,
      apiUrl: config.apiUrl,
    };
  }

  async setup(config: EngineConfig, signal: AbortSignal): Promise<SetupResult> {
    signal.throwIfAborted();
    const steps: SetupStep[] = [];
    const { apiUrl } = config;
    const done = (success: boolean, message: string): SetupResult => ({ success, steps, apiUrl, message });
    const paths = enginePaths(config.installDir);
    const lock = join(paths.root, '.setup-lock');
    let locked = false;
    let stage = '准备安装目录';
    try {
      const current = await this.engine.status(config, signal);
      if (current.running) {
        if (this.engine.headers(config.apiUrl).Authorization) return done(true, '本地引擎已经就绪。');
        return done(false, '该地址已有独立运行的引擎。若要更新为托管引擎，请先停止旧进程。');
      }
      const url = new URL(apiUrl);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
        || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
        return done(false, '托管安装要求本机 HTTP 引擎地址。');
      }
      signal.throwIfAborted();
      mkdirSync(paths.root, { recursive: true });
      mkdirSync(lock);
      locked = true;
      const run = (bin: string, args: string[], cwd: string, timeout = 120000) => {
        signal.throwIfAborted();
        return command(bin, args, { cwd, timeout, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      };

      stage = '检测 Python';
      const python = await detectPython(signal);
      if (!python) throw new Error('请先安装 Python 3.10 或更新版本。');
      steps.push({ step: stage, status: 'success', message: python.version });

      stage = '获取固定版本引擎源码';
      mkdirSync(paths.source, { recursive: true });
      if (!existsSync(join(paths.source, '.git'))) await run('git', ['init'], paths.source);
      let head = '';
      try { head = (await run('git', ['rev-parse', 'HEAD'], paths.source)).stdout.trim(); }
      catch { /* 新仓库尚无提交 */ }
      if (head !== GSV_COMMIT) {
        await run('git', ['fetch', '--depth=1', '--no-tags', GSV_REPO, GSV_COMMIT], paths.source);
        await run('git', ['checkout', '--detach', GSV_COMMIT], paths.source);
      }
      if ((await run('git', ['status', '--porcelain', '--untracked-files=no'], paths.source)).stdout.trim()) {
        throw new Error('托管引擎源码存在本地修改，请检查后重试。');
      }
      steps.push({ step: stage, status: 'success', message: GSV_COMMIT });

      stage = '安装隔离环境及依赖';
      if (!existsSync(paths.python)) await run(python.bin, [...python.prefix, '-I', '-m', 'venv', paths.venv], paths.root);
      await run(paths.python, ['-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--progress-bar', 'off',
        '-c', CONSTRAINTS, '-r', REQUIREMENTS, paths.source], paths.root, 900000);
      await run(paths.python, ['-I', '-m', 'pip', '--isolated', 'check'], paths.root);
      steps.push({ step: stage, status: 'success', message: paths.venv });

      stage = '启动并验证引擎';
      const started = await this.engine.start(config, signal);
      steps.push({ step: stage, status: started.ok ? 'success' : 'failed', message: started.message });
      return done(started.ok, started.message);
    } catch (error) {
      signal.throwIfAborted();
      const failure = error as NodeJS.ErrnoException;
      const message = !locked && failure.code === 'EEXIST'
        ? '此目录已有安装任务，或上次安装未正常结束。确认没有安装任务后再清理 .setup-lock。'
        : String(failure.message).split(/\r?\n/)[0].slice(0, 400);
      steps.push({ step: stage, status: 'failed', message });
      return done(false, message);
    } finally {
      if (locked) rmdirSync(lock);
    }
  }
}
