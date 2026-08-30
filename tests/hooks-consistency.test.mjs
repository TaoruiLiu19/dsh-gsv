// 回归测试：设置卡片 hook 数量跨渲染一致（React #310 复现器）。
// 2026-08-30 事故：音色市场的 6 个 useState 误放在 `if (draft === null) return null` 之后，
// 首渲染 9 hook → 次渲染 15 hook → React #310 "Rendered more hooks than during the previous render" → 设置面板空白。
// 本测试两遍渲染同一组件树，任何 hook 数漂移立即失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let current = null;
const fibersByPath = new Map();

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
  let fiber = fibersByPath.get(path.join('/'));
  if (!fiber) { fiber = { hooks: [], index: 0, effects: [] }; fibersByPath.set(path.join('/'), fiber); }
  current = fiber;
  fiber.index = 0;
  fiber.effects = [];
  const out = Comp(props);
  fiber.hookCount = fiber.index;
  current = null;
  return out;
}
function walk(node, path) {
  if (node == null || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, [...path, i])); return; }
  const { type, props } = node;
  if (typeof type === 'function') walk(renderAt(type, props, path), path);
  else if (type === react.Fragment) walk(props.children, path);
  else walk(props.children, path);
}

test('设置卡片两遍渲染 hook 数量一致（无 React #310）', () => {
  fibersByPath.clear();
  const effects = [];
  const boundScope = {
    getSnapshot: () => ({ value: { apiUrl: '', voices: [], defaultVoice: '', autoPlay: false, interruptOnNew: true, timeout: 30000, installDir: './x', voiceRegistryUrl: '' }, writable: true, base: {} }),
    subscribe: () => () => {}, set: async () => {}, unset: async () => {},
  };
  const registrations = [];
  const disposers = [];
  const ctx = {
    locale: { bind: () => (key) => key, register: () => {} },
    settingsScope: { bind: () => boundScope },
    slots: { inject: (n, fn) => fn(), register: (def, Comp) => { registrations.push({ def, Comp }); return () => {}; } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
  };
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let exportsObj = null;
  globalThis.window = { __ModuleLoader__: { load: (e) => { exportsObj = e.factory((name) => ({ 'react': react, 'react/jsx-runtime': jsxRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives })[name]); } } };
  globalThis.Audio = class { constructor() {} play() { return Promise.resolve(); } pause() {} addEventListener() {} load() {} };
  new Function('window', 'globalThis', src)(globalThis.window, globalThis);
  exportsObj.apply(ctx);
  const section = registrations.find((r) => r.def.name === 'settings.section');
  assert.ok(section, 'settings.section 已注册');
  const injected = section.def.inject();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ running: false }) });
  for (const d of disposers) { try { d(); } catch {} }

  const snapshotCounts = () => [...fibersByPath.entries()].map(([k, f]) => [k, f.hookCount]);
  // 第一遍：draft=null → TtsSettingsCard 提前 return
  walk(renderAt(section.Comp, { scope: injected.scope, t: (k) => k }, ['root']), ['root']);
  const first = snapshotCounts();
  // 执行 effects（draft 同步 → setDraft 更新 hook 值）
  for (const fiber of fibersByPath.values()) effects.push(...fiber.effects);
  for (const cb of effects) cb();
  // 第二遍：draft 已就绪 → 完整渲染
  walk(renderAt(section.Comp, { scope: injected.scope, t: (k) => k }, ['root']), ['root']);
  const second = snapshotCounts();
  const drifted = second.filter(([k, c]) => {
    const p = first.find(([k2]) => k2 === k);
    return p && p[1] !== c;
  });
  assert.deepEqual(drifted, [], '任何组件的 hook 数量跨渲染漂移 = React #310');
});
