const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const ts = require('typescript');

function transport(direct, browser) {
  const requests = [], browserRequests = [], exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/linkaniFetch.ts'), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(code, {exports, URL, AbortSignal, Error, Date,
    require: () => ({fetchChromiumDocument: async url => {
      browserRequests.push(url); return {html: await browser(url), status: 200};
    }}),
    fetch: async url => { requests.push(url); return direct(url); },
  });
  return {...exports, requests, browserRequests};
}
const html = '<!DOCTYPE html><html><h1>Linkani</h1></html>';
test('successful direct requests never launch Chromium and cached pages are reused', async () => {
  const p = transport(() => new Response(html), () => {throw Error('unexpected browser');});
  assert.equal(await p.fetchLinkaniHtml('https://linkani.tv/list/2/'), html);
  assert.equal(await p.fetchLinkaniHtml('https://linkani.tv/list/2/'), html);
  assert.equal(p.requests.length, 1);
  assert.equal(p.browserRequests.length, 0);
});
test('ECONNRESET falls back with identical search URL and remembers the browser transport per origin', async () => {
  const p = transport(() => {throw Object.assign(new TypeError('fetch failed'), {cause:{code:'ECONNRESET'}});}, () => html);
  const url = 'https://linkani.tv/view/?wd=%EC%9D%80%ED%98%BC&page=2';
  assert.equal(await p.fetchLinkaniHtml(url), html);
  assert.equal(await p.fetchLinkaniHtml('https://linkani.tv/ani/42/'), html);
  assert.deepEqual(p.browserRequests, [url, 'https://linkani.tv/ani/42/']);
  assert.equal(p.requests.length, 1);
});
test('watch-page cache bypass renews signed tokens even when a list cache entry exists', async () => {
  let version = 0;
  const p = transport(() => {throw Error('reset');}, () => `<html>${++version}</html>`);
  const url = 'https://linkani.tv/watch/42/a1/k1/';
  assert.equal(await p.fetchLinkaniHtml(url), '<html>1</html>');
  assert.equal(await p.fetchLinkaniHtml(url, {cacheTtlMs: 0}), '<html>2</html>');
  assert.equal(await p.fetchLinkaniHtml(url, {cacheTtlMs: 0}), '<html>3</html>');
});
test('concurrent consumers share one failed direct attempt and one browser read', async () => {
  const p = transport(() => {throw Error('reset');}, async () => {await new Promise(resolve=>setTimeout(resolve, 5));return html;});
  const result = await Promise.all(Array.from({length: 5}, () => p.fetchLinkaniHtml('https://linkani.tv/')));
  assert.ok(result.every(x=>x===html));
  assert.equal(p.requests.length, 1);
  assert.equal(p.browserRequests.length, 1);
});
test('HTTP errors remain failures rather than being reported as browser success', async () => {
  const p = transport(() => new Response('missing', {status:404}), () => {throw Error('unexpected browser');});
  await assert.rejects(p.fetchLinkaniHtml('https://linkani.tv/missing'), /HTTP 404/);
  assert.equal(p.browserRequests.length, 0);
});
test('health confirms an actual HTML response through the same fallback as provider pages', async () => {
  const p = transport(() => {throw Error('reset');}, () => html);
  const health = await p.checkLinkaniHealth('https://linkani.tv/');
  assert.equal(health.ok, true);
  assert.match(health.statusText, /Chromium document/);
  const failed = transport(() => {throw Error('reset');}, () => {throw Error('Chromium navigation net::ERR_CONNECTION_RESET');});
  const failure = await failed.checkLinkaniHealth('https://linkani.tv/');
  assert.equal(failure.ok, false);
  assert.match(failure.statusText, /ERR_CONNECTION_RESET/);
  const empty = transport(() => new Response('not a page'), () => html);
  assert.equal((await empty.checkLinkaniHealth('https://linkani.tv/')).ok, false);
});
