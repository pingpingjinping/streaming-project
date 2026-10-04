// ==UserScript==
// @name         WalnutPi 한국어 자막 전체화면
// @namespace    local.walnutpi.subtitle
// @version      1.0.0
// @description  yjhmoon.iptime.org에서 선택한 자막을 연결된 외부 영상의 한국어 트랙으로 적용
// @match        https://*/*
// @match        http://*/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// @downloadURL  https://yjhmoon.iptime.org/userscripts/walnutpi-native-subtitles.user.js
// @updateURL    https://yjhmoon.iptime.org/userscripts/walnutpi-native-subtitles.user.js
// ==/UserScript==

(() => {
  'use strict';
  // Frame URLs belong to the external player. @match must include those URLs,
  // but no video/DOM changes happen until OUR parent site's handshake arrives.
  if (window === window.top) return;
  const BRIDGE = 'walnutpi-native-subtitles-v1';
  const HOST = 'yjhmoon.iptime.org';
  const APPLE_TOUCH = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (!APPLE_TOUCH) return;
  const FULLSCREEN_CONTROL = '.vjs-fullscreen-control,.plyr__control[data-plyr="fullscreen"],.art-control-fullscreen,.jw-icon-fullscreen,button[aria-label*="fullscreen" i],button[title*="fullscreen" i],button[aria-label*="전체화면"],button[title*="전체화면"]';
  let connection = null;
  let video = null, track = null, blobUrl = null, observer = null, maintenance = null;
  let revision = -1, payload = null, applied = false, active = false, generation = 0;
  let ownedButton = null, hideTimer = null, loadTimer = null;
  const previousModes = new Map();
  const removers = [];

  function allowedOrigin(origin) {
    try { const url = new URL(origin); return ['https:', 'http:'].includes(url.protocol) && url.hostname === HOST; }
    catch { return false; }
  }
  function send(type, extra = {}) {
    if (connection) connection.source.postMessage({bridge: BRIDGE, session: connection.session, type, ...extra}, connection.origin);
  }
  function nativeSupported() {
    return Boolean(APPLE_TOUCH && video && typeof (video.webkitEnterFullscreen || video.webkitEnterFullScreen) === 'function');
  }
  function isNative() {
    return Boolean(video && (video.webkitDisplayingFullscreen || video.webkitPresentationMode === 'fullscreen' || document.fullscreenElement === video));
  }
  function on(target, name, fn, options) {
    target.addEventListener(name, fn, options);
    removers.push(() => target.removeEventListener(name, fn, options));
  }
  function restoreOtherTracks() {
    for (const [other, mode] of previousModes) { try { other.mode = mode; } catch {} }
    previousModes.clear();
  }
  function syncNative() {
    active = isNative();
    if (track?.track) track.track.mode = active && payload?.enabled && applied ? 'showing' : 'hidden';
    if (active && payload?.enabled && applied) {
      for (const other of Array.from(video.textTracks || [])) {
        if (other !== track.track) {
          if (!previousModes.has(other)) previousModes.set(other, other.mode);
          other.mode = 'hidden';
        }
      }
    } else restoreOtherTracks();
    if (ownedButton) ownedButton.style.display = active ? 'none' : '';
    send('fullscreen', {active});
  }
  function clearTrack() {
    generation++;
    applied = false;
    clearTimeout(loadTimer); loadTimer = null;
    if (track) { try { track.track.mode = 'disabled'; track.remove(); } catch {} track = null; }
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  }
  function revealButton() {
    if (!ownedButton || active) return;
    ownedButton.style.opacity = '1';
    ownedButton.style.pointerEvents = 'auto';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (ownedButton) { ownedButton.style.opacity = '0'; ownedButton.style.pointerEvents = 'none'; }
    }, 3500);
  }
  function ensureButton() {
    // Prefer the player's existing fullscreen button. A replacement is needed
    // only when its native controls cannot be found/accessed in this document.
    if (!applied || !nativeSupported() || document.querySelector(FULLSCREEN_CONTROL)) return;
    if (ownedButton || !document.body) return;
    ownedButton = document.createElement('button');
    ownedButton.type = 'button';
    ownedButton.setAttribute('aria-label', '한국어 자막 전체화면');
    ownedButton.title = '한국어 자막 전체화면';
    ownedButton.textContent = '⛶';
    ownedButton.style.cssText = 'position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(48px,env(safe-area-inset-bottom));width:44px;height:44px;border:0;border-radius:50%;background:rgba(15,23,42,.65);color:white;font-size:24px;z-index:2147483647;transition:opacity .2s;cursor:pointer';
    ownedButton.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      void toggleNative().then(success => { if (!success) send('fallback'); });
    });
    document.body.appendChild(ownedButton);
    revealButton();
  }
  function applySubtitle() {
    clearTrack();
    if (payload) send('pending', {revision});
    if (!video || !payload) return;
    const thisGeneration = generation;
    const thisRevision = revision;
    if (!payload.enabled) {
      applied = true; syncNative(); send('applied', {revision}); ensureButton(); return;
    }
    if (!payload.count) { send('failed', {revision}); return; }
    const element = document.createElement('track');
    track = element;
    element.kind = 'subtitles'; element.srclang = 'ko';
    element.label = `한국어 · ${payload.label || '선택한 자막'}`;
    // Hidden loads native cues without duplicating the host's inline ASS/HUD.
    element.default = true;
    blobUrl = URL.createObjectURL(new Blob([payload.vtt], {type: 'text/vtt;charset=utf-8'}));
    element.src = blobUrl;
    const finished = success => {
      if (thisGeneration !== generation || thisRevision !== revision || track !== element) return;
      clearTimeout(loadTimer); loadTimer = null;
      applied = success && Boolean(element.track?.cues?.length);
      syncNative();
      send(applied ? 'applied' : 'failed', {revision: thisRevision});
      if (applied) ensureButton();
    };
    element.addEventListener('load', () => finished(true), {once: true});
    element.addEventListener('error', () => finished(false), {once: true});
    video.appendChild(element);
    element.track.mode = 'hidden';
    loadTimer = setTimeout(() => finished(element.readyState === 2), 8000);
  }
  function findVideo() {
    const candidates = Array.from(document.querySelectorAll('video')).filter(item => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(item).visibility !== 'hidden';
    });
    if (candidates.length === 1) return candidates[0];
    const playing = candidates.filter(item => !item.paused && !item.ended);
    return playing.length === 1 ? playing[0] : null;
  }
  function bindVideo() {
    if (video && isNative()) return;
    const next = findVideo();
    if (next === video) return;
    clearTrack(); restoreOtherTracks();
    if (payload) send('pending', {revision});
    removers.splice(0).forEach(remove => remove());
    if (ownedButton) { ownedButton.remove(); ownedButton = null; }
    video = next;
    active = false;
    send('connected', {nativeSupported: nativeSupported(), revision});
    send('fullscreen', {active: false});
    if (!video) return;
    on(video, 'webkitbeginfullscreen', syncNative);
    on(video, 'webkitendfullscreen', syncNative);
    on(video, 'webkitpresentationmodechanged', syncNative);
    on(document, 'fullscreenchange', syncNative);
    on(video, 'loadedmetadata', () => { if (!applied) applySubtitle(); });
    on(document, 'pointerdown', revealButton, {passive: true, capture: true});
    on(document, 'touchstart', revealButton, {passive: true, capture: true});
    on(document, 'click', event => {
      if (!applied || !nativeSupported()) return;
      const control = event.target?.closest?.(FULLSCREEN_CONTROL);
      if (!control || control === ownedButton) return;
      event.preventDefault(); event.stopImmediatePropagation();
      // Run the native call IN this iframe's click handler, retaining iOS's
      // trusted user gesture instead of forwarding the click through postMessage.
      void toggleNative().then(success => { if (!success) send('fallback'); });
    }, true);
    if (payload) applySubtitle();
  }
  function toggleNative() {
    if (!video || (!applied && !isNative()) || !nativeSupported()) return Promise.resolve(false);
    try {
      const exit = isNative();
      const fn = exit ? (video.webkitExitFullscreen || video.webkitExitFullScreen) : (video.webkitEnterFullscreen || video.webkitEnterFullScreen);
      if (!fn) return Promise.resolve(false);
      fn.call(video);
      return new Promise(resolve => {
        const start = Date.now();
        function check() {
          if (isNative() !== exit) { syncNative(); resolve(true); }
          else if (Date.now() - start >= 500 || !connection) resolve(false);
          else setTimeout(check, 25);
        }
        check();
      });
    } catch { return Promise.resolve(false); }
  }
  function disconnect() {
    clearTrack(); restoreOtherTracks();
    removers.splice(0).forEach(remove => remove());
    observer?.disconnect(); observer = null;
    clearInterval(maintenance); maintenance = null;
    clearTimeout(hideTimer); hideTimer = null;
    ownedButton?.remove(); ownedButton = null;
    video = null; payload = null; revision = -1; active = false; connection = null;
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window.parent || !allowedOrigin(event.origin) || !data || data.bridge !== BRIDGE || typeof data.session !== 'string' || data.session.length < 16) return;
    if (data.type === 'connect') {
      if (!connection || connection.session !== data.session || connection.origin !== event.origin) {
        disconnect();
        connection = {source: event.source, origin: event.origin, session: data.session, lastSeen: Date.now()};
        bindVideo();
        observer = new MutationObserver(bindVideo);
        observer.observe(document.documentElement || document, {childList: true, subtree: true});
        maintenance = setInterval(() => {
          if (Date.now() - connection.lastSeen > 8000) { disconnect(); return; }
          bindVideo(); ensureButton();
        }, 2000);
      }
      connection.lastSeen = Date.now();
      send('connected', {nativeSupported: nativeSupported(), revision});
      return;
    }
    if (!connection || data.session !== connection.session || event.origin !== connection.origin) return;
    connection.lastSeen = Date.now();
    if (data.type === 'subtitle') {
      if (!Number.isSafeInteger(data.revision) || data.revision < revision || typeof data.vtt !== 'string' || data.vtt.length > 10_000_000 || !data.vtt.startsWith('WEBVTT') || !Number.isSafeInteger(data.count) || data.count < 0 || data.count > 50000) return;
      if (data.revision === revision) {
        if (applied) send('applied', {revision});
        return;
      }
      revision = data.revision;
      payload = {enabled: data.enabled === true, label: String(data.label || '').slice(0, 100), vtt: data.vtt, count: data.count};
      applySubtitle();
    } else if (data.type === 'toggleFullscreen' && data.revision === revision) {
      const currentConnection = connection;
      void toggleNative().then(success => {
        if (connection === currentConnection) send('fullscreenResult', {requestId: data.requestId, success});
      });
    } else if (data.type === 'disconnect') disconnect();
  });
  window.addEventListener('pagehide', disconnect);
})();
