// Run with Node 22 inside the anime container. No packages or settings changed.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkani-cdp-'));
  const chrome = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${dir}`, 'about:blank',
  ], { env: { ...process.env, HOME: '/tmp', XDG_CONFIG_HOME: '/tmp' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', startupError, socket;
  const pending = new Map();
  chrome.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2000); });
  chrome.on('error', error => { startupError = error; });
  const watchdog = setTimeout(() => chrome.kill('SIGKILL'), 55000);
  try {
    const portFile = path.join(dir, 'DevToolsActivePort');
    for (let n = 0; !fs.existsSync(portFile); n++) {
      if (startupError) throw startupError;
      if (chrome.exitCode !== null || n >= 150) throw Error('Chromium did not open its local debugging port');
      await pause(100);
    }
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const page = pages.find(p => p.type === 'page');
    if (!page) throw Error('No blank page target');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(Error('Local debugger connection failed')), { once: true });
    });
    let serial = 0, navigation;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        clearTimeout(timer); pending.delete(message.id);
        message.error ? reject(Error(message.error.message)) : resolve(message.result);
      }
      const p = message.params;
      if (message.method === 'Network.responseReceived' && p.type === 'Document' && p.response.url.startsWith('https://linkani.tv/')) {
        const r = p.response;
        navigation = { url: r.url, status: r.status, protocol: r.protocol, mimeType: r.mimeType,
          remoteIPAddress: r.remoteIPAddress, encryptedClientHello: r.securityDetails?.encryptedClientHello };
        console.log('LINKANI_RESPONSE', JSON.stringify(navigation));
      }
      if (message.method === 'Network.loadingFailed' && p.type === 'Document') {
        console.log('DOCUMENT_FAILED', JSON.stringify({ error: p.errorText, blockedReason: p.blockedReason }));
      }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await call('Page.enable');
    await call('Network.enable');
    // Disable execution before navigating: original player/P2P scripts cannot run.
    await call('Emulation.setScriptExecutionDisabled', { value: true });
    await call('Network.setBlockedURLs', { urls: ['*.js', '*.js?*', '*.m3u8*', '*.mp4*', '*.ts', '*.webm*'] });
    const result = await call('Page.navigate', { url: 'https://linkani.tv/' });
    console.log('LINKANI_NAVIGATION', JSON.stringify(result));
    if (!result.errorText) {
      for (let n = 0; !navigation && n < 100; n++) await pause(100);
      if (!navigation) console.log('NO_LINKANI_RESPONSE: navigation produced no matching HTTP response');
    }
    await call('Page.stopLoading').catch(() => {});
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    socket?.close();
    chrome.kill('SIGTERM');
    for (let n = 0; chrome.exitCode === null && chrome.signalCode === null && n < 20; n++) await pause(100);
    if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await pause(300); }
    clearTimeout(watchdog);
    fs.rmSync(dir, { recursive: true, force: true });
    if (startupError) console.log('CHROMIUM_ERROR', startupError.message);
  }
}
main().catch(error => { console.error('PROBE_ERROR', error.message); process.exitCode = 1; });
