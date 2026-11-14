// 设置面板三模式 UI 渲染冒烟：官方语音（deepseek）路径必须能渲染出 Tab / Key 输入，
// 且 Edge/GSV 模式不应受新模式影响（hook 顺序与本地字段仍在）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let current = null;
const fibers = new Map();

const react = {
  Component: class { constructor(props) { this.props = props; } },
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: Symbol('Fragment'),
  useState(init) {
    const fiber = current;
    const idx = fiber.index++;
    if (fiber.hooks[idx] === undefined) fiber.hooks[idx] = typeof init === 'function' ? init() : init;
    return [fiber.hooks[idx], (v) => { fiber.hooks[idx] = typeof v === 'function' ? v(fiber.hooks[idx]) : v; }];
  },
  useEffect(cb) { current.index++; current.effects.push(cb); },
  useCallback(fn) { current.index++; return fn; },
  useRef(init) { const f = current; const idx = f.index++; if (f.hooks[idx] === undefined) f.hooks[idx] = { current: init }; return f.hooks[idx]; },
  useSyncExternalStore(subscribe, getSnapshot) {
    const f = current; const idx = f.index++;
    if (f.hooks[idx] === undefined) { f.hooks[idx] = getSnapshot(); subscribe(() => {}); }
    return f.hooks[idx];
  },
};
const jsxRuntime = { jsx: (t, p) => ({ type: t, props: p || {} }), jsxs: (t, p, k) => ({ type: t, props: p || {}, key: k }) };
const primitives = { Tooltip: (p) => p.children };

function renderAt(Comp, props, path) {
  if (typeof Comp === 'function' && Comp.prototype && typeof Comp.prototype.render === 'function') {
    const inst = new Comp(props);
    inst.props = props;
    return inst.render();
  }
  let fiber = fibers.get(path.join('/'));
  if (!fiber) { fiber = { hooks: [], index: 0, effects: [], cleanups: [], hookCount: 0 }; fibers.set(path.join('/'), fiber); }
  current = fiber;
  fiber.index = 0;
  fiber.effects = [];
  const out = Comp(props);
  fiber.hookCount = fiber.index;
  current = null;
  return out;
}

let nodes = [];
function walk(node, path) {
  if (node == null || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, [...path, i])); return; }
  const { type, props } = node;
  nodes.push(node);
  if (typeof type === 'function') walk(renderAt(type, props, path), path);
  else if (type === react.Fragment) walk(props.children, path);
  else walk(props.children, path);
}

function runEffects() {
  for (const fiber of fibers.values()) {
    for (const cb of fiber.effects) {
      try {
        const cleanup = cb();
        if (typeof cleanup === 'function') fiber.cleanups.push(cleanup);
      } catch { /* 渲染期 effect 失败不影响断言 */ }
    }
  }
}

function renderSection({ provider, deepseekApiKey = '' }) {
  fibers.clear();
  const value = {
    apiUrl: '',
    voices: [],
    defaultVoice: '',
    autoPlay: false,
    engineMode: 'eco',
    interruptOnNew: true,
    timeout: 30000,
    installDir: './x',
    voiceRegistryUrl: '',
    schemaVersion: 1,
    provider,
    deepseekApiKey,
    quotaDaily: null,
  };
  const scope = {
    getSnapshot: () => ({ status: 'ready', value, writable: true, base: value }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  };
  const registrations = [];
  const disposers = [];
  const ctx = {
    locale: { bind: () => (key) => key, register: () => {} },
    configForms: { get: () => scope },
    slots: { inject: (n, fn) => fn(), register: (def, Comp) => { registrations.push({ def, Comp }); return () => {}; } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
  };
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let exportsObj = null;
  globalThis.window = {
    __ModuleLoader__: {
      load: (e) => {
        exportsObj = e.factory((name) => ({
          react,
          'react/jsx-runtime': jsxRuntime,
          '@deepseek-ai/dsh-client-ui-primitives': primitives,
        })[name]);
      },
    },
  };
  globalThis.Audio = class { constructor() {} play() { return Promise.resolve(); } pause() {} addEventListener() {} load() {} };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  new Function('window', 'globalThis', src)(globalThis.window, globalThis);
  exportsObj.apply(ctx);
  const section = registrations.find((r) => r.def.name === 'settings.section');
  assert.ok(section, 'settings.section 已注册');

  const render = () => {
    nodes = [];
    walk(renderAt(section.Comp, { scope, t: (k) => k }, ['root']), ['root']);
    return nodes;
  };
  render();            // 第一遍：draft=null，提前 return
  runEffects();        // 跑 effect：draft 同步为快照值
  const out = render(); // 第二遍：完整渲染

  // 清理：设置 effect 返回的 cleanup（例如云端音色轮询）+ apply() 注册的定时器
  for (const fiber of fibers.values()) for (const c of fiber.cleanups) { try { c(); } catch { /* 忽略 */ } }
  for (const d of disposers) { try { d(); } catch { /* 忽略 */ } }
  return out;
}

const hasText = (list, text) => list.some((n) => n.props && n.props.children === text);
const passwordInput = (list) => list.find((n) => n.type === 'input' && n.props && n.props.type === 'password');
const optionIds = (list) => {
  const select = list.find((n) => n.type === 'select');
  if (!select || !Array.isArray(select.props.children)) return [];
  return select.props.children.filter(Boolean).map((o) => o.props && o.props.value);
};

test('deepseek 模式：渲染出官方 Tab、Key 输入与官方音色说明', () => {
  const list = renderSection({ provider: 'deepseek', deepseekApiKey: 'sk-abc' });
  assert.ok(hasText(list, 'mode.official'), '模式 Tab 含“官方语音”');
  assert.ok(hasText(list, 'mode.officialDesc'), '展示官方语音说明');
  assert.ok(hasText(list, 'field.apiKey'), '展示 Key 标签');
  assert.ok(hasText(list, 'field.apiKeyReuse'), '提示默认复用 Harness 凭据');
  assert.ok(hasText(list, 'field.apiKeyRef'), '展示凭据名称字段');
  const key = passwordInput(list);
  assert.ok(key, 'Key 用 password 输入框');
  assert.equal(key.props.value, 'sk-abc');
});

test('gsv 模式：不出现官方 Key 输入，本地字段仍渲染', () => {
  const list = renderSection({ provider: 'gsv' });
  assert.equal(passwordInput(list), undefined);
  assert.ok(hasText(list, 'field.apiUrl'));
  assert.ok(hasText(list, 'field.voices'));
});

test('edge 模式：不出现官方 Key 输入，云端音色标签可见', () => {
  const list = renderSection({ provider: 'edge' });
  assert.equal(passwordInput(list), undefined);
  assert.ok(hasText(list, 'field.cloudVoice'));
});
