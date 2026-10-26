const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const ts = require('typescript');
const {chromium} = require('playwright');

async function main() {
  const requests = [];
  const rawHtml = '<!doctype html><html><title>Document fixture</title><script>var player_aaaa={"subtitle_url":"/sub.vtt"};fetch("/executed");new RTCPeerConnection();</script><script src="/player.js"></script><iframe src="/iframe"></iframe><img src="/image.jpg"></html>';
  const server = http.createServer((req,res) => {
    requests.push(req.url);
    if(req.url==='/missing'){res.writeHead(404,{'Content-Type':'text/html'});res.end('missing');return;}
    if(req.url==='/redirect'){res.writeHead(302,{Location:`http://localhost:${server.address().port}/outside`});res.end();return;}
    res.setHeader('Content-Type','text/html');res.end(rawHtml);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const oldBin = process.env.CHROMIUM_BIN;
  process.env.CHROMIUM_BIN = chromium.executablePath();
  try {
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/chromiumDocumentFetch.ts'),'utf8'),{
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
    }).outputText;
    vm.runInNewContext(code,{exports,process,URL,WebSocket,fetch,AbortSignal,Buffer,Error,setTimeout,clearTimeout,
      require: id=>id==='./chromiumFetch'?{runChromiumQueued:task=>task()}:id==='./proxyGuard'?{
        // Only the isolated local fixture bypasses the production public-IP guard.
        assertSafeProxyUrl:async url=>{assert.equal(new URL(url).origin,origin);},
      }:require(id),
    });
    const result=await exports.fetchChromiumDocument(`${origin}/document`,20000);
    assert.equal(result.status,200);
    assert.equal(result.html,rawHtml);
    assert.deepEqual(requests,['/document']);
    await assert.rejects(exports.fetchChromiumDocument(`${origin}/missing`,20000),/HTTP 404/);
    await assert.rejects(exports.fetchChromiumDocument(`${origin}/redirect`,20000),/ERR_BLOCKED_BY_CLIENT|document|navigation/i);
    assert.ok(!requests.includes('/outside'));
    console.log('Chromium reads the raw main response with scripts/iframes/images blocked, rejects HTTP errors and cross-origin redirects.');
  } finally {
    if(oldBin===undefined)delete process.env.CHROMIUM_BIN;else process.env.CHROMIUM_BIN=oldBin;
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
