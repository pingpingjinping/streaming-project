const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const ts = require('typescript');
const root = path.join(__dirname, '..');
function load(file, deps = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(code, {exports, require: name => deps[name] || require(name), ...globals});
  return exports;
}
const api = load('src/lib/playerFullscreen.ts');
const android = {userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/140', maxTouchPoints: 5};
const iphone = {userAgent: 'Mozilla/5.0 (iPhone) Safari/604', maxTouchPoints: 5};
test('iPhone and desktop-mode iPad preserve overlays without requesting video/native fullscreen', async () => {
  let called = 0;
  const container = {requestFullscreen() {called++;}};
  for (const nav of [iphone, {userAgent: 'Mozilla/5.0 (Macintosh) Safari', maxTouchPoints: 5}]) {
    assert.equal(await api.requestPlayerFullscreen(container, nav), 'web');
  }
  assert.equal(called, 0);
  assert.equal(api.isAppleTouchDevice({userAgent: 'Mozilla/5.0 (Macintosh) Safari', maxTouchPoints: 0}), false);
});
test('Android expands the video/subtitle container and binds the native API receiver', async () => {
  const container = {async requestFullscreen() {assert.equal(this, container);}};
  assert.equal(await api.requestPlayerFullscreen(container, android), 'native');
});
test('missing API or denied iframe user activation falls back to web mode', async () => {
  assert.equal(await api.requestPlayerFullscreen({}, android), 'web');
  assert.equal(await api.requestPlayerFullscreen({requestFullscreen() {throw Error('NotAllowedError');}}, android), 'web');
});
test('prefixed Safari API and native exit are supported without calling video-only APIs', async () => {
  let exited = 0;
  const container = {webkitRequestFullscreen() {assert.equal(this, container);}};
  assert.equal(await api.requestPlayerFullscreen(container, android), 'native');
  const doc = {webkitFullscreenElement: container, webkitExitFullscreen() {assert.equal(this, doc); exited++;}};
  await api.exitPlayerFullscreen(doc);
  await api.exitPlayerFullscreen({exitFullscreen() {throw Error('should not exit inline');}});
  assert.equal(exited, 1);
});

// Exercise hook lifecycle and real event dispatch without a browser/device UA shim.
function harness(nav = android) {
  const document = Object.assign(new EventTarget(), {fullscreenElement: null, body: {style: {overflow: 'scroll'}}});
  const window = new EventTarget();
  const slots = [], pending = [];
  let index = 0, value;
  const changed = (a, b) => !a || a.length !== b.length || a.some((v, i) => v !== b[i]);
  const react = {
    useRef(initial) {const i = index++; return slots[i] ||= {current: initial};},
    useState(initial) {const i = index++; if (!(i in slots)) slots[i] = {value: initial};
      return [slots[i].value, next => {slots[i].value = next;}];},
    useCallback(fn, deps) {const i = index++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = {fn, deps}; return slots[i].fn;},
    useEffect(fn, deps) {const i = index++; if (!slots[i] || changed(slots[i].deps, deps)) pending.push(() => {
      slots[i]?.cleanup?.(); slots[i] = {deps, cleanup: fn()};
    });},
  };
  const container = {async requestFullscreen() {
    document.fullscreenElement = container;
    document.dispatchEvent(new Event('fullscreenchange'));
  }};
  document.exitFullscreen = async () => {document.fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange'));};
  const ref = {current: container};
  const {usePlayerFullscreen} = load('src/components/usePlayerFullscreen.ts', {react, '@/lib/playerFullscreen': api}, {document, window, navigator: nav});
  function render() {index = 0; value = usePlayerFullscreen(ref); pending.splice(0).forEach(fn => fn()); return value;}
  return {document, window, container, render, unmount() {slots.forEach(slot => slot?.cleanup?.());}};
}
test('Android browser back/exit clears native state; resizing cannot keep fullscreen stuck', async () => {
  const h = harness();
  await h.render().toggleFullscreen();
  assert.equal(h.render().mode, 'native');
  await h.document.exitFullscreen();
  h.window.dispatchEvent(new Event('resize'));
  assert.equal(h.render().mode, 'inline');
  assert.equal(h.document.body.style.overflow, 'scroll');
  h.unmount();
});
test('iPhone web mode survives rerender/resize and restores scroll on Escape or unmount', async () => {
  const h = harness(iphone);
  await h.render().toggleFullscreen();
  assert.equal(h.render().mode, 'web');
  assert.equal(h.document.body.style.overflow, 'hidden');
  h.window.dispatchEvent(new Event('resize'));
  h.document.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(h.render().mode, 'web');
  assert.equal(h.document.body.style.overflow, 'hidden');
  const escape = Object.assign(new Event('keydown'), {key: 'Escape'});
  h.window.dispatchEvent(escape);
  assert.equal(h.render().mode, 'inline');
  assert.equal(h.document.body.style.overflow, 'scroll');
  await h.render().toggleFullscreen(); h.render(); h.unmount();
  assert.equal(h.document.body.style.overflow, 'scroll');
});
test('double click while entering does not start two fullscreen requests', async () => {
  const h = harness();
  let requests = 0, resolve;
  h.container.requestFullscreen = () => {requests++; return new Promise(r => {resolve = r;});};
  const toggle = h.render().toggleFullscreen;
  const first = toggle(); const second = toggle();
  assert.equal(requests, 1);
  h.document.fullscreenElement = h.container;
  resolve(); await Promise.all([first, second]);
  assert.equal(h.render().mode, 'native');
  await h.render().toggleFullscreen(); assert.equal(h.render().mode, 'inline'); h.unmount();
});
