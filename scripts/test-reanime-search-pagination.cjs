const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/providers/reanime.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const rows = (prefix, count, year = 2026) => Array.from({ length: count }, (_, i) => ({
  anime_id: `${prefix}-${i}`, title: { english: `${prefix} ${i}` }, season_year: year,
}));
const ids = result => Array.from(result.items, item => item.id);

function provider(data, mapped = ['alpha', 'beta']) {
  let now = 0, base = 'https://rean.example', failed = false, cleanup;
  const calls = [];
  const context = vm.createContext({
    exports: {}, URL, URLSearchParams, AbortSignal,
    Date: class extends Date { static now() { return now; } },
    console: { warn() {}, error() {} },
    setInterval: callback => { cleanup = callback; return { unref() {} }; },
    require: name => ({
      './ids': { toReanimeId: id => id.startsWith('re_') ? id : `re_${id}`, stripReanimeId: id => id.replace(/^re_/, '') },
      '../episodeMapping': { reviewedReanimeProjection: () => null },
      '@/lib/reanimeMatches': { findReanimeSearchTitles: () => [], findReanimeSearchTitlesFromDb: async () => mapped,
        getBundledReanimeMatch: () => null },
      '@/lib/db': { getReanimeBaseUrl: async () => base },
    })[name] ?? require(name),
    fetch: async raw => {
      const url = new URL(raw);
      if (url.hostname === 'r.jina.ai') return new Response('', { status: 503 });
      const term = url.searchParams.get('q'), offset = Number(url.searchParams.get('offset'));
      calls.push({ term, offset, year: url.searchParams.get('year'), sort: url.searchParams.get('sort'), host: url.host });
      if (failed && term === 'beta') return new Response('', { status: 503 });
      const items = typeof data === 'function' ? data(term, url) : data[term] || [];
      return Response.json({ results: items.slice(offset, offset + 20), total: items.length });
    },
  });
  vm.runInContext(code, context);
  return {
    search: (page = 1, options = {}, keyword = 'query') => context.exports.searchAnime(keyword, page, options), calls,
    setTime: value => { now = value; }, setBase: value => { base = value; }, fail: value => { failed = value; },
    sweep: () => cleanup(),
    cache: () => JSON.parse(vm.runInContext('JSON.stringify({entries:mergedSearchCache.size,items:[...mergedSearchCache.values()].reduce((n,s)=>n+s.items.length,0)})', context)),
  };
}

test('15 + 15 distinct matches produce pages of 20 and 10 with no lost overflow', async () => {
  const p = provider({ alpha: rows('a', 15), beta: rows('b', 15) });
  const first = await p.search(), second = await p.search(2), pastEnd = await p.search(3);
  assert.equal(first.items.length, 20); assert.equal(first.has_next, true); assert.equal(first.total_pages, 2);
  assert.equal(second.items.length, 10); assert.equal(second.has_next, false); assert.equal(second.total_pages_exact, true);
  assert.equal(new Set([...ids(first), ...ids(second)]).size, 30);
  assert.equal(pastEnd.items.length, 0); assert.equal(pastEnd.has_next, false);
  assert.equal(p.calls.length, 2);
});

test('later rounds append to the union and never displace previously displayed works', async () => {
  const data = { alpha: rows('a', 45), beta: rows('b', 25) };
  const p = provider(data), pages = [];
  for (let page = 1; page <= 4; page++) pages.push(await p.search(page));
  assert.deepEqual(pages.map(r => r.items.length), [20, 20, 20, 10]);
  assert.equal(new Set(pages.flatMap(ids)).size, 70);
  assert.deepEqual(ids(await p.search(1)), ids(pages[0]));
  assert.equal(pages[0].total_pages_exact, false);
  assert.equal(pages[3].total_pages, 4); assert.equal(pages[3].has_next, false);
  assert.deepEqual(p.calls.map(c => [c.term, c.offset]), [['alpha',0],['beta',0],['alpha',20],['beta',20],['alpha',40]]);
  assert.deepEqual(ids(await provider(data).search(3)), ids(pages[2]));
});

test('duplicate-only trailing pages do not advertise a phantom next page', async () => {
  const shared = rows('same', 20);
  const p = provider({ alpha: [...shared, ...shared], beta: shared });
  const result = await p.search();
  assert.equal(result.items.length, 20); assert.equal(result.has_next, false);
  assert.equal(result.total_pages, 1); assert.equal(result.total_pages_exact, true);
});

test('overlap across terms and batches is removed while unique trailing works survive', async () => {
  const p = provider({ alpha: rows('a', 25), beta: [...rows('a', 20), ...rows('b', 15)] });
  const first = await p.search(), second = await p.search(2);
  assert.equal(first.items.length, 20); assert.equal(second.items.length, 20);
  assert.equal(new Set([...ids(first), ...ids(second)]).size, 40);
  assert.equal(second.has_next, false);
});

test('concurrent page requests share batch fetches and produce the same complete union', async () => {
  const p = provider({ alpha: rows('a', 25), beta: rows('b', 25) });
  const result = await Promise.all([p.search(1), p.search(2), p.search(3), p.search(1)]);
  assert.deepEqual(result.map(r => r.items.length), [20, 20, 10, 20]);
  assert.deepEqual(ids(result[0]), ids(result[3]));
  assert.equal(p.calls.length, 4);
});

test('failed batches neither drop a term nor advance its cursor; retry restores all results', async () => {
  const p = provider({ alpha: rows('a', 15), beta: rows('b', 15) });
  p.fail(true);
  assert.ok((await p.search()).error);
  assert.equal(p.cache().items, 0);
  p.fail(false);
  const first = await p.search(), second = await p.search(2);
  assert.equal(new Set([...ids(first), ...ids(second)]).size, 30);
  assert.deepEqual(p.calls.map(c => c.offset), [0, 0, 0, 0]);
});

