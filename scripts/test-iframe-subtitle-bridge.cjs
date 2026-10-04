const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict'), {test} = require('node:test');
const root = path.join(__dirname, '..');
function load(file) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText, {exports, setTimeout, clearTimeout, Date});
  return exports;
}
const {IframeSubtitleBridge, nativeSubtitleVtt, SUBTITLE_BRIDGE} = load('src/lib/iframeSubtitleBridge.ts');
const payload = {enabled: true, label: '선택 자막', offset: 3, cues: [{start: 5, end: 8, text: '안녕 <i> &\n두 줄'}]};
function bridgeHarness() {
  const posts = [], updates = [];
  const target = {postMessage(data, origin) {posts.push({data, origin});}};
  const origin = 'https://player.example';
  const bridge = new IframeSubtitleBridge(target, origin, 'session-0123456789', state => updates.push(state));
  const receive = (type, extra = {}, overrides = {}) => bridge.receive({source: target, origin, data: {bridge: SUBTITLE_BRIDGE, session: bridge.session, type, ...extra}, ...overrides});
  return {bridge, posts, updates, target, origin, receive};
}
test('native VTT applies the HUD offset once, clips negative times, preserves top cues and escapes markup', () => {
  const result = nativeSubtitleVtt({...payload, cues: [...payload.cues,
    {start: 1, end: 5, text: '상단', isTop: true}, {start: 0, end: 2, text: '이미 지난 대사'},
    {start: NaN, end: 5, text: '잘못된 시간'}]});
  assert.equal(result.count, 2);
  assert.match(result.vtt, /00:00:02\.000 --> 00:00:05\.000 line:93%/);
  assert.match(result.vtt, /안녕 &lt;i&gt; &amp;\n두 줄/);
  assert.match(result.vtt, /00:00:00\.000 --> 00:00:02\.000 line:5%/);
  assert.equal(nativeSubtitleVtt({...payload, enabled: false}).count, 0);
  assert.match(nativeSubtitleVtt({...payload, offset: -2}).vtt, /00:00:07\.000 --> 00:00:10\.000/);
});
test('host ignores another frame, origin or session before sending any selected subtitles', () => {
  const h = bridgeHarness(); h.bridge.setSubtitle(payload); h.bridge.probe();
  assert.equal(h.posts.length, 1); assert.equal(h.posts[0].data.type, 'connect');
  assert.equal(h.receive('connected', {nativeSupported: true}, {origin: 'https://evil.example'}), false);
  assert.equal(h.receive('connected', {}, {source: {}}), false);
  assert.equal(h.receive('connected', {}, {data: {bridge: SUBTITLE_BRIDGE, session: 'old-session', type: 'connected'}}), false);
  assert.equal(h.posts.length, 1); assert.equal(h.bridge.state.connected, false); h.bridge.dispose();
});
test('only selected subtitle data is sent; stale ACKs cannot enable native fullscreen after a subtitle/sync change', async () => {
  const h = bridgeHarness(); h.bridge.setSubtitle(payload);
  h.receive('connected', {nativeSupported: true});
  const first = h.posts.at(-1); assert.equal(first.origin, h.origin); assert.match(first.data.vtt, /안녕/);
  assert.equal(await h.bridge.requestFullscreen(), false);
  h.receive('applied', {revision: h.bridge.revision}); assert.equal(h.bridge.state.applied, true);
  h.bridge.setSubtitle({...payload, label: '다른 자막', cues: [{start: 10, end: 12, text: '새 대사'}], offset: 0});
  h.receive('applied', {revision: first.data.revision}); assert.equal(h.bridge.state.applied, false);
  assert.doesNotMatch(h.posts.at(-1).data.vtt, /안녕/); assert.match(h.posts.at(-1).data.vtt, /새 대사/);
  h.receive('failed', {revision: h.bridge.revision}); assert.equal(h.bridge.state.error, true);
  h.receive('applied', {revision: h.bridge.revision}); assert.equal(h.bridge.state.error, false); h.bridge.dispose();
});
test('reloading the same iframe republishes the current selected subtitle instead of trusting an old ACK', () => {
  const h = bridgeHarness(); h.bridge.setSubtitle(payload); h.receive('connected', {nativeSupported: true, revision: -1});
  h.receive('applied', {revision: h.bridge.revision}); const before = h.posts.length;
  h.receive('connected', {nativeSupported: true, revision: -1});
  assert.equal(h.posts.length, before + 1); assert.equal(h.posts.at(-1).data.type, 'subtitle');
  h.receive('pending', {revision: h.bridge.revision}); assert.equal(h.bridge.state.applied, false); h.bridge.dispose();
});
test('a closed iframe command fails safely and dispose does not leave pending requests', async () => {
  const h = bridgeHarness(); h.bridge.setSubtitle(payload); h.receive('connected', {nativeSupported: true});
  h.receive('applied', {revision: h.bridge.revision}); h.target.postMessage = () => {throw Error('closed window');};
  assert.equal(await h.bridge.requestFullscreen(), false); h.bridge.dispose();
});
test('native request/response, subtitle OFF, disconnect and pending command cancellation retain the safe fallback', async () => {
  const h = bridgeHarness(); h.bridge.setSubtitle(payload); h.receive('connected', {nativeSupported: true});
  h.receive('applied', {revision: h.bridge.revision});
  const requested = h.bridge.requestFullscreen(); const command = h.posts.at(-1).data;
  h.receive('fullscreenResult', {requestId: command.requestId, success: true}); assert.equal(await requested, true);
  h.receive('fullscreen', {active: true}); assert.equal(h.bridge.state.nativeFullscreen, true);
  h.bridge.setSubtitle({...payload, enabled: false}); assert.equal(h.posts.at(-1).data.count, 0);
  h.receive('applied', {revision: h.bridge.revision});
  const exit = h.bridge.requestFullscreen(); h.bridge.dispose(); assert.equal(await exit, false);
  assert.equal(h.posts.at(-1).data.type, 'disconnect');
});

