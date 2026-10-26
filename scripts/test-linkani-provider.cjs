const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.join(__dirname, '..');

function load(file, deps = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports, URL, console, ...globals,
    require: name => deps[name] || require(name),
  });
  return exports;
}
const settings = load('src/lib/linkaniSettings.ts');
const { blockPeerConnections } = load('src/lib/blockP2P.ts', {}, { DOMException });
const base = settings.DEFAULT_LINKANI_URL;
function provider(fetchPage, globals = {}, baseUrl = base) {
  const requests = [];
  const api = load('src/lib/providers/linkkf.ts', {
    '@/lib/db': { DEFAULT_LINKKF_URL: base, getLinkkfBaseUrl: async () => baseUrl },
    '@/lib/linkaniSettings': settings,
  }, {
    ...globals,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(await fetchPage(String(url)), { status: 200 });
    },
  });
  return { ...api, requests };
}
function watch(data) {
  return `<script>var player_aaaa=${JSON.stringify(data)};</script>`;
}
function card(id, title) {
  return `<div class="vod-item"><div class="img-wrapper" data-original="/posters/${id}.jpg"></div><h3><a href="/ani/${id}/">${title}</a></h3></div>`;
}

test('retired Linkkf root settings move to Linkani; custom mirrors remain intact', () => {
  for (const value of [undefined, '', 'https://linkkf.tv/', 'http://www.linkkf.app', 'https://kr.linkkf.net/']) {
    assert.equal(settings.normalizeLinkaniBaseUrl(value), base);
  }
  for (const value of ['https://custom.example', 'https://linkkf.tv/custom', 'https://linkkf.tv.example']) {
    assert.equal(settings.normalizeLinkaniBaseUrl(` ${value}/ `), value);
  }
});

test('DB and environment settings migrate old defaults using the existing key', async () => {
  for (const stored of [null, 'https://linkkf.tv/', 'https://mirror.example/']) {
    const sql = async strings => strings.join('').includes("WHERE key = 'linkkf_base_url'") && stored
      ? [{ value: stored }] : [];
    const db = load('src/lib/db.ts', {
      postgres: () => sql,
      './episodeMapping': {}, './subtitleLocalIdentity': {}, './linkaniSettings': settings,
    }, { process: { env: { DATABASE_URL: 'mock', LINKKF_BASE_URL: 'https://linkkf.tv' } } });
    assert.equal(db.DEFAULT_LINKKF_URL, base);
    assert.equal(await db.getLinkkfBaseUrl(), stored?.includes('mirror') ? 'https://mirror.example' : base);
    assert.equal(db.STREAMING_PROVIDER_LABELS.linkkf, 'Linkani');
  }
});

test('search uses the native query form and keeps keywords on subsequent pages', async () => {
  const p = provider(() => `${card(42, '검색 결과')}<ul class="ewave-page"><a href="/view/?wd=x&amp;page=4">4</a></ul>`);
  const result = await p.searchAnime('은혼 & 극장판', 2);
  const url = new URL(p.requests[0].url);
  assert.equal(url.pathname, '/view/');
  assert.equal(url.searchParams.get('wd'), '은혼 & 극장판');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(result.total_pages, 4);
  assert.equal(result.has_next, true);
  assert.equal(result.items[0].poster, `${base}/posters/42.jpg`);
});

test('empty searches do not fetch and the last results page ends correctly', async () => {
  const p = provider(() => `${card(42, '검색 결과')}<ul class="ewave-page"><a href="javascript:;">→</a></ul>`);
  assert.equal((await p.searchAnime(' ')).items.length, 0);
  assert.equal(p.requests.length, 0);
  assert.equal((await p.searchAnime('은혼')).has_next, false);
});

test('catalog filters, paging, posters and referers use the configured mirror', async () => {
  const mirror = 'https://mirror.example';
  const p = provider(() => `${card(42, '작품')}<a href="/list/2/page/3/">3</a>`, {}, mirror);
  const result = await p.getAnimeListFiltered({ genre: 'Fantasy', year: '2020', typeLang: 'TV', page: 2 });
  assert.equal(p.requests[0].url, `${mirror}/list/2/class/Fantasy/year/2020/lang/TV/page/2/`);
  assert.equal(result.total_pages, 3);
  const list = await p.getAnimeList({ category: 'top' });
  assert.equal(list.items[0].poster, `${mirror}/posters/42.jpg`);
  assert.equal(p.requests[1].options.headers.Referer, `${mirror}/`);
  assert.equal(p.linkkfProvider.name, 'linkkf');
  assert.equal(p.linkkfProvider.displayName, 'Linkani');
});

