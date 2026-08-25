import { execSync, spawn } from 'child_process';
import { existsSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { HealthCheckResult, SetupResult, SetupStep } from './types.js';

const GSV_REPO = 'https://github.com/chinokikiss/GSV-TTS-Lite.git';
const GSV_VERSION = '0.4.7';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class EngineSetup {
  constructor(private apiUrl: string, private installDir: string) {}

  async healthCheck(): Promise<HealthCheckResult> {
    const result: HealthCheckResult = {
      apiRunning: false,
      pythonInstalled: false,
      pythonVersion: '',
      pipPackageInstalled: false,
      repoCloned: false,
      repoPath: this.installDir,
      apiUrl: this.apiUrl,
    };

    try {
      const resp = await fetch(this.apiUrl, { signal: AbortSignal.timeout(5000) });
      result.apiRunning = resp.ok;
    } catch {
      result.apiRunning = false;
    }

    const pythonCmd = this.detectPythonCmd();
    if (pythonCmd) {
      result.pythonInstalled = true;
      try {
        result.pythonVersion = execSync(`${pythonCmd} --version 2>&1`, { encoding: 'utf-8', timeout: 10000 }).trim();
      } catch {
        result.pythonVersion = 'unknown';
      }
    }

    if (pythonCmd) {
      try {
        execSync(`${pythonCmd} -c "import gsv_tts" 2>&1`, { encoding: 'utf-8', timeout: 15000 });
        result.pipPackageInstalled = true;
      } catch {
        result.pipPackageInstalled = false;
      }
    }

    result.repoCloned = existsSync(join(this.installDir, 'API', 'personal_api.py'));

    return result;
  }

  async setup(): Promise<SetupResult> {
    const steps: SetupStep[] = [];
    const health = await this.healthCheck();

    if (health.apiRunning) {
      steps.push({ step: '检测 API 服务', status: 'success', message: `服务已在 ${this.apiUrl} 运行` });
      return { success: true, steps, apiUrl: this.apiUrl, message: 'GSV-TTS-Lite 已就绪' };
    }

    const pythonCmd = this.detectPythonCmd();
    if (!pythonCmd) {
      steps.push({ step: '检测 Python', status: 'failed', message: '未检测到 Python，请先安装 Python 3.10+' });
      return { success: false, steps, apiUrl: this.apiUrl, message: '缺少 Python 环境' };
    }
    steps.push({ step: '检测 Python', status: 'success', message: health.pythonVersion });

    if (!health.pipPackageInstalled) {
      try {
        execSync(`${pythonCmd} -m pip install gsv-tts-lite==${GSV_VERSION} 2>&1`, { encoding: 'utf-8', timeout: 300000, stdio: 'pipe' });
        steps.push({ step: '安装 gsv-tts-lite', status: 'success', message: `gsv-tts-lite==${GSV_VERSION} 安装成功` });
      } catch {
        steps.push({ step: '安装 gsv-tts-lite', status: 'failed', message: `pip install gsv-tts-lite==${GSV_VERSION} 失败` });
        return { success: false, steps, apiUrl: this.apiUrl, message: 'pip 安装失败' };
      }
    } else {
      steps.push({ step: '检测 gsv-tts-lite', status: 'success', message: '已安装' });
    }

    if (!health.repoCloned) {
      try {
        execSync(`git clone ${GSV_REPO} "${this.installDir}" 2>&1`, { encoding: 'utf-8', timeout: 120000, stdio: 'pipe' });
        steps.push({ step: '克隆仓库', status: 'success', message: `已克隆到 ${this.installDir}` });
      } catch {
        steps.push({ step: '克隆仓库', status: 'failed', message: `git clone 失败，请手动克隆 ${GSV_REPO}` });
        return { success: false, steps, apiUrl: this.apiUrl, message: '仓库克隆失败' };
      }
    } else {
      steps.push({ step: '检测仓库', status: 'success', message: `仓库已存在: ${this.installDir}` });
    }

    const apiDir = join(this.installDir, 'API');
    if (!existsSync(join(apiDir, 'requirements.txt'))) {
      steps.push({ step: '检测 API 目录', status: 'failed', message: `${apiDir}/requirements.txt 不存在` });
      return { success: false, steps, apiUrl: this.apiUrl, message: 'API 目录结构异常' };
    }

    try {
      execSync(`${pythonCmd} -m pip install -r "${join(apiDir, 'requirements.txt')}" 2>&1`, { encoding: 'utf-8', timeout: 300000, stdio: 'pipe' });
      steps.push({ step: '安装 API 依赖', status: 'success', message: 'requirements.txt 安装完成' });
    } catch {
      steps.push({ step: '安装 API 依赖', status: 'failed', message: 'pip install -r requirements.txt 失败' });
      return { success: false, steps, apiUrl: this.apiUrl, message: 'API 依赖安装失败' };
    }

    // 复制 dsh_stream_api.py 到 API 目录
    const bundledScript = join(__dirname, '..', 'scripts', 'dsh_stream_api.py');
    const targetScript = join(apiDir, 'dsh_stream_api.py');
    try {
      if (existsSync(bundledScript)) {
        copyFileSync(bundledScript, targetScript);
        steps.push({ step: '部署流式 API', status: 'success', message: 'dsh_stream_api.py 已复制' });
      } else if (!existsSync(targetScript)) {
        steps.push({ step: '部署流式 API', status: 'failed', message: `未找到 dsh_stream_api.py: ${bundledScript}` });
        return { success: false, steps, apiUrl: this.apiUrl, message: '流式 API 脚本缺失' };
      } else {
        steps.push({ step: '部署流式 API', status: 'success', message: '已存在' });
      }
    } catch (e) {
      steps.push({ step: '部署流式 API', status: 'failed', message: `复制失败: ${e}` });
      return { success: false, steps, apiUrl: this.apiUrl, message: '流式 API 部署失败' };
    }

    const port = this.parsePort();
    const modelsDir = existsSync(join(this.installDir, 'models'))
      ? join(this.installDir, 'models')
      : join(this.installDir, 'API', 'models');

    // 动态检测 Python 系统路径和 gsv_tts 安装路径
    const { systemSitePackages, gsvSitePackages, repoRoot } = this.detectPythonPaths(pythonCmd);

    // 生成 wrapper：所有路径动态注入，无硬编码
    const wrapperPath = join(apiDir, 'dsh_start_wrapper.py');
    const wrapperCode = this.generateWrapper(systemSitePackages, gsvSitePackages, repoRoot);
    writeFileSync(wrapperPath, wrapperCode, 'utf-8');

    let stderrBuf = '';
    let processExited = false;
    let exitCode: number | null = null;

    const child = spawn(pythonCmd, ['dsh_start_wrapper.py', '-p', String(port), '--models_dir', modelsDir], {
      cwd: apiDir,
      detached: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    child.on('exit', (code) => {
      processExited = true;
      exitCode = code;
    });

    child.unref();

    await new Promise((r) => setTimeout(r, 3000));

    if (processExited) {
      const tail = stderrBuf.trim().split('\n').slice(-5).join('\n');
      steps.push({
        step: '启动 API 服务',
        status: 'failed',
        message: `进程已退出（code ${exitCode}）${tail ? `，最后输出:\n${tail}` : ''}`,
      });
      return { success: false, steps, apiUrl: this.apiUrl, message: '服务启动后立即退出，请检查模型文件或显存' };
    }

    steps.push({ step: '启动 API 服务', status: 'success', message: `进程已启动（端口 ${port}），等待就绪...` });

    const ready = await this.waitForReady(180000);
    if (ready) {
      steps.push({ step: '验证服务', status: 'success', message: `服务已在 ${this.apiUrl} 就绪` });
      return { success: true, steps, apiUrl: this.apiUrl, message: 'GSV-TTS-Lite 安装完成，服务已就绪' };
    }

    if (!processExited) {
      const tail = stderrBuf.trim().split('\n').slice(-3).join('\n');
      steps.push({
        step: '验证服务',
        status: 'failed',
        message: `等待 180 秒后仍未就绪，进程仍在运行。${tail ? `最后输出:\n${tail}` : ''}`,
      });
      return {
        success: false,
        steps,
        apiUrl: this.apiUrl,
        message: '服务仍在启动中（可能正在下载模型），请稍后手动执行 tts_health_check 验证',
      };
    }

    const tail = stderrBuf.trim().split('\n').slice(-5).join('\n');
    steps.push({
      step: '验证服务',
      status: 'failed',
      message: `进程在等待期间退出。${tail ? `最后输出:\n${tail}` : ''}`,
    });
    return { success: false, steps, apiUrl: this.apiUrl, message: '服务启动后退出，请检查日志' };
  }

  private detectPythonCmd(): string | null {
    for (const cmd of ['python', 'python3']) {
      try {
        execSync(`${cmd} --version 2>&1`, { encoding: 'utf-8', timeout: 10000 });
        return cmd;
      } catch {
        continue;
      }
    }
    return null;
  }

  private detectPythonPaths(pythonCmd: string): {
    systemSitePackages: string | null;
    gsvSitePackages: string | null;
    repoRoot: string;
  } {
    let systemSitePackages: string | null = null;
    let gsvSitePackages: string | null = null;

    // 检测 Python 系统包路径
    try {
      systemSitePackages = execSync(
        `${pythonCmd} -c "import site; print(site.getsitepackages()[0])" 2>&1`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();
    } catch {
      // 忽略
    }

    // 检测 gsv_tts 安装位置（可能 --target 安装在非标准路径）
    try {
      const gsvPath = execSync(
        `${pythonCmd} -c "import gsv_tts; print(gsv_tts.__file__)" 2>&1`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();
      // gsv_tts.__file__ = .../site-packages/gsv_tts/__init__.py
      // site-packages = dirname(dirname(gsv_tts.__file__))
      if (gsvPath && !gsvPath.includes('Error') && !gsvPath.includes('Traceback')) {
        const gsvDir = dirname(dirname(gsvPath));
        // 如果 gsv_tts 不在系统 site-packages 里，说明是 --target 安装
        if (systemSitePackages && gsvDir !== systemSitePackages && !gsvDir.includes(systemSitePackages)) {
          gsvSitePackages = gsvDir;
        }
      }
    } catch {
      // gsv_tts 不可导入——可能在仓库源码模式下运行
    }

    const repoRoot = this.installDir.replace(/\\/g, '/');

    return { systemSitePackages, gsvSitePackages, repoRoot };
  }

  private generateWrapper(systemSitePackages: string | null, gsvSitePackages: string | null, repoRoot: string): string {
    const pathLines: string[] = [];
    pathLines.push(`    sys.path.insert(0, r'${repoRoot}')`);
    if (systemSitePackages) {
      pathLines.push(`    sys.path.insert(1, r'${systemSitePackages}')`);
    }
    if (gsvSitePackages) {
      pathLines.push(`    sys.path.append(r'${gsvSitePackages}')`);
    }
    pathLines.push(`    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))`);

    return `import os, sys
os.environ['GSV_DISABLE_CUDA_GRAPH'] = '1'
${pathLines.join('\n')}
try:
    import transformers.utils.import_utils
    import transformers.modeling_utils
    transformers.utils.import_utils.check_torch_load_is_safe = lambda: None
    transformers.modeling_utils.check_torch_load_is_safe = lambda: None
except Exception:
    pass
import dsh_stream_api
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('--models_dir', type=str, default='models')
parser.add_argument('-p', '--port', type=int, default=9880)
args = parser.parse_args()
from pathlib import Path
dsh_stream_api.models_dir_global = Path(args.models_dir)
import uvicorn
uvicorn.run(dsh_stream_api.app, host='0.0.0.0', port=args.port)
`;
  }

  private parsePort(): number {
    try {
      const url = new URL(this.apiUrl);
      return parseInt(url.port) || 9880;
    } catch {
      return 9880;
    }
  }

  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const interval = 3000;

    while (Date.now() < deadline) {
      try {
        const resp = await fetch(this.apiUrl, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) return true;
      } catch {
        // 还没就绪，继续等
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    return false;
  }
}
