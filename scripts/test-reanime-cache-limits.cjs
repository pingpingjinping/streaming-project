const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function provider() {
  let now = 0, cleanup, interval, unrefs = 0, failed = false, version = 0;
  const requests = [];
  const context = vm.createContext({
    exports: {}, URL, URLSearchParams, AbortSignal,
    Date: class extends Date { static now() { return now; } },
    console: { warn() {}, error() {} },
    setInterval: (callback, ms) => { cleanup = callback; interval = ms; return { unref() { unrefs++; } }; },
    require: name => ({
      './ids': { toReanimeId: id => id.startsWith('re_') ? id : `re_${id}`, stripReanimeId: id => id.replace(/^re_/, '') },
      '../episodeMapping': { reviewedReanimeProjection: () => null },
      '../localReanimeDetail': { getLocalReanimeDetail: async () => null },
      '@/lib/reanimeMatches': { getBundledReanimeMatch: () => null },
      '@/lib/db': { getReanimeBaseUrl: async () => 'https://rean.example' },
    })[name] ?? require(name),
    fetch: async url => {
      const parsed = new URL(url);
      requests.push(parsed.pathname);
      if (failed) return new Response('Unavailable', { status: 503 });
      const ep = parsed.pathname.match(/^\/api\/flix\/42\/(\d+)$/)?.[1];
      const body = ep ? { success: true, servers: [{ serverName: 'HD-1', dataType: 'sub', dataLink: `https://video.example/${ep}?version=${++version}` }] }
        : parsed.pathname.endsWith('/episodes') ? { data: [{ episode_number: 1 }] }
        : { title: { english: parsed.pathname.split('/').at(-1) }, anilist_id: 42, can_watch: true,
          episodes_total: 1, cover_image: { large: 'https://image.example/42.png' } };
      return new Response(JSON.stringify(body));
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/providers/reanime.ts'), 'utf8');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, context);
  const api = context.exports;
  return {
    detail: id => api.getAnimeDetail(`re_${id}`, { videoSource: 'rean' }),
    stream: ep => api.getEpisodeStream(`https://rean.example/watch/work?ep=${ep}&anilist=42`),
    artwork: () => api.getReanimeArtwork('work'),
    requests, setTime: value => { now = value; }, fail: () => { failed = true; }, sweep: () => cleanup(),
    state: () => ({ details: vm.runInContext('detailCache.size', context), streams: vm.runInContext('streamCache.size', context),
      artwork: vm.runInContext('artworkCache.size', context), interval, unrefs }),
  };
}

test('warm hits reuse provider responses but reading them does not extend the ten-minute expiry', async () => {
  const p = provider();
  await p.detail('work'); const first = await p.stream(1);
  assert.equal(p.requests.length, 3);
  p.setTime(599999);
  await p.detail('work'); assert.equal((await p.stream(1)).embed_url, first.embed_url);
  assert.equal(p.requests.length, 3);
  p.setTime(600000);
  await p.detail('work'); assert.notEqual((await p.stream(1)).embed_url, first.embed_url);
  assert.equal(p.requests.length, 6);
});

test('browsing more than 128 works releases the least recently used detail and retains active works', async () => {
  const p = provider();
  for (let i = 0; i < 128; i++) await p.detail(`work-${i}`);
  await p.detail('work-0'); await p.detail('work-128');
  assert.equal(p.state().details, 128);
  const requests = p.requests.length;
  await p.detail('work-0'); assert.equal(p.requests.length, requests);
  await p.detail('work-1'); assert.equal(p.requests.length, requests + 2);
  assert.equal(p.state().details, 128);
});

test('browsing more than 256 episodes releases old stream lookups and refetches them on demand', async () => {
  const p = provider();
  for (let ep = 1; ep <= 256; ep++) await p.stream(ep);
  await p.stream(1); await p.stream(257);
  assert.equal(p.state().streams, 256);
  const requests = p.requests.length;
  await p.stream(1); assert.equal(p.requests.length, requests);
  await p.stream(2); assert.equal(p.requests.length, requests + 1);
  assert.equal(p.state().streams, 256);
});

test('idle cleanup frees expired lookups and artwork without external requests, and its timer does not keep the process alive', async () => {
  const p = provider();
  await p.detail('work'); await p.stream(1); await p.artwork();
  assert.deepEqual(p.state(), { details: 1, streams: 1, artwork: 1, interval: 60000, unrefs: 1 });
  const requests = p.requests.length;
  p.setTime(600000); p.sweep();
  assert.equal(p.state().details, 0); assert.equal(p.state().streams, 0); assert.equal(p.state().artwork, 1);
  p.setTime(86400000); p.sweep(); assert.equal(p.state().artwork, 0);
  assert.equal(p.requests.length, requests);
});

test('a failed upstream cannot revive a removed expired stream', async () => {
  const p = provider(); await p.stream(1);
  p.setTime(600000); p.fail();
  assert.equal(await p.stream(1), null); assert.equal(p.state().streams, 0);
});

test('simultaneous work loads still keep the detail cache inside its limit', async () => {
  const p = provider();
  const results = await Promise.all(Array.from({ length: 160 }, (_, i) => p.detail(`work-${i}`)));
  assert.ok(results.every(detail => detail?.sub_episodes.length === 1));
  assert.equal(p.state().details, 128);
});
