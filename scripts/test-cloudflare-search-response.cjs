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
