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
  vm.runInNewContext(code, {exports, require: name => name === '@/lib/providerSubtitlePolicy' ? load('src/lib/providerSubtitlePolicy.ts') : name === './VideoServerSelect' ? {default:'VideoServerSelect'}
    : name === '@/lib/subtitleSrt' ? load('src/lib/subtitleSrt.ts') : deps[name] || require(name), ...globals});
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
    './PlayerSettingsModal': {DEFAULT_PLAYER_SETTINGS: {}, getSubtitleOffsetPercent:()=>0,getSubtitleBottomPercent:()=>8},
    './SponsorSubtitleSyncModal': {default:()=>null},
    '@/lib/sponsorSubtitleSync': {effectiveSubtitleOffset:(v)=>v, formatSyncTime:()=>''},
    './usePlayerFullscreen': {usePlayerFullscreen: () => ({mode: 'inline', isFullscreen: false, toggleFullscreen() {}})},
    './useContainedPlayerFrame': {useContainedPlayerFrame() {}},
    '@/lib/iframePlayback': load('src/lib/iframePlayback.ts'),
    '@/lib/subtitlePresentation': load('src/lib/subtitlePresentation.ts'),
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

test('Anikoto aspect uses explicit DAR/SAR before the narrow-video 4:3 heuristic', () => {
  const infer=load('src/lib/iframePlayback.ts').aspectFromPlayerMessage;
  assert.equal(infer({videoWidth:640,videoHeight:480}),4/3);
  assert.equal(infer({videoWidth:1920,videoHeight:1080}),16/9);
  assert.equal(infer({displayAspectRatio:'4:3'}),4/3);
  assert.equal(infer({dar:'16:9',videoWidth:720,videoHeight:480}),16/9);
  assert.equal(infer({videoWidth:720,videoHeight:480,sampleAspectRatio:'8:9'}),4/3);
  assert.equal(infer({videoWidth:720,videoHeight:480}),4/3);
  assert.equal(infer({videoWidth:960,videoHeight:600}),4/3);
  assert.equal(infer({videoWidth:961,videoHeight:600}),null);
  assert.equal(infer({videoWidth:854,videoHeight:480}),16/9);
  assert.equal(infer({videoWidth:2520,videoHeight:1080}),21/9);
  assert.equal(infer({dar:'21:9',videoWidth:720,videoHeight:480}),21/9);
  assert.equal(infer({videoWidth:720,videoHeight:480,sampleAspectRatio:'32:27'}),16/9);
  assert.equal(infer({width:720,height:480}),null);
  assert.equal(infer({displayAspectRatio:'3:2',videoWidth:640,videoHeight:480}),3/2);
  assert.equal(infer({videoWidth:0,videoHeight:480}),null);
  assert.equal(infer({videoWidth:720,videoHeight:480,sampleAspectRatio:'1:1'}),3/2);
  assert.equal(infer({videoWidth:Infinity,videoHeight:480}),null);
  assert.equal(infer({currentTime:20,paused:false}),null);
  assert.equal(infer(null),null);
});

