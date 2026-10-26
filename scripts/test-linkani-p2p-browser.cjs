const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ts = require('typescript');
const { chromium } = require('playwright');

async function main() {
  const root = path.join(__dirname, '..');
  const guard = ts.transpileModule(fs.readFileSync(path.join(root, 'src/lib/blockP2P.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const server = http.createServer((req, res) => {
    if (req.url === '/guard.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`{const exports={};${guard};exports.blockPeerConnections(window);exports.blockPeerConnections(window);}`);
    } else if (['/hls.min.js', '/artplayer.js'].includes(req.url)) {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(fs.readFileSync(path.join(root, 'public/js', req.url.slice(1))));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<script src="/guard.js"></script><script src="/hls.min.js"></script><script src="/artplayer.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(() => ({
      hls: typeof window.Hls === 'function', artplayer: typeof window.Artplayer === 'function',
      peerApis: ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'].map(name => {
        let blocked = false;
        try { new window[name](); } catch (e) { blocked = e.name === 'NotAllowedError'; }
        return { blocked, locked: !Reflect.set(window, name, function () {}) && !Reflect.deleteProperty(window, name) };
      }),
    }));
    assert.deepEqual(errors, []);
    assert.equal(result.hls, true);
    assert.equal(result.artplayer, true);
    assert.ok(result.peerApis.every(api => api.blocked && api.locked));
    console.log('Linkani: Chromium blocks peer connections and restores neither API nor aliases; local HLS/Artplayer scripts load.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
