// lib/client.js 全局播放器单测：分段队列顺序播放、暂停/继续、停止、barge-in 打断、进度计算
// 以假 Audio/document 环境加载真实 bundle，驱动 exports.player 单例。
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeAudio {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.currentTime = 0;
    this.duration = 10;
    this.paused = true;
    this._src = url;
    this._handlers = {};
    FakeAudio.instances.push(this);
  }
  addEventListener(name, fn) {
    (this._handlers[name] = this._handlers[name] || []).push(fn);
  }
  emit(name) {
    for (const fn of this._handlers[name] || []) fn.call(this);
  }
  play() {
    this.paused = false;
    queueMicrotask(() => this.emit('play'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.emit('pause');
  }
  load() {}
  set src(v) { this._src = v; }
  get src() { return this._src; }
}

let player;

async function loadPlayer() {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const requireStub = (name) => {
    const map = {
      'react': {},
      'react/jsx-runtime': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    };
    if (!map[name]) throw new Error('unexpected require: ' + name);
    return map[name];
  };
  let exportsObj = null;
  globalThis.window = { __ModuleLoader__: { load: (e) => { exportsObj = e.factory(requireStub); } } };
  globalThis.Audio = FakeAudio;
  FakeAudio.instances = [];
  // bundle 顶层直接调用 window.__ModuleLoader__.load(...)
  new Function('window', 'globalThis', src)(globalThis.window, globalThis);
  player = exportsObj.player;
  assert.ok(player, 'player 应被导出');
}

test('加载 bundle 并导出 player（初始 idle）', async () => {
  await loadPlayer();
  assert.equal(player.state, 'idle');
});

test('分段队列顺序播放 + 自动续播 + 播完回到 idle + 停止', async () => {
  await loadPlayer();
  player.play('k1', [{ url: 'a1', duration: 10 }, { url: 'a2', duration: 20 }, { url: 'a3', duration: 30 }]);
  assert.equal(player.state, 'playing');
  assert.equal(player.isActive('k1'), true);
  assert.equal(player.index, 0);
  assert.equal(FakeAudio.instances.length, 1);
  // 播完第一段 → 自动续播第二段
  FakeAudio.instances[0].emit('ended');
  assert.equal(player.index, 1);
  assert.equal(FakeAudio.instances.length, 2);
  assert.equal(FakeAudio.instances[1].url, 'a2');
  // 播完最后一段 → 回到 idle
  FakeAudio.instances[1].emit('ended');
  assert.equal(player.index, 2);
  FakeAudio.instances[2].emit('ended');
  assert.equal(player.state, 'idle');
  assert.equal(player.isActive('k1'), false);
  // 停止
  player.play('k2', [{ url: 'b1', duration: 5 }]);
  assert.equal(player.isActive('k2'), true);
  player.stop();
  assert.equal(player.state, 'idle');
});

test('暂停/继续作用于整个队列，恢复后从原处续播', async () => {
  await loadPlayer();
  player.play('k', [{ url: 'a1', duration: 10 }, { url: 'a2', duration: 20 }]);
  const a0 = FakeAudio.instances[0];
  a0.currentTime = 6;
  player.pause();
  assert.equal(player.state, 'paused');
  assert.equal(a0.paused, true);
  player.resume();
  assert.equal(player.state, 'playing');
  assert.equal(a0.paused, false);
  // 暂停时进度保持（含已播段时长累计）
  a0.currentTime = 8;
  const p = player.progress();
  assert.equal(p.elapsed, 8);
  assert.equal(p.total, 30);
  assert.equal(p.index, 0);
  assert.equal(p.count, 2);
});

test('barge-in：新队列打断旧队列', async () => {
  await loadPlayer();
  player.play('old', [{ url: 'a1', duration: 10 }]);
  const oldAudio = FakeAudio.instances[0];
  player.play('new', [{ url: 'b1', duration: 5 }]);
  assert.equal(oldAudio.paused, true, '旧音频应被停止');
  assert.equal(player.isActive('old'), false);
  assert.equal(player.isActive('new'), true);
  assert.equal(player.index, 0);
  assert.equal(FakeAudio.instances[1].url, 'b1');
});

test('loop：队列播完自动从头循环，stop 后退出循环', async () => {
  await loadPlayer();
  player.play('loop', [{ url: 'a1', duration: 10 }, { url: 'a2', duration: 20 }], { loop: true });
  FakeAudio.instances[0].emit('ended');
  assert.equal(player.index, 1, '第一段播完进入第二段');
  FakeAudio.instances[1].emit('ended');
  assert.equal(player.index, 0, '第二段播完循环回第一段');
  assert.equal(FakeAudio.instances.length, 3);
  assert.equal(player.state, 'playing');
  assert.equal(player.loop, true);
  player.stop();
  assert.equal(player.loop, false);
  assert.equal(player.state, 'idle');
});

test('空队列与停止后的进度防御', async () => {
  await loadPlayer();
  player.play('empty', []);
  assert.equal(player.state, 'idle');
  player.play('k', [{ url: 'a1', duration: 10 }]);
  const a0 = FakeAudio.instances[0];
  a0.currentTime = 4;
  const p = player.progress();
  assert.equal(p.elapsed, 4);
  assert.equal(p.total, 10);
  player.stop();
  const idle = player.progress();
  assert.equal(idle.elapsed, 0);
  assert.equal(idle.total, 0);
});

test('backlog：不打断时新回复入队，当前队列播完自动补读', async () => {
  await loadPlayer();
  player.play('m1', [{ url: 'a1', duration: 10 }]);
  player.enqueue('m2', [{ url: 'b1', duration: 5 }]);
  assert.equal(player.isActive('m1'), true);
  assert.equal(player.isActive('m2'), false, 'm2 应先排队');
  FakeAudio.instances[0].emit('ended');
  assert.equal(player.isActive('m2'), true, 'm1 播完应自动补读 m2');
  assert.equal(FakeAudio.instances[1].url, 'b1');
});

test('play（barge-in）会清空 backlog', async () => {
  await loadPlayer();
  player.play('m1', [{ url: 'a1', duration: 10 }]);
  player.enqueue('m2', [{ url: 'b1', duration: 5 }]);
  player.play('m3', [{ url: 'c1', duration: 4 }]); // 打断并清空 backlog
  FakeAudio.instances[0].emit('ended'); // 旧音频的 ended 应被忽略
  assert.equal(player.isActive('m1'), false);
  assert.equal(player.isActive('m2'), false, 'backlog 应被清空');
  assert.equal(player.isActive('m3'), true);
});