test('year-filtered pages fill from later batches and cache keys separate filters and origins', async () => {
  const p = provider({ alpha: [...rows('old', 20, 2025), ...rows('new', 25)], beta: [] });
  const first = await p.search(1, { year: '2026', sort: 'year_desc' });
  assert.equal(first.items.length, 20); assert.ok(ids(first).every(id => id.startsWith('re_new')));
  assert.equal((await p.search(2, { year: '2026', sort: 'year_desc' })).items.length, 5);
  const calls = p.calls.length;
  await p.search(1, { year: '2026', sort: 'year_asc' });
  assert.ok(p.calls.length > calls);
  const before = p.calls.length;
  p.setBase('https://new-rean.example'); await p.search(1, { year: '2026', sort: 'year_asc' });
  assert.ok(p.calls.length > before); assert.equal(p.calls.at(-1).host, 'new-rean.example');
  assert.equal((await p.search(1, { year: '2025' })).items.length, 20);
});

test('expired entries are swept and cold page requests rebuild without skipping the first batch', async () => {
  const p = provider({ alpha: rows('a', 15), beta: rows('b', 15) });
  const second = await p.search(2);
  p.setTime(60000); p.sweep(); assert.equal(p.cache().entries, 0);
  assert.deepEqual(ids(await p.search(2)), ids(second));
  assert.deepEqual(p.calls.map(c => c.offset), [0, 0, 0, 0]);
});

test('search cache bounds both query count and retained item count', async () => {
  const p = provider({ alpha: rows('a', 30), beta: rows('b', 30) });
  for (let year = 2000; year < 2040; year++) await p.search(1, { sort: String(year) });
  assert.ok(p.cache().entries <= 32); assert.ok(p.cache().items <= 2000);
  const large = provider({ alpha: rows('a', 1200), beta: rows('b', 1200) });
  assert.equal((await large.search(105)).items.length, 20);
  assert.ok(large.cache().items <= 2000);
});

test('genuinely empty mapped searches keep the existing fallback and plain searches keep upstream paging', async () => {
  const p = provider({ query: rows('fallback', 25) });
  assert.equal((await p.search()).items.length, 20);
  assert.equal((await p.search(2)).items.length, 5);
  const plain = provider({ query: rows('plain', 25) }, []);
  assert.equal((await plain.search(2)).items.length, 5);
  assert.deepEqual(plain.calls.map(c => c.offset), [20]);
});

test('search page renders next/previous controls and does not restart title fallbacks past the end', async () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const empty = () => null, calls = [];
  let result = { items: [{ id: 're_a', title: 'A', poster: '', detail_url: '/anime/re_a' }],
    page: 1, has_next: true, total_pages: 2, total_pages_exact: false };
  const deps = {
    '@/lib/adminWorkTitles': { applyAdminWorkTitles: async items => items },
    '@/components/ReanimeFeedFallback': { __esModule: true, default: () => React.createElement('div', null, 'UNFILTERED_FALLBACK') },
    '@/lib/linkedReanimeCatalog': {},
    '@/lib/manualSubtitleSearch': {},
    '@/lib/anissiaSearchStages': {},
    '@/lib/cloudflareAnimeSearch': {},
    '@/lib/animeSearchMode': { resolveAnimeSearchMode: () => 'page', shouldQueryCloudflare: () => false,
      shouldUseLocalDbFallback: () => false },
    '@/lib/koreanSubtitleCatalog': {},
    '@/lib/providers': { getProvider: () => ({ searchAnime: async term => { calls.push(term); return result; } }),
      LINKKF_GENRES: [], LINKKF_YEARS: [], LINKKF_TYPES: [], REANIME_GENRES: [], ANISSIA_PRIMARY_GENRES: [], ANISSIA_ALL_GENRES: [] },
    '@/lib/providers/ohli24': { OHLI24_GENRES: [] },
    '@/lib/db': { getEnabledStreamingProviders: async () => ['reanime'] },
    '@/lib/subtitles': { resolveKoreanTitle: async q => q },
    '@/lib/historyPromotion': {}, '@/lib/auth': { requireAuth: async () => ({ username: 'test' }) },
    'next/headers': { cookies: async () => ({ get: () => ({ value: 'reanime' }) }) },
    'next/link': { __esModule: true, default: ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children) },
    'next/navigation': {}, 'lucide-react': new Proxy({}, { get: () => empty }),
  };
  const exports = {};
  const pageCode = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/app/page.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(pageCode, { exports, URL, URLSearchParams, console,
    require: id => id in deps ? deps[id] : id.startsWith('@/components/')
      ? { __esModule: true, default: empty } : require(id) });
  const render = async page => renderToStaticMarkup(await exports.default({
    searchParams: Promise.resolve({ q: 'sample title query', page: String(page) }),
  }));
  const first = await render(1);
  assert.ok(first.includes('1 페이지')); assert.ok(!first.includes('1 / 2 페이지'));
  assert.ok(first.includes('page=2')); assert.equal(calls.length, 1);
  result = { ...result, page: 2, has_next: false, total_pages_exact: true };
  assert.ok((await render(2)).includes('2 / 2 페이지'));
  result = { ...result, page: 3, items: [] };
  const pastEnd = await render(3);
  assert.equal(calls.length, 3); assert.ok(!pastEnd.includes('UNFILTERED_FALLBACK')); assert.ok(pastEnd.includes('page=2')); assert.ok(!pastEnd.includes('page=4'));
  result = { ...result, page: 2, total_pages_exact: false, error: 'Search temporarily failed' };
  const failed = await render(2);
  assert.equal(calls.length, 4); assert.ok(failed.includes('Search temporarily failed'));
});
