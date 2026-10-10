const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/cloudflareSearchResponse.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = vm.createContext({ exports: {}, encodeURIComponent });
vm.runInContext(code, context);
const { convertCloudflareSearchResponse } = context.exports;

const work = (id, detail_url, caption_count = 1) => ({
  id, detail_url, caption_count, title: '작품', poster: '', source_name: 'AniAll',
  remarks: '2026년',
});

test('supplementary Cloudflare cards retain canonical internal routes', () => {
  const data = { items: [
    work('ani_123','/anime/ani_123'),
    work('db_Onnada_456','/catalog/Onnada/456'),
    work('re_demo','/anime/re_demo'),
  ], total_pages: 2, has_next: true };
  const parsed = convertCloudflareSearchResponse(data, 1, false);
  assert.deepEqual(Array.from(parsed.items, x => x.id), ['ani_123','db_Onnada_456','re_demo']);
  assert.equal(parsed.has_next, true);
  assert.equal(parsed.total_pages, 2);
});

test('saved captions filter is honored for Cloudflare result cards', () => {
  const data = { items: [
    work('ani_12','/anime/ani_12',0),
    work('db_AniList_20','/catalog/AniList/20',4),
  ], total_pages: 1, has_next: false };
  assert.deepEqual(
    Array.from(convertCloudflareSearchResponse(data, 1, true).items, x => x.id),
    ['db_AniList_20']
  );
});

test('unsafe or mismatched URL and identity are dropped', () => {
  const data = { items: [
    work('db_Onnada_10','/anime/ani_10'),
    work('ani_10','https://untrusted.example'),
    work('ani_12','/anime/ani_12'),
    work('db_Onnada_11','/catalog/Onnada/11'),
  ] };
  assert.deepEqual(
    Array.from(convertCloudflareSearchResponse(data, 1, false).items, x => x.id),
    ['ani_12','db_Onnada_11']
  );
});

test('invalid Worker response is rejected', () => {
  assert.throws(() => convertCloudflareSearchResponse({ items: null }, 1, false), /Invalid/);
  assert.throws(() => convertCloudflareSearchResponse({ items: new Array(25) }, 1, false), /Invalid/);
});

test('Worker results/total shape is accepted, including total-based pagination', () => {
  const data = { results: [work('ani_4','/anime/ani_4')], total: 41 };
  const parsed = convertCloudflareSearchResponse(data, 1, false);
  assert.deepEqual(Array.from(parsed.items, x => x.id), ['ani_4']);
  assert.equal(parsed.total_pages, 3);
  assert.equal(parsed.has_next, true);
});

function firstSearchWith(mockFetch) {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/cloudflareAnimeSearch.ts'), 'utf8');
  const script = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({
    exports: {}, URL, AbortSignal: { timeout: ms => ({ timeoutMs: ms }) },
    fetch: mockFetch, console: { warn() {} },
    require: () => ({ convertCloudflareSearchResponse }),
  });
  vm.runInContext(script, context);
  return context.exports.searchCloudflareAnimeFirst;
}

test('Cloudflare hits return immediately without invoking Anissia fallback', async () => {
  const calls = [];
  const search = firstSearchWith(async url => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ results: [work('ani_9','/anime/ani_9')], total: 1 }) };
  });
  const result = await search('슬라임', 1, false);
  assert.deepEqual(Array.from(result.items, x => x.id), ['ani_9']);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).searchParams.get('q'), '슬라임');
});

test('Cloudflare empty, filtered or unavailable results trigger Anissia fallback', async () => {
  const missing = firstSearchWith(async () => ({ ok: true, json: async () => ({ results: [], total: 0 }) }));
  assert.equal(await missing('없는제목', 1, false), null);
  const filtered = firstSearchWith(async () => ({
    ok: true, json: async () => ({ items: [work('ani_9','/anime/ani_9',0)], total: 1 }),
  }));
  assert.equal(await filtered('슬라임', 1, true), null);
  const offline = firstSearchWith(async () => { throw new Error('timeout'); });
  assert.equal(await offline('슬라임', 1, false), null);
  const failed = firstSearchWith(async () => ({ ok: false, status: 503 }));
  assert.equal(await failed('슬라임', 1, false), null);
});