test('detail keeps subtitle and dub playlists separate and ordered', async () => {
  const p = provider(() => `<h1 class="detail-info-title">작품</h1><div class="detail-img"><img data-original="/poster.jpg"></div>
    <div class="episode-box"><ul id="ewave-playlist-1"><a class="ep" href="/watch/42/a1/k2/">2</a><a class="ep" href="/watch/42/a1/k1/">1</a></ul>
    <ul id="ewave-playlist-2"><a class="ep" href="/watch/42/a2/k1/">1</a></ul></div>`);
  const detail = await p.getAnimeDetail('42');
  assert.equal(detail.title, '작품');
  assert.equal(detail.sub_episodes.length, 2);
  assert.equal(detail.sub_episodes[0].watch_url, `${base}/watch/42/a1/k1/`);
  assert.equal(detail.dub_episodes.length, 1);
});

test('direct signed HLS and subtitle URLs bypass HTML-player scraping', async () => {
  const data = {
    actual_url: 'https://cdn.example/video.m3u8?md5=abc&expires=2000000000',
    subtitle_url: 'https://cdn.example/sub.vtt?md5=xyz&expires=2000000000',
    link_next: '/watch/42/a1/k2/', link_pre: '/watch/42/a1/k1/',
  };
  const p = provider(() => watch(data));
  const stream = await p.getEpisodeStream('https://linkkf.tv/watch/42/a1/k1/');
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].url, `${base}/watch/42/a1/k1/`);
  assert.equal(p.requests[0].options.cache, 'no-store');
  assert.equal(stream.m3u8_url, data.actual_url);
  assert.equal(stream.vtt_url, data.subtitle_url);
  assert.equal(stream.player_url, `${base}/watch/42/a1/k1/`);
  assert.equal(stream.link_next, `${base}/watch/42/a1/k2/`);
  assert.equal(stream.stream_type, 'm3u8');
  assert.equal(stream.embed_url, undefined);
});

test('signed stream cache refreshes before either video or subtitle expires', async () => {
  let now = 1000000;
  class Clock extends Date { static now() { return now; } }
  const p = provider(() => watch({ actual_url: 'https://cdn.example/a.m3u8?expires=1600', subtitle_url: '/sub.vtt?expires=1100' }), { Date: Clock });
  const url = `${base}/watch/42/a1/k1/`;
  await p.getEpisodeStream(url);
  now += 60000;
  await p.getEpisodeStream(url);
  assert.equal(p.requests.length, 1);
  now += 11000;
  await p.getEpisodeStream(url);
  assert.equal(p.requests.length, 2);
});

test('custom HTML-player mirrors still resolve relative media and episode links', async () => {
  const mirror = 'https://mirror.example';
  const p = provider(url => url.endsWith('/embed')
    ? `videoUrl: '/video.m3u8'; tracks: [{file: '/sub.vtt'}]`
    : watch({ actual_url: '/embed', link_next: '/watch/42/a1/k2/' }), {}, mirror);
  const stream = await p.getEpisodeStream(`${mirror}/watch/42/a1/k1/`);
  assert.equal(stream.m3u8_url, `${mirror}/video.m3u8`);
  assert.equal(stream.vtt_url, `${mirror}/sub.vtt`);
  assert.equal(stream.link_next, `${mirror}/watch/42/a1/k2/`);
  assert.equal(p.requests.length, 2);
});

test('peer connection APIs and vendor aliases stay blocked across repeat initialization', () => {
  let originalCalls = 0;
  const target = { RTCPeerConnection: function () { originalCalls++; } };
  blockPeerConnections(target);
  blockPeerConnections(target);
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    assert.throws(() => new target[name](), { name: 'NotAllowedError' });
    assert.equal(Reflect.set(target, name, function () {}), false);
    assert.equal(Reflect.deleteProperty(target, name), false);
  }
  assert.equal(originalCalls, 0);
});

test('P2P guard fails closed when a locked native API cannot be replaced', () => {
  const target = {};
  Object.defineProperty(target, 'RTCPeerConnection', { value: function () {} });
  assert.throws(() => blockPeerConnections(target), { name: 'TypeError' });
});

test('upstream scripts and iframe-only players cannot become a Linkani playback fallback', async () => {
  const p = provider(url => url.endsWith('/embed')
    ? '<iframe src="https://p2p.example/player"></iframe><script>throw Error("must not execute")</script>'
    : watch({ actual_url: '/embed' }));
  assert.equal(await p.getEpisodeStream(`${base}/watch/42/a1/k1/`), null);
});