test('Anikoto 4:3 fullscreen consumes height instead of adding black bars; default 16:9 and rotation remain unchanged', () => {
  const win=Object.assign(new EventTarget(),{visualViewport:new EventTarget()});
  const container={clientWidth:2944,clientHeight:1840};
  const frame={style:{width:'',height:''}};let cleanup;
  const {useContainedPlayerFrame}=load('src/components/useContainedPlayerFrame.ts',{
    react:{useLayoutEffect(fn){cleanup=fn();}},'@/lib/playerFullscreen':api,
  },{window:win,getComputedStyle:()=>({paddingLeft:'0',paddingRight:'0',paddingTop:'0',paddingBottom:'0'})});
  const c={current:container},f={current:frame};
  useContainedPlayerFrame(c,f,true,false,false,16/9,16/9);
  assert.ok(Math.abs(parseFloat(frame.style.height)-1656)<1e-6,'original 16:9 preserves its bars');
  cleanup();
  useContainedPlayerFrame(c,f,true,false,false,4/3,4/3);
  assert.ok(Math.abs(parseFloat(frame.style.height)-1840)<1e-6,'4:3 frame reaches both vertical edges');
  assert.ok(Math.abs(parseFloat(frame.style.width)-1840*4/3)<1e-6);
  container.clientWidth=390;container.clientHeight=700;
  win.dispatchEvent(new Event('resize'));
  assert.equal(frame.style.width,'390px');
  assert.equal(frame.style.height,'292.5px');
  cleanup();assert.deepEqual(frame.style,{width:'',height:''});
  const jsx=fs.readFileSync(path.join(root,'src/components/IframePlayer.tsx'),'utf8');
  assert.match(jsx,/const reanimeManualAspect = isReAnimeEmbed && aspectChoice !== "auto"/);
  assert.match(jsx,/const frameAspect = reanimeManualAspect \|\| \(isAnikotoEmbed && \(!appleWebFullscreen \|\| manualUltrawide\)\)/);
  assert.match(jsx,/iframeRef.*useRef|const iframeRef/);
  assert.match(jsx,/const manualUltrawide = aspectChoice === "21:9"/);
  assert.match(jsx,/const inlineAspectStyle = manualUltrawide/);
  assert.match(jsx,/manualUltrawide \? 21 \/ 9/);
  assert.match(jsx,/title="영상 비율 변경/);
  assert.match(jsx,/\{hasAspectControl && \(/);
  assert.match(jsx,/const hasAspectControl = isAnikotoEmbed \|\| isReAnimeEmbed/);
  assert.match(jsx,/activeServerSources\.find\(source => source\.key === activeServerKey\)\?\.id/);
  assert.match(jsx,/if \(!isAnikotoEmbed\) return;/, 'automatic iframe ratio hints stay Anikoto-only');
  assert.equal((jsx.match(/aria-label="화면 비율 변경"/g)||[]).length,1,
    'aspect setting must exist only in the toolbar below the video, not as a fullscreen overlay');
  assert.doesNotMatch(jsx,/\{isAnikotoEmbed && isFullscreen && \(/,
    'fullscreen must not reintroduce its own persistent aspect indicator');
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

test('iPhone portrait fits a width-filling 4:3 picture, rotates back to legacy landscape and restores the page', () => {
  const viewport=Object.assign(new EventTarget(),{width:390,height:700,offsetLeft:0,offsetTop:24});
  const window=Object.assign(new EventTarget(),{visualViewport:viewport,innerWidth:390,innerHeight:844});
  const initial={width:'',height:'',top:'',left:'',right:'',bottom:''};
  const container={style:{...initial},
    get clientWidth(){return parseFloat(this.style.width)||window.innerWidth;},
    get clientHeight(){return parseFloat(this.style.height)||window.innerHeight;},
  };
  const frame={style:{width:'',height:''}};
  let cleanup,padding={paddingLeft:'0',paddingRight:'0',paddingTop:'0',paddingBottom:'0'};
  const {useContainedPlayerFrame}=load('src/components/useContainedPlayerFrame.ts',{
    react:{useLayoutEffect(fn){cleanup=fn();}},'@/lib/playerFullscreen':api,
  },{window,getComputedStyle:()=>padding});
  useContainedPlayerFrame({current:container},{current:frame},true,true,false,4/3);
  assert.equal(frame.style.width,'390px');assert.equal(frame.style.height,'292.5px');
  const widePicture=api.containedPlayerSize(390,292.5,16/9);
  assert.equal(widePicture.width,390);assert.equal(widePicture.height,219.375);
  viewport.height=600;viewport.dispatchEvent(new Event('resize'));
  assert.equal(frame.style.height,'292.5px');
  Object.assign(viewport,{width:844,height:390,offsetTop:0});
  padding={paddingLeft:'47px',paddingRight:'47px',paddingTop:'0',paddingBottom:'21px'};
  window.dispatchEvent(new Event('orientationchange'));
  assert.equal(parseFloat(frame.style.height),369);
  assert.ok(Math.abs(parseFloat(frame.style.width)-369*16/9)<1e-8);
  Object.assign(viewport,{width:390,height:700,offsetTop:24});
  padding={paddingLeft:'0',paddingRight:'0',paddingTop:'0',paddingBottom:'0'};
  viewport.dispatchEvent(new Event('resize'));
  assert.equal(frame.style.width,'390px');assert.equal(frame.style.height,'292.5px');
  cleanup();assert.deepEqual(frame.style,{width:'',height:''});assert.deepEqual(container.style,initial);
});

test('provider viewport framing removes the extra 16:9 letterbox and follows rotation without reloading the frame', () => {
  const window=Object.assign(new EventTarget(),{visualViewport:new EventTarget()});
  const container={clientWidth:2944,clientHeight:1840};
  const frame={style:{width:'',height:''}};
  let cleanup;
  const {useContainedPlayerFrame}=load('src/components/useContainedPlayerFrame.ts',{
    react:{useLayoutEffect(fn){cleanup=fn();}},'@/lib/playerFullscreen':api,
  },{window,getComputedStyle:()=>({paddingLeft:'0',paddingRight:'0',paddingTop:'0',paddingBottom:'0'})});
  useContainedPlayerFrame({current:container},{current:frame},true,false,true);
  assert.equal(frame.style.width,'2944px');assert.equal(frame.style.height,'1840px');
  for(const ratio of [4/3,16/9]) {
    const picture=api.containedPlayerSize(parseFloat(frame.style.width),parseFloat(frame.style.height),ratio);
    assert.ok(Math.abs(picture.height-(ratio===4/3?1840:1656))<1e-6);
  }
  container.clientWidth=1920;container.clientHeight=1080;window.dispatchEvent(new Event('orientationchange'));
  assert.equal(frame.style.width,'1920px');assert.equal(frame.style.height,'1080px');
  cleanup();assert.deepEqual(frame.style,{width:'',height:''});
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
  const container = {webkitRequestFullscreen(...args) {assert.equal(this, container);assert.equal(args.length,0);}};
  assert.equal(await api.requestPlayerFullscreen(container, android), 'native');
  const doc = {webkitFullscreenElement: container, webkitExitFullscreen() {assert.equal(this, doc); exited++;}};
  await api.exitPlayerFullscreen(doc);
  await api.exitPlayerFullscreen({exitFullscreen() {throw Error('should not exit inline');}});
  assert.equal(exited, 1);
});

// Exercise hook lifecycle and real event dispatch without a browser/device UA shim.
function harness(nav = android) {
  const document = Object.assign(new EventTarget(), {
    fullscreenElement: null,
    documentElement: {style: {overflowX: '', overflowY: '', height: '', minHeight: ''}},
    body: {style: {overflow: 'scroll', height: '', minHeight: '', maxHeight: ''}},
  });
  const window = Object.assign(new EventTarget(), {
    scrollX: 7,
    scrollY: 123,
    scrollTo(options, y) {
      if (typeof options === 'object') {
        this.scrollX = options.left ?? this.scrollX;
        this.scrollY = options.top ?? this.scrollY;
      } else {
        this.scrollX = options;
        this.scrollY = y;
      }
    },
  });
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
test('Android can promote fallback web mode on a fresh click while keeping the subtitle container', async () => {
  const h=harness(),options=[];
  h.container.requestFullscreen=async opts=>{options.push(opts);throw Error('activation consumed');};
  await h.render().toggleFullscreen();assert.equal(h.render().mode,'web');
  assert.equal(h.render().appleWebFullscreen,false);
  h.container.requestFullscreen=async opts=>{options.push(opts);h.document.fullscreenElement=h.container;h.document.dispatchEvent(new Event('fullscreenchange'));};
  await h.render().retryNativeFullscreen();assert.equal(h.render().mode,'native');
  assert.equal(h.document.fullscreenElement,h.container);
  assert.deepEqual(options.map(o=>o.navigationUI),['hide','hide']);
  await h.document.exitFullscreen();assert.equal(h.render().mode,'inline');h.unmount();
});
test('failed Android retry keeps web mode and its exit available; Apple web framing and fullscreen stay unchanged', async () => {
  for(const nav of [android,iphone]) {
    const h=harness(nav);let requests=0;
    h.container.requestFullscreen=async()=>{requests++;throw Error('denied');};
    await h.render().toggleFullscreen();assert.equal(h.render().mode,'web');
    await h.render().retryNativeFullscreen();assert.equal(h.render().mode,'web');
    assert.equal(h.render().appleWebFullscreen,nav===iphone);
    assert.equal(requests,nav===iphone?0:2);
    await h.render().toggleFullscreen();assert.equal(h.render().mode,'inline');h.unmount();
  }
});
test('iPhone web mode keeps an invisible root scroll room for Safari chrome and restores the page', async () => {
  const h = harness(iphone);
  await h.render().toggleFullscreen();
  assert.equal(h.render().mode, 'web');
  assert.equal(h.document.body.style.overflow, 'hidden');
  assert.equal(h.document.body.style.height, '100dvh');
  assert.equal(h.document.documentElement.style.overflowY, 'auto');
  assert.equal(h.document.documentElement.style.height, `calc(100dvh + ${api.WEB_FULLSCREEN_SCROLL_ROOM_PX}px)`);
  assert.equal(h.window.scrollY, 0);

  // Rotation often reveals Safari's toolbar; reset the hidden scroll position
  // so the next upward swipe can retract it again.
  h.window.scrollY = api.WEB_FULLSCREEN_SCROLL_ROOM_PX;
  h.window.dispatchEvent(new Event('orientationchange'));
  assert.equal(h.window.scrollY, 0);

  h.window.dispatchEvent(new Event('resize'));
  h.document.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(h.render().mode, 'web');
  assert.equal(h.document.body.style.overflow, 'hidden');

  const escape = Object.assign(new Event('keydown'), {key: 'Escape'});
  h.window.dispatchEvent(escape);
  assert.equal(h.render().mode, 'inline');
  assert.equal(h.document.body.style.overflow, 'scroll');
  assert.equal(h.document.documentElement.style.height, '');
  assert.equal(h.window.scrollX, 7);
  assert.equal(h.window.scrollY, 123);

  await h.render().toggleFullscreen(); h.render(); h.unmount();
  assert.equal(h.document.body.style.overflow, 'scroll');
});
test('ArtPlayer web fullscreen uses the same Safari scroll-room helper', () => {
  const src = fs.readFileSync(path.join(root, 'src/components/Player.tsx'), 'utf8');
  assert.match(src, /enableWebFullscreenScrollRoom/);
  assert.match(src, /art\.on\("fullscreenWeb", \(active: boolean\) => \{/);
  assert.match(src, /cleanupWebFullscreenScrollRoom = active[\s\S]*?enableWebFullscreenScrollRoom\(document, window\)/);
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
  assert.match(settings, /\(\[1, 1\.25, 1\.5, 2, 2\.5, 3\] as const\)/);
  assert.match(src, /prescaleFactor:\s*playerSettingsRef\.current\.subtitleSharpness \|\| 1/);
  assert.match(src, /sharpnessChanged[\s\S]*?applySubtitleRef\.current\(activeSub, currentSyncOffsetRef\.current\)/);
  assert.doesNotMatch(src, /name:\s*"subtitleSharpness"/);
  assert.match(iframe, /const sharpness = playerSettings\.subtitleSharpness \|\| 1/);
  assert.match(iframe, /subtitleRenderSize\(w, h, sharpness, window\.devicePixelRatio\)/);
  assert.match(
    iframe,
    /const syncOctopusCanvasSize = \(\) => \{[\s\S]*?const \{ width: renderW, height: renderH \} = subtitleRenderSize\(w, h, sharpness, window\.devicePixelRatio\)[\s\S]*?octopusRef\.current\.resize\(renderW, renderH\)/
  );
  const syncResizeBlock = iframe.match(
    /const syncOctopusCanvasSize = \(\) => \{([\s\S]*?)\n    \};/
  )?.[1] || "";
  assert.doesNotMatch(syncResizeBlock, /canvasRef\.current\.width\s*=|canvasRef\.current\.height\s*=/);
  assert.match(
    iframe,
    /syncOctopusCanvasSize[\s\S]*?syncIframeSubtitleClock\([\s\S]*?lastCurrentTimeRef\.current \+ effectiveSubtitleOffset\([\s\S]*?reset: true/
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


test('provider iframe fullscreen promotes the caption container when native transfer is allowed', async () => {
  const child={},doc={fullscreenElement:child},requests=[];
  const container={contains:el=>el===child,requestFullscreen:async function(){requests.push(this);doc.fullscreenElement=container;}};
  assert.equal(await api.preservePlayerFullscreen(container,doc,android),'native');
  assert.equal(doc.fullscreenElement,container);
  assert.deepEqual(requests,[container]);
});
test('denied desktop provider promotion switches to subtitle web fullscreen for native retry', async () => {
  const child={},events=[],doc={fullscreenElement:child,exitFullscreen:async()=>{events.push('exit');doc.fullscreenElement=null;}};
  const container={contains:el=>el===child,requestFullscreen:async()=>{events.push('request');throw new Error('activation consumed');}};
  const desktop={userAgent:'Mozilla/5.0 Chrome/150 Whale/5.39',maxTouchPoints:0};
  assert.equal(await api.preservePlayerFullscreen(container,doc,desktop),'web');
  assert.deepEqual(events,['request','exit']);
  assert.equal(doc.fullscreenElement,null);
});
test('Apple touch provider fullscreen still exits the video-only layer for caption-preserving web mode', async () => {
  const child={},events=[],doc={fullscreenElement:child,exitFullscreen:async()=>{events.push('exit');doc.fullscreenElement=null;}};
  const container={contains:el=>el===child};
  assert.equal(await api.preservePlayerFullscreen(container,doc,iphone),'web');
  assert.deepEqual(events,['exit']);assert.equal(doc.fullscreenElement,null);
});
test('denied Android provider handoff exits iframe fullscreen to show subtitles and retry', async () => {
  let exits=0;
  const child={},doc={fullscreenElement:child,exitFullscreen:async()=>{exits++;doc.fullscreenElement=null;}};
  const container={contains:el=>el===child,requestFullscreen:async()=>{throw new Error('activation consumed');}};
  assert.equal(await api.preservePlayerFullscreen(container,doc,android),'web');
  assert.equal(doc.fullscreenElement,null);
  assert.equal(exits,1);
});
test('fullscreen preservation never exits unrelated elements or overrides a user exit during transfer', async () => {
  const child={},unrelated={},container={contains:el=>el===child};
  let exits=0;const doc={fullscreenElement:unrelated,exitFullscreen:async()=>{exits++;}};
  assert.equal(await api.preservePlayerFullscreen(container,doc,android),null);
  doc.fullscreenElement=container;
  assert.equal(await api.preservePlayerFullscreen(container,doc,android),null);
  doc.fullscreenElement=child;
  container.requestFullscreen=async()=>{doc.fullscreenElement=null;throw new Error('user pressed Escape');};
  assert.equal(await api.preservePlayerFullscreen(container,doc,android),null);
  assert.equal(exits,0);
});
test('PC and Android web fallback exposes a native retry button without changing 16:9 framing', () => {
  const source=fs.readFileSync(path.join(root,'src/components/IframePlayer.tsx'),'utf8');
  assert.match(source,/const showNativeRetry = fullscreenMode === "web" && typeof navigator !== "undefined" && !appleWebFullscreen/);
  assert.match(source,/\? "상태바 숨기기" : "전체화면 재시도"/);
  assert.match(source,/<Maximize2 className="h-4 w-4" \/>{nativeRetryLabel}/);
  assert.match(source,/useContainedPlayerFrame\(containerRef, mediaFrameRef, isFullscreen, fullscreenMode === "web", false,/);
});

test('native provider fullscreen handoff coalesces duplicate events and ignores updates after unmount', async () => {
  const child={},doc=Object.assign(new EventTarget(),{fullscreenElement:child});
  const win=new EventTarget();let pending,transfers=0,mode='inline',cleanup;
  const refs=[];
  const {usePlayerFullscreen}=load('src/components/usePlayerFullscreen.ts',{
    react:{useRef:value=>{const ref={current:value};refs.push(ref);return ref;},useState:()=>['inline',v=>{mode=v;}],useCallback:fn=>fn,
      useEffect:fn=>{const result=fn();if(result)cleanup=result;}},
    '@/lib/playerFullscreen':{getPlayerFullscreenElement:d=>d.fullscreenElement,
      preservePlayerFullscreen:()=>{transfers++;return new Promise(resolve=>{pending=resolve;});},
      requestPlayerFullscreen:async()=> 'native',exitPlayerFullscreen:async()=>{doc.fullscreenElement=null;},enableWebFullscreenScrollRoom:()=>()=>{}},
  },{document:doc,window:win,navigator:android});
  usePlayerFullscreen({current:{contains:el=>el===child}});
  doc.dispatchEvent(new Event('fullscreenchange'));
  doc.dispatchEvent(new Event('webkitfullscreenchange'));
  assert.equal(transfers,1);
  doc.fullscreenElement=null;
  doc.dispatchEvent(new Event('fullscreenchange'));
  pending('web');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(mode,'web');
  doc.fullscreenElement=child;
  doc.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(transfers,2);
  cleanup();pending('native');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(mode,'web');
});

