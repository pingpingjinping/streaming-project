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
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
  }).outputText;
  vm.runInNewContext(code, {exports, require: name => deps[name] || require(name), ...globals});
  return exports;
}
const api = load('src/lib/playerFullscreen.ts');
const android = {userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/140', maxTouchPoints: 5};
const iphone = {userAgent: 'Mozilla/5.0 (iPhone) Safari/604', maxTouchPoints: 5};
test('Anissia auto-matched Anikoto iframe has the same sandbox policy as direct Anikoto', () => {
  const react = {
    useRef: value => ({current: value}),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useCallback: fn => fn,
    useEffect: () => {},
  };
  const {default: Player} = load('src/components/IframePlayer.tsx', {
    react, 'next/link': {}, 'lucide-react': {}, './SubtitleSelectModal': {},
    './PlayerSettingsModal': {DEFAULT_PLAYER_SETTINGS: {}},
    './usePlayerFullscreen': {usePlayerFullscreen: () => ({mode: 'inline', isFullscreen: false, toggleFullscreen() {}})},
    './useContainedPlayerFrame': {useContainedPlayerFrame() {}},
  });
  function findIframe(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'iframe') return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      const iframe = findIframe(child);
      if (iframe) return iframe;
    }
  }
  function render(animeId, sourceId) {
    return findIframe(Player({animeId, animeTitle: 'Test', episodeNumber: 1,
      embedUrl: 'https://video.example/embed/1',
      serverSources: sourceId ? [{id: sourceId, label: 'Video', player_url: 'https://video.example/embed/1'}] : [],
    })).props;
  }
  for (const animeId of ['ani_123', 'ak_test', 're_test']) {
    assert.equal(render(animeId, 'anikoto').sandbox, undefined);
    assert.equal(render(animeId, 'anikoto').allowFullScreen, true);
  }
  // Catalog IDs and labels alone must not remove restrictions for other embeds.
  for (const [animeId, sourceId] of [['ani_123', 'rean'], ['ak_test', 'rean'], ['ani_123', null], ['ak_test', null]]) {
    assert.equal(render(animeId, sourceId).sandbox, 'allow-scripts allow-same-origin allow-forms allow-presentation');
  }
});
test('web exit opacity persists all four levels including zero without disabling its hit target', () => {
  const saved=new Map(),style={innerHTML:''};
  const api=load('src/components/PlayerSettingsModal.tsx', {
    react:{},'react-dom':{},'lucide-react':{},
  }, {
    window:{},document:{getElementById:()=>style},
    localStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)},
    setTimeout:()=>1,clearTimeout:()=>{},
  });
  assert.equal(api.loadPlayerSettings().fullscreenExitOpacity,100);
  for(const value of [0,33,66,100]) {
    const settings={...api.DEFAULT_PLAYER_SETTINGS,fullscreenExitOpacity:value};
    api.savePlayerSettings(settings);
    const restored=api.loadPlayerSettings();
    assert.equal(restored.fullscreenExitOpacity,value);
    api.applyPlayerSettingsStyles(restored);
    const rule=style.innerHTML.match(/\.player-web-fullscreen-exit\s*\{([^}]+)\}/)[1];
    assert.match(rule,new RegExp(`opacity: ${value/100} !important`));
    assert.doesNotMatch(rule,/display|visibility|pointer-events/);
  }
  for(const value of [undefined,null,17,'0',-1]) {
    saved.set('anime_player_settings',JSON.stringify({fullscreenExitOpacity:value}));
    assert.equal(api.loadPlayerSettings().fullscreenExitOpacity,100);
  }
});
test('portrait fits the complete 16:9 frame by width; landscape fits by height', () => {
  for (const [width, height, expectedWidth, expectedHeight] of [
    [390, 700, 390, 219.375],
    [844, 390, 390 * 16 / 9, 390],
    [750, 369, 369 * 16 / 9, 369], // landscape safe-area padding removed
    [600, 500, 600, 337.5], // narrow landscape must still respect width
  ]) {
    const size = api.containedPlayerSize(width, height);
    assert.ok(Math.abs(size.width - expectedWidth) < 1e-8);
    assert.ok(Math.abs(size.height - expectedHeight) < 1e-8);
    assert.ok(size.width <= width + 1e-8 && size.height <= height + 1e-8);
    assert.ok(Math.abs(size.width / size.height - 16 / 9) < 1e-8);
  }
  assert.equal(api.containedPlayerSize(0, 800), null);
  assert.equal(api.containedPlayerSize(Infinity, 800), null);
});