const script = fs.readFileSync(path.join(root, 'public/userscripts/walnutpi-native-subtitles.user.js'), 'utf8');
function frameHarness({nativeThrows = false, ownControls = true, topLevel = false, userAgent = "Mozilla/5.0 (iPhone) Safari"} = {}) {
  let now = 10000, id = 0;
  const timers = new Map(), intervals = new Map(), posts = [], blobs = new Map(), revoked = [];
  const fakeSetTimeout = (fn, delay) => {const key = ++id; timers.set(key, {fn, due: now + delay}); return key;};
  const fakeClearTimeout = key => timers.delete(key);
  class Element extends EventTarget {
    constructor(tag) {super(); this.tag = tag; this.style = {}; this.attrs = {}; this.removed = false;}
    setAttribute(key, value) {this.attrs[key] = value;}
    remove() {this.removed = true; if (this.tag === 'track') video.textTracks = video.textTracks.filter(track => track !== this.track);}
  }
  const video = new Element('video');
  Object.assign(video, {paused: false, ended: false, webkitDisplayingFullscreen: false,
    getBoundingClientRect: () => ({width: 1280, height: 720}), textTracks: [{mode: 'showing', label: '원래 트랙'}],
    webkitEnterFullscreen() {if (nativeThrows) throw Error('UserGestureRequired'); this.webkitDisplayingFullscreen = true; this.dispatchEvent(new Event('webkitbeginfullscreen'));},
    webkitExitFullscreen() {this.webkitDisplayingFullscreen = false; this.dispatchEvent(new Event('webkitendfullscreen'));},
    appendChild(element) {if (element.tag === 'track') {video.textTracks.push(element.track); tracks.push(element);}},
  });
  const tracks = [], created = [], document = new EventTarget();
  Object.assign(document, {documentElement: {}, fullscreenElement: null,
    body: {appendChild(element) {created.push(element);}},
    querySelectorAll: () => [video], querySelector: () => ownControls ? {} : null,
    createElement(tag) {const element = new Element(tag); if (tag === 'track') element.track = {mode: 'disabled', cues: []}; created.push(element); return element;},
  });
  const parent = {postMessage(data, origin) {posts.push({data, origin});}};
  const window = new EventTarget(); Object.assign(window, {parent, top: topLevel ? window : parent});
  const FakeURL = class extends URL {
    static createObjectURL(blob) {const url = `blob:https://player.example/${blobs.size}`; blobs.set(url, blob); return url;}
    static revokeObjectURL(url) {revoked.push(url);}
  };
  vm.runInNewContext(script, {window, document, navigator: {userAgent, maxTouchPoints: 5}, URL: FakeURL, Blob, MutationObserver: class {observe(){} disconnect(){}},
    getComputedStyle: () => ({visibility: 'visible'}), Date: {now: () => now},
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    setInterval(fn) {const key = ++id; intervals.set(key, fn); return key;}, clearInterval(key) {intervals.delete(key);},
  });
  const session = 'trusted-session-0123456789';
  function receive(type, extra = {}, {origin = 'https://yjhmoon.iptime.org', source = parent} = {}) {
    window.dispatchEvent(Object.assign(new Event('message'), {source, origin, data: {bridge: SUBTITLE_BRIDGE, session, type, ...extra}}));
  }
  function subtitle(revision = 1, extra = {}) {receive('subtitle', {revision, enabled: true, label: '선택한 자막', vtt: 'WEBVTT\n\n00:00:02.000 --> 00:00:05.000\n대사\n', count: 1, ...extra});}
  function loaded(element = tracks.at(-1)) {element.track.cues = [{text: '대사'}]; element.readyState = 2; element.dispatchEvent(new Event('load'));}
  return {window, document, parent, posts, video, tracks, created, blobs, revoked, receive, subtitle, loaded,
    advance(ms) {now += ms; for (const [key, timer] of [...timers]) if (timer.due <= now) {timers.delete(key); timer.fn();}},
    maintain(ms) {now += ms; [...intervals.values()].forEach(fn => fn());},
    replaceVideo() {
      const next = new Element('video');
      Object.assign(next, {paused: false, ended: false, webkitDisplayingFullscreen: false,
        getBoundingClientRect: video.getBoundingClientRect, textTracks: [],
        webkitEnterFullscreen: video.webkitEnterFullscreen, webkitExitFullscreen: video.webkitExitFullscreen,
        appendChild(element) {next.textTracks.push(element.track); tracks.push(element);},
      });
      document.querySelectorAll = () => [next];
      [...intervals.values()].forEach(fn => fn());
      return next;
    },
    close() {window.dispatchEvent(new Event('pagehide'));},
  };
}
test('userscript makes no video/DOM changes on unrelated sites or top-level pages', () => {
  const h = frameHarness();
  h.receive('connect', {}, {origin: 'https://yjhmoon.iptime.org.evil.example'});
  h.receive('connect', {}, {origin: 'https://evil.example'});
  h.receive('connect', {}, {source: {}}); h.subtitle();
  assert.equal(h.created.length, 0); assert.equal(h.posts.length, 0); assert.equal(h.video.textTracks.length, 1); h.close();
  const top = frameHarness({topLevel: true}); top.receive('connect'); assert.equal(top.posts.length, 0); top.close();
  const android = frameHarness({userAgent: 'Mozilla/5.0 (Linux; Android) Chrome'}); android.receive('connect');
  assert.equal(android.posts.length, 0); assert.equal(android.created.length, 0); android.close();
});
test('userscript ACK requires loaded native cues, hides inline duplicates and shows captions in actual video fullscreen', async () => {
  const h = frameHarness(); h.receive('connect'); h.subtitle();
  assert.equal(h.tracks.length, 1); assert.equal(h.tracks[0].track.mode, 'hidden');
  assert.equal(h.posts.some(item => item.data.type === 'applied'), false);
  h.loaded(); assert.equal(h.posts.at(-1).data.type, 'applied');
  h.receive('toggleFullscreen', {revision: 1, requestId: 9}); await Promise.resolve();
  assert.equal(h.video.webkitDisplayingFullscreen, true); assert.equal(h.tracks[0].track.mode, 'showing');
  assert.equal(h.video.textTracks[0].mode, 'hidden');
  assert.equal(h.posts.at(-1).data.type, 'fullscreenResult'); assert.equal(h.posts.at(-1).data.success, true);
  h.video.webkitExitFullscreen(); assert.equal(h.tracks[0].track.mode, 'hidden'); assert.equal(h.video.textTracks[0].mode, 'showing');
  h.close(); assert.equal(h.video.textTracks.length, 1); assert.equal(h.revoked.length, 1);
});
test('subtitle changes, stale loads, OFF and iframe video replacement cannot retain previous native cues', () => {
  const h = frameHarness(); h.receive('connect'); h.subtitle(1); const old = h.tracks[0];
  h.subtitle(2, {vtt: 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\n새 대사\n'});
  assert.equal(old.removed, true); h.loaded(old);
  assert.equal(h.posts.some(item => item.data.type === 'applied' && item.data.revision === 1), false);
  h.loaded(); assert.equal(h.posts.at(-1).data.revision, 2);
  h.subtitle(1); assert.equal(h.tracks.length, 2);
  const replacement = h.replaceVideo();
  assert.equal(h.tracks[1].removed, true); assert.equal(h.video.textTracks.length, 1);
  assert.equal(h.tracks.length, 3); h.loaded();
  assert.equal(replacement.textTracks[0].mode, 'hidden');
  h.subtitle(3, {enabled: false, count: 0, vtt: 'WEBVTT\n'});
  assert.equal(replacement.textTracks[0].mode, 'disabled'); assert.equal(h.posts.at(-1).data.type, 'applied');
  h.close();
});
test('native denial returns failure for web fallback; failed track loading never enables native success', async () => {
  const h = frameHarness({nativeThrows: true}); h.receive('connect'); h.subtitle(); h.loaded();
  h.receive('toggleFullscreen', {revision: 1, requestId: 5}); await Promise.resolve();
  assert.equal(h.posts.at(-1).data.success, false); assert.equal(h.video.webkitDisplayingFullscreen, false); h.close();
  const failed = frameHarness(); failed.receive('connect'); failed.subtitle(); failed.tracks[0].dispatchEvent(new Event('error'));
  assert.equal(failed.posts.at(-1).data.type, 'failed');
  failed.receive('toggleFullscreen', {revision: 1, requestId: 8}); await Promise.resolve();
  assert.equal(failed.posts.at(-1).data.success, false); failed.close();
});
test('userscript native button appears only on a connected video and hides/reappears on actual iframe touch', () => {
  const h = frameHarness({ownControls: false}); h.receive('connect'); h.subtitle(); h.loaded();
  const button = h.created.find(item => item.tag === 'button'); assert.ok(button); assert.equal(button.style.opacity, '1');
  h.advance(3500); assert.equal(button.style.opacity, '0'); assert.equal(button.style.pointerEvents, 'none');
  h.document.dispatchEvent(new Event('touchstart')); assert.equal(button.style.opacity, '1');
  h.maintain(9000); assert.equal(button.removed, true); assert.equal(h.video.textTracks.length, 1); h.close();
});
