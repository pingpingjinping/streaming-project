const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/anissiaSearchStages.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = vm.createContext({ exports: {} });
vm.runInContext(code, context);
const { prepareAnissiaApiSearch, filterSupplementalDbItems } = context.exports;

const data = items => ({items, page:1, has_next:false, total_pages:1});
const work = (id, captions) => ({id,title:id,poster:'',detail_url:'/anime/'+id,remarks:'',caption_count:captions});

test('upstream Anissia matches stay on fast API stage without querying local DB', () => {
  const original = data([work('ani_1',0)]);
  const got = prepareAnissiaApiSearch(original,false);
  assert.equal(got.needsDbFallback,false);
  assert.deepEqual(Array.from(got.result.items,x=>x.id),['ani_1']);
});

test('saved caption-only filter applies to upstream Anissia results', () => {
  const got = prepareAnissiaApiSearch(data([work('ani_1',0),work('ani_2',2)]),true);
  assert.equal(got.needsDbFallback,false);
  assert.deepEqual(Array.from(got.result.items,x=>x.id),['ani_2']);
});

test('empty API search or filtered-out API works launch the DB fallback stage', () => {
  assert.equal(prepareAnissiaApiSearch(data([]),false).needsDbFallback,true);
  assert.equal(prepareAnissiaApiSearch(data([work('ani_1',0)]),true).needsDbFallback,true);
});

test('optional DB search omits existing Anissia IDs and repeated DB results', () => {
  const upstream = [work('ani_1', 1)];
  const additional = [
    work('ani_1', 1),
    work('ani_2', 3),
    work('ani_2', 3),
    work('ani_3', 2),
  ];
  const shown = filterSupplementalDbItems(additional, upstream);
  assert.deepEqual(Array.from(shown, x => x.id), ['ani_2', 'ani_3']);
});

test('optional DB search never merges distinct season IDs based on title', () => {
  const firstSeason = { ...work('ani_1', 3), title: 'Same title' };
  const secondSeason = { ...work('ani_2', 4), title: 'Same title' };
  const shown = filterSupplementalDbItems([secondSeason], [firstSeason]);
  assert.deepEqual(Array.from(shown, x => x.id), ['ani_2']);
});

test('optional DB search also excludes identical canonical detail links', () => {
  const upstream = [{ id: 'ani_1', detail_url: '/anime/ani_1' }];
  const additional = [{ ...work('db_alias', 2), detail_url: '/anime/ani_1' }, work('db_other', 3)];
  const shown = filterSupplementalDbItems(additional, upstream);
  assert.deepEqual(Array.from(shown, x => x.id), ['db_other']);
});