test('contained frame follows rotation, browser-bar resize and safe area, then restores inline dimensions', () => {
  const window = Object.assign(new EventTarget(), {visualViewport: new EventTarget()});
  const container = {clientWidth: 390, clientHeight: 700};
  const frame = {style: {width: '', height: ''}};
  let padding = {paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px'};
  let observer, cleanup;
  class ResizeObserver {
    constructor(callback) {this.callback = callback; observer = this;}
    observe(node) {assert.equal(node, container);}
    disconnect() {this.disconnected = true;}
  }
  const {useContainedPlayerFrame} = load('src/components/useContainedPlayerFrame.ts', {
    react: {useLayoutEffect(callback) {cleanup = callback();}}, '@/lib/playerFullscreen': api,
  }, {window, ResizeObserver, getComputedStyle: () => padding});
  const outer = {current: container}, media = {current: frame};
  useContainedPlayerFrame(outer, media, true);
  assert.equal(frame.style.width, '390px');
  assert.equal(frame.style.height, '219.375px');
  Object.assign(container, {clientWidth: 844, clientHeight: 390});
  padding = {paddingLeft: '47px', paddingRight: '47px', paddingTop: '0px', paddingBottom: '21px'};
  window.dispatchEvent(new Event('resize'));
  assert.equal(parseFloat(frame.style.height), 369);
  assert.ok(parseFloat(frame.style.width) < 750);
  container.clientHeight = 340;
  window.visualViewport.dispatchEvent(new Event('resize'));
  assert.equal(parseFloat(frame.style.height), 319);
  container.clientHeight = 390;
  observer.callback();
  assert.equal(parseFloat(frame.style.height), 369);
  cleanup();
  assert.equal(observer.disconnected, true);
  assert.deepEqual(frame.style, {width: '', height: ''});
  container.clientWidth = 300;
  window.dispatchEvent(new Event('resize'));
  assert.deepEqual(frame.style, {width: '', height: ''});
  useContainedPlayerFrame(outer, media, false);
  assert.equal(cleanup, undefined);
});
test('web fullscreen covers the visible Safari viewport, follows offset/rotation and restores styles', () => {
  const viewport = Object.assign(new EventTarget(), {width: 390, height: 700, offsetLeft: 0, offsetTop: 24});
  const window = Object.assign(new EventTarget(), {visualViewport: viewport, innerWidth: 390, innerHeight: 844});
  const initial = {width: '', height: '', top: '', left: '', right: '', bottom: ''};
  const container = {style: {...initial},
    get clientWidth() {return parseFloat(this.style.width) || window.innerWidth;},
    get clientHeight() {return parseFloat(this.style.height) || window.innerHeight;},
  };
  const frame = {style: {width: '', height: ''}};
  let cleanup;
  const {useContainedPlayerFrame} = load('src/components/useContainedPlayerFrame.ts', {
    react: {useLayoutEffect(callback) {cleanup = callback();}}, '@/lib/playerFullscreen': api,
  }, {window, getComputedStyle: () => ({paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px'})});
  useContainedPlayerFrame({current: container}, {current: frame}, true, true);
  assert.deepEqual(container.style, {width: '390px', height: '700px', top: '24px', left: '0px', right: 'auto', bottom: 'auto'});
  assert.equal(frame.style.height, '219.375px');
  viewport.offsetTop = 0;
  viewport.dispatchEvent(new Event('scroll'));
  assert.equal(container.style.top, '0px');
  Object.assign(viewport, {width: 844, height: 390, offsetTop: 0, offsetLeft: 3});
  window.dispatchEvent(new Event('orientationchange'));
  assert.equal(container.style.width, '844px');
  assert.equal(container.style.height, '390px');
  assert.equal(container.style.left, '3px');
  assert.equal(frame.style.height, '390px');
  assert.ok(Math.abs(parseFloat(frame.style.width) - 390 * 16 / 9) < 1e-8);
  viewport.height = 340;
  viewport.dispatchEvent(new Event('resize'));
  assert.equal(frame.style.height, '340px');
  cleanup();
  assert.deepEqual(container.style, initial);
  assert.deepEqual(frame.style, {width: '', height: ''});
  viewport.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('orientationchange'));
  assert.deepEqual(container.style, initial);
});

test('missing VisualViewport uses window size only in web mode; native fullscreen keeps browser sizing', () => {
  const window = Object.assign(new EventTarget(), {innerWidth: 844, innerHeight: 390});
  const initial = {width: '', height: '', top: '', left: '', right: '', bottom: ''};
  const container = {style: {...initial}, clientWidth: 844, clientHeight: 390};
  const frame = {style: {width: '', height: ''}};
  let cleanup;
  const {useContainedPlayerFrame} = load('src/components/useContainedPlayerFrame.ts', {
    react: {useLayoutEffect(callback) {cleanup = callback();}}, '@/lib/playerFullscreen': api,
  }, {window, getComputedStyle: () => ({paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0'})});
  const refs = [{current: container}, {current: frame}];
  useContainedPlayerFrame(...refs, true, true);
  assert.equal(container.style.height, '390px');
  assert.equal(container.style.top, '0px');
  cleanup();
  useContainedPlayerFrame(...refs, true, false);
  assert.deepEqual(container.style, initial);
  assert.equal(frame.style.height, '390px');
  cleanup();
});

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


test('libass fullscreen resize keeps the current frame until the replacement size is ready', () => {
  const src = fs.readFileSync(path.join(root, 'public/libass/subtitles-octopus.js'), 'utf8');
  assert.match(src, /var effectiveWidth = self\.pendingCanvasWidth \|\| self\.canvas\.width/);
  assert.match(src, /var effectiveHeight = self\.pendingCanvasHeight \|\| self\.canvas\.height/);
  assert.match(src, /var canvasSizeChanged = effectiveWidth !== width \|\| effectiveHeight !== height/);
  assert.match(src, /if \(self\.lastRenderTime > 0\) \{\s*self\.pendingCanvasWidth = width;\s*self\.pendingCanvasHeight = height;/);
  assert.match(src, /self\.setCurrentTime\(self\.video\.currentTime \+ self\.timeOffset\)/);
  assert.match(src, /clearTimeout\(self\.resizeTimer\)/);
  assert.doesNotMatch(src, /self\.resize\(\);\s*setTimeout\(self\.resize, 100\)/);
});

test('ASS subtitle sharpness is shown beside fullscreen exit opacity and applies in both players', () => {
  const src = fs.readFileSync(path.join(root, 'src/components/Player.tsx'), 'utf8');
  const iframe = fs.readFileSync(path.join(root, 'src/components/IframePlayer.tsx'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'src/components/PlayerSettingsModal.tsx'), 'utf8');
  assert.match(settings, /subtitleSharpness:\s*1 \| 1\.25 \| 1\.5 \| 2/);
  assert.match(settings, /subtitleSharpness:\s*1,/);
  assert.match(settings, /종료 버튼 투명도[\s\S]*?자막 선명도[\s\S]*?!fullscreenExitOnly/);
  assert.match(settings, /\(\[1, 1\.25, 1\.5, 2\] as const\)/);
  assert.match(src, /prescaleFactor:\s*playerSettingsRef\.current\.subtitleSharpness \|\| 1/);
  assert.match(src, /sharpnessChanged[\s\S]*?applySubtitleRef\.current\(activeSub, currentSyncOffsetRef\.current\)/);
  assert.doesNotMatch(src, /name:\s*"subtitleSharpness"/);
  assert.match(iframe, /const sharpness = playerSettings\.subtitleSharpness \|\| 1/);
  assert.match(iframe, /Math\.round\(w \* sharpness\)/);
  assert.match(
    iframe,
    /const syncOctopusCanvasSize = \(\) => \{[\s\S]*?const renderW = Math\.max\(1, Math\.round\(w \* sharpness\)\)[\s\S]*?octopusRef\.current\?\.resize\(renderW, renderH\)/
  );
  assert.match(
    iframe,
    /syncOctopusCanvasSize[\s\S]*?setCurrentTime\?\.\(lastCurrentTimeRef\.current \+ syncOffsetRef\.current\)/
  );
  assert.match(iframe, /playerSettings\.subtitleSharpness,[\s\S]*?\]\);/);
});


test('libass resize burst renders immediately and once after Safari/fullscreen layout settles', () => {
  const src = fs.readFileSync(path.join(root, 'public/libass/subtitles-octopus.js'), 'utf8');
  assert.match(src, /var resizeImmediately = self\.resizeTimer === null/);
  assert.match(src, /if \(resizeImmediately\) \{\s*self\.resize\(\);\s*\}/);
  assert.match(src, /self\.resizeTimer = setTimeout\(function \(\) \{[\s\S]*?self\.resize\(\);[\s\S]*?\}, 180\)/);
});

test('playback resume handles refresh after metadata already fired and preserves partial episodes', () => {
  const src = fs.readFileSync(path.join(root, 'src/components/Player.tsx'), 'utf8');
  assert.match(src, /video\.readyState >= 1/);
  assert.match(src, /restorePlaybackWhenReady\(savedSec, false\)/);
  assert.match(src, /restorePlaybackWhenReady\(cloudSec, true\)/);
  assert.match(src, /const prevCompleted =[\s\S]*?prevSec >= prevDur - 15/);
  assert.match(src, /syncHistoryRef\.current\(prevCompleted\)/);
  assert.doesNotMatch(src, /현재 에피소드 시청 완료 기록 및 로컬 캐시 정리/);
});


test('libass keeps the old frame until a forced resize frame is ready', () => {
  const src = fs.readFileSync(path.join(root, 'public/libass/subtitles-octopus.js'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'public/libass/subtitles-octopus-worker.js'), 'utf8');
  assert.match(src, /self\.pendingCanvasWidth = 0/);
  assert.match(src, /if \(self\.lastRenderTime > 0\) \{\s*self\.pendingCanvasWidth = width;\s*self\.pendingCanvasHeight = height;/);
  assert.match(src, /function applyPendingCanvasSize\(\)/);
  assert.match(src, /forceRender: true/);
  assert.match(worker, /self\.getRenderMethod\(\)\(message\.data\.forceRender===true\)/);
  assert.doesNotMatch(src, /hasResizeSnapshot|bufferCanvasCtx\.drawImage\(self\.canvas/);
});
