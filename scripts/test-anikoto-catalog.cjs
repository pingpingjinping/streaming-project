const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const ts = require('typescript');
const root = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, deps = {}, globals = {}) {
  deps = {'@/lib/koreanSubtitleCatalog': {getKoreanSubtitleCatalog: async () => {
    throw Error('Anikoto tests must not request the Korean subtitle catalog');
  }}, ...deps};
  // HomePage imports its search-only modules even in unrelated catalog tests.
  deps = {
    '@/components/AnissiaDbSearchFallback': { default: () => null },
    '@/lib/anissiaSearchStages': { prepareAnissiaApiSearch: (result) => ({result, needsDbFallback: result.items.length === 0}) },
    '@/lib/cloudflareAnimeSearch': { searchCloudflareAnimeFirst: async () => null },
    '@/lib/animeSearchMode': {
      resolveAnimeSearchMode: (source, scope, mode) => source === 'anissia' && scope === 'current' && mode !== 'page' ? 'db' : 'page',
      shouldQueryCloudflare: mode => mode === 'db',
      shouldUseLocalDbFallback: mode => mode === 'db',
    },
    ...deps,
  };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true},
  }).outputText;
  vm.runInNewContext(code, {exports, require: name => deps[name] || require(name), URL, URLSearchParams, AbortSignal, console, ...globals});
  return exports;
}
const catalog = load('src/lib/anikotoCatalog.ts');
const base = 'https://anikoto.example';
const filters = {genre: '35', year: '2010', typeLang: 'TV', status: 'finished-airing', sort: 'score'};
function html(count = 1, pages = [2, 298]) {
  return `<html><div id="list-items">${Array.from({length: count}, (_, i) => `<div class="item"><a href="/watch/show-${i}"><span class="name">Show ${i}</span></a></div>`).join('')}</div><ul class="pagination">${pages.map(page => `<li><a href="/filter?page=${page}">${page}</a></li>`).join('')}</ul></html>`;
}
function provider(fetchPage, chromiumPage = () => {throw Error('unexpected Chromium');}) {
  const requests = [], browserRequests = [];
  const api = load('src/lib/providers/anikoto.ts', {
    '@/lib/anikotoCatalog': catalog,
    '@/lib/db': {DEFAULT_ANIKOTO_URL: base, getAnikotoBaseUrl: async () => base},
    './ids': {toAnikotoId: slug => `ak_${slug}`, stripAnikotoId: id => id.replace(/^ak_/, '')},
    '@/lib/chromiumFetch': {fetchHtmlWithChromium: async url => {browserRequests.push(url); return chromiumPage(url);}},
  }, {fetch: async url => {requests.push(url); return new Response(await fetchPage(url));}, console: {error() {}}});
  return {...api, requests, browserRequests};
}
test('native filter IDs, array fields, keyword and page are encoded together', () => {
  const url = new URL(catalog.anikotoCatalogUrl(base, {...filters, keyword: 'Hidamari & Sketch', page: 3}));
  assert.equal(url.pathname, '/filter');
  assert.deepEqual(Object.fromEntries(url.searchParams), {keyword: 'Hidamari & Sketch', 'genre[]': '35', 'year[]': '2010', 'term_type[]': 'TV', 'status[]': 'finished-airing', sort: 'score', page: '3'});
  const invalid = new URL(catalog.anikotoCatalogUrl(base, {genre: 'Fantasy', year: 'oops', typeLang: 'bogus', status: 'bogus', sort: 'year_desc', page: -1}));
  assert.equal(invalid.search, '');
});
test('small pages still expose the actual last page and next link without launching Chromium', async () => {
  const p = provider(() => html(2));
  const result = await p.getAnimeListFiltered({...filters, page: 1});
  assert.equal(result.items.length, 2);
  assert.equal(result.total_pages, 298);
  assert.equal(result.has_next, true);
  assert.equal(p.browserRequests.length, 0);
  assert.equal(new URL(p.requests[0]).searchParams.get('year[]'), '2010');
});
test('a full last page ends from pagination rather than card count', async () => {
  const p = provider(() => html(30, [1, 297]));
  const result = await p.getAnimeList({page: 298});
  assert.equal(result.has_next, false);
  assert.equal(result.total_pages, 298);
});
test('search preserves all filters on later pages', async () => {
  const p = provider(() => html(1, [1, 4, 9]));
  const result = await p.searchAnime('Hidamari Sketch', 3, filters);
  const url = new URL(p.requests[0]);
  assert.equal(url.searchParams.get('keyword'), 'Hidamari Sketch');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('genre[]'), '35');
  assert.equal(url.searchParams.get('term_type[]'), 'TV');
  assert.equal(result.total_pages, 9);
});
test('empty filtered lists do not import sidebar recommendations or fall back to unfiltered quick search', async () => {
  const p = provider(() => html(0, []).replace('</html>', '<aside><a href="/watch/unrelated" title="Unrelated"></a></aside></html>'));
  const result = await p.searchAnime('No match', 1, filters);
  assert.equal(result.items.length, 0);
  assert.equal(result.error, undefined);
  assert.equal(p.requests.length, 1);
});
test('Chromium fallback receives the same filtered URL after a blocked normal response', async () => {
  const p = provider(() => '<html>Access denied</html>', () => html());
  const result = await p.getAnimeListFiltered({...filters, page: 2});
  assert.equal(result.items.length, 1);
  assert.deepEqual(p.requests, p.browserRequests);
});
test('transport failures expose an error and cannot discard filters or requested page', async () => {
  const p = provider(() => {throw Error('timeout');}, () => {throw Error('timeout');});
  const result = await p.searchAnime('Hidamari', 2, filters);
  assert.equal(result.items.length, 0);
  assert.ok(result.error);
  assert.equal(result.page, 2);
  assert.equal(p.requests.length, 1);
});
test('unfiltered first-page quick search remains available without invented pagination', async () => {
  const p = provider(url => url.includes('/ajax/') ? JSON.stringify({status: 200, result: html(25, [])}) : '<html>Blocked</html>', () => '<html>Blocked</html>');
  const result = await p.searchAnime('Hidamari', 1);
  assert.equal(result.items.length, 25);
  assert.equal(result.has_next, false);
  assert.equal(result.total_pages, 1);
  assert.equal(p.requests.length, 2);
});
function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
}
test('filter form includes native options and resets pagination while keeping the keyword', () => {
  const {default: Form} = load('src/components/AnikotoCatalogFilters.tsx', {'next/link': {}, '@/lib/anikotoCatalog': catalog});
  const nodes = descendants(Form({params: filters, keyword: 'Hidamari Sketch'}));
  assert.deepEqual(nodes.filter(n => n.type === 'select').map(n => [n.props.name, n.props.defaultValue]), [['genre','35'], ['year','2010'], ['type','TV'], ['status','finished-airing'], ['sort','score']]);
  assert.equal(nodes.find(n => n.props?.name === 'page').props.value, '1');
  assert.equal(nodes.find(n => n.props?.name === 'q').props.defaultValue, 'Hidamari Sketch');
  assert.equal(nodes.find(n => n.props?.href).props.href, '/?tab=airing&q=Hidamari%20Sketch');
});
test('home page forwards filters and preserves them in next-page URLs for listing and search', async () => {
  for (const q of ['', 'Hidamari']) {
    const calls = [];
    const result = {items: [{id: 'ak_test', title: 'Test', poster: '', detail_url: '/anime/ak_test', remarks: ''}], has_next: true, total_pages: 8};
    const {default: Home} = load('src/app/page.tsx', {
      '@/lib/linkedReanimeCatalog': {}, '@/components/Navbar': {}, '@/components/AnimeCard': {}, '@/components/HistoryList': {}, '@/components/ReanimeFeedFallback': {}, '@/components/AnikotoCatalogFilters': {},
      'next/headers': {cookies: async () => ({get: () => ({value: 'anikoto'})})}, 'next/navigation': {}, 'next/link': {}, 'lucide-react': {},
      '@/lib/providers/ohli24': {}, '@/lib/historyPromotion': {},
      '@/lib/db': {getEnabledStreamingProviders: async () => ['anikoto']},
      '@/lib/subtitles': {resolveKoreanTitle: async value => value}, '@/lib/auth': {requireAuth: async () => ({})},
      '@/lib/providers': {getProvider: () => ({getAnimeListFiltered: async params => {calls.push(params); return result;}, searchAnime: async (keyword, page, params) => {calls.push({...params, keyword, page}); return result;}})},
    });
    const tree = await Home({searchParams: Promise.resolve({tab: 'airing', q, genre: '35', year: '2010', type: 'TV', status: 'finished-airing', sort: 'score', page: '2'})});
    assert.equal(calls[0].genre, '35');
    assert.equal(calls[0].status, 'finished-airing');
    assert.equal(calls[0].page, 2);
    const next = descendants(tree).find(n => n.props?.href && new URL(n.props.href, base).searchParams.get('page') === '3');
    const params = new URL(next.props.href, base).searchParams;
    for (const [key, value] of Object.entries({genre: '35', year: '2010', type: 'TV', status: 'finished-airing', sort: 'score'})) assert.equal(params.get(key), value);
    if (q) assert.equal(params.get('q'), q);
  }
});
test('authenticated list API uses the same filters and returns Anikoto metadata', async () => {
  for (const q of ['', 'Hidamari']) {
    const calls = [];
    const {GET} = load('src/app/api/anime/list/route.ts', {
      '@/lib/linkedReanimeCatalog': {}, '@/lib/anikotoCatalog': catalog,
      '@/lib/providers/ohli24': {}, '@/lib/auth': {getSessionUser: async () => ({})},
      '@/lib/db': {getAnissiaCatalogCaptionsOnly: async () => false},
      'next/server': {NextResponse: {json: value => value}},
      '@/lib/providers': {getProvider: () => ({getAnimeListFiltered: async params => {calls.push(params); return {items: []};}, searchAnime: async (keyword, page, params) => {calls.push({...params, keyword, page}); return {items: []};}})},
    });
    const response = await GET({url: `${base}/api/anime/list?source=anikoto&page=3&genre=35&year=2010&type=TV&status=finished-airing&sort=score&q=${q}`});
    assert.equal(calls[0].genre, '35');
    assert.equal(calls[0].typeLang, 'TV');
    assert.equal(calls[0].status, 'finished-airing');
    assert.equal(calls[0].page, 3);
    assert.deepEqual(plain(response.filters.genres), plain(catalog.ANIKOTO_GENRES));
    assert.deepEqual(plain(response.filters.types), plain(catalog.ANIKOTO_TYPES));
  }
});
test('Anikoto search retains native data-jp identity rather than only the displayed title', async () => {
  const p = provider(() => '<div id="list-items"><div class="item"><a data-jp="パリに咲くエトワール" href="/watch/etoile"><span class="name">Paris ni Saku Etoile</span></a></div></div>');
  const result = await p.searchAnime('Paris ni Saku Etoile');
  assert.equal(result.items[0].original_title,'パリに咲くエトワール');
});
test('Anikoto detail keeps the full work heading and native title for resolver validation', async () => {
  const p = provider(url => url.includes('/ajax/episode/list/')
    ? JSON.stringify({status:200,result:'<a data-num="1" data-ids="token" data-sub="1" data-slug="1"></a>'})
    : '<meta property="og:title" content="Watch Paris ni Saku Etoile at Anikoto"><div id="watch-main" data-id="123" data-url="https://anikoto.example/watch/etoile"></div><h1 data-jp="パリに咲くエトワール">Paris ni Saku Etoile</h1>');
  const detail = await p.getAnimeDetail('ak_etoile');
  assert.equal(detail.title,'Paris ni Saku Etoile');
  assert.equal(detail.original_title,'パリに咲くエトワール');
  assert.equal(detail.sub_episodes[0].number,1);
});

