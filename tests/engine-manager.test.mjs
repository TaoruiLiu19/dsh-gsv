import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EngineManager, enginePaths } from '../lib/engine-manager.js';

const fakeEngine = `
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--models_dir', required=True, type=Path)
parser.add_argument('--port', required=True, type=int)
args = parser.parse_args()
assert args.models_dir.is_absolute() and args.models_dir.is_dir()
assert Path('pyproject.toml').is_file()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer ' + os.environ['DSH_GSV_ENGINE_TOKEN']:
            self.send_error(401)
            return
        content = json.dumps({'message': 'DSH-GSV-TTS Stream API'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
`;

test('统一启动器在含空格的目录启动，拒绝无凭据请求并停止子进程', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh gsv engine '));
  const paths = enginePaths(root);
  let engine;
  try {
    await mkdir(paths.source, { recursive: true });
    await mkdir(paths.models, { recursive: true });
    await writeFile(join(paths.source, 'pyproject.toml'), '[project]\nname = "fake-engine"\n');
    const script = join(root, 'fake engine.py');
    await writeFile(script, fakeEngine);
    execFileSync('python', ['-m', 'venv', '--without-pip', paths.venv], { timeout: 12_000, windowsHide: true });
    const reservation = createServer();
    reservation.listen({ host: '127.0.0.1', port: 0 });
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    const apiUrl = `http://127.0.0.1:${port}`;
    engine = new EngineManager(() => ({ apiUrl, installDir: root }), script);
    const first = engine.start(undefined, t.signal);
    assert.equal(engine.start(), first);
    assert.equal((await first).ok, true);
    assert.equal((await fetch(apiUrl)).status, 401);
    assert.equal((await engine.stop()).running, false);
  } finally {
    await engine?.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 2 });
  }
});
