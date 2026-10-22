const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.join(__dirname, '..');
function load(file, deps = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => id in deps ? deps[id] : require(id),
    console: { warn() {} } });
  return exports;
}
const item = (id, extra = {}) => ({ id, title: '은혼', poster: '', remarks: '',
  detail_url: id.startsWith('db_') ? '/catalog/' + id.slice(3).replace('_', '/') : '/anime/' + id, ...extra });
const stream = (id, ak, extra = {}) => ({ source: 'AniList', source_record_id: id,
  anikoto_id: ak, link_status: 'reviewed', ...extra });
function fixture(rows = {}, customSql) {
  const calls = [];
  const sql = customSql || (async (strings, ...params) => {
    const query = strings.join('?'); calls.push({ query, params });
    for (const [needle, key] of [
      ['WITH memberships', 'groups'], ['anime_anikoto_work_lookup', 'streams'],
      ['anime_korean_catalog', 'korean'], ['anime_subtitle_work_reanime_links', 'subtitle'],
      ['anime_reanime_matches', 'matches'], ['anime_work_match_overrides', 'overrides'],
    ]) if (query.includes(needle)) return rows[key] || [];
    throw Error('Unexpected SQL ' + query);
  });
  const helpers = load('src/lib/catalogVideoLinkStatus.ts', { '@/lib/db': { getDb: () => rows.noDb ? null : sql } });
  return { ...helpers, calls };
}
const apply = async (rows, items, options = { deduplicate: true }) =>
  fixture(rows).applyCatalogVideoLinkStatus(items, options);

test('only confirmed unlinked AniList gets a red badge; no-title-based merging', async () => {
  const results = await apply({}, [item('db_AniList_1'), item('db_AniList_2'), item('db_Onnada_3')]);
  assert.equal(results.length, 3);
  assert.equal(results[0].video_link_status, 'unlinked');
  assert.equal(results[1].video_link_status, 'unlinked');
  assert.equal(results[2].video_link_status, undefined);
});

test('missing database or a failed table lookup keeps status unknown and every card', async () => {
  const items = [item('db_AniList_1'), item('db_AniList_2')];
  for (const helpers of [fixture({ noDb: true }), fixture({}, async () => { throw Error('offline'); })]) {
    const result = await helpers.applyCatalogVideoLinkStatus(items, { deduplicate: true });
    assert.equal(result.length, 2); assert.ok(result.every(x => x.video_link_status === undefined));
  }
  const direct = await apply({ noDb: true }, [item('db_AniList_3', { detail_url: '/anime/ak_gintama' })]);
  assert.equal(direct[0].video_link_status, 'linked');
});

test('same ReAnime AND Anikoto sets merge despite different catalog IDs and preserve artwork', async () => {
  const result = await apply({
    korean: [1, 2].map(id => ({ source: 'AniList', source_record_id: String(id), reanime_id: 'gintama' })),
    streams: [stream('1', 'gin'), stream('2', 'gin')],
  }, [item('db_AniList_1', { source_name: 'AniList · 한글 이름 등록' }),
    item('db_AniList_2', { source_name: 'AniList', poster: 'https://example.org/poster.jpg' })]);
  assert.equal(result.length, 1); assert.equal(result[0].id, 'db_AniList_1');
  assert.equal(result[0].video_link_status, 'linked');
  assert.equal(result[0].poster, 'https://example.org/poster.jpg');
  assert.equal(result[0].source_name, 'AniList · 한글 이름 등록');
});

test('shared ReAnime with split Anikoto stays as two cards, even in one broader registered group', async () => {
  const groups = [1, 2].flatMap(id => ['db_AniList_1', 'db_AniList_2', 're_combined']
    .map(member_id => ({ work_id: 'db_AniList_' + id, member_id })));
  const result = await apply({ groups, streams: [stream('1', 'part1'), stream('2', 'part2')] },
    [item('db_AniList_1'), item('db_AniList_2')]);
  assert.equal(result.length, 2); assert.ok(result.every(x => x.video_link_status === 'linked'));
});

test('shared Anikoto with split ReAnime stays as two cards', async () => {
  const result = await apply({
    korean: [1, 2].map(id => ({ source: 'AniList', source_record_id: String(id), reanime_id: 'part' + id })),
    streams: [stream('1', 'combined'), stream('2', 'combined')],
  }, [item('db_AniList_1'), item('db_AniList_2')]);
  assert.equal(result.length, 2);
});

test('partial overlap, missing provider and multiple-video subsets never merge', async () => {
  const result = await apply({ streams: [stream('1', 'a'), stream('1', 'b'), stream('2', 'a'), stream('3', 'a')],
    korean: [{ source: 'AniList', source_record_id: '3', reanime_id: 'extra' }] },
    [item('db_AniList_1'), item('db_AniList_2'), item('db_AniList_3')]);
  assert.equal(result.length, 3);
});

test('Anikoto season ranges differ even when provider work IDs match', async () => {
  const result = await apply({ streams: [
    stream('1', 'combined', { link_status: 'multi_reviewed', anikoto_episode_start: 1, anikoto_episode_end: 12 }),
    stream('2', 'combined', { link_status: 'multi_reviewed', anikoto_episode_start: 13, anikoto_episode_end: 24 }),
  ] }, [item('db_AniList_1'), item('db_AniList_2')]);
  assert.equal(result.length, 2); assert.ok(result.every(x => x.video_link_status === 'linked'));
});

test('multi-season links without a range remain linked but cannot establish duplicate identity', async () => {
  const result = await apply({ streams: [1, 2].map(id => stream(String(id), 'combined', { link_status: 'multi_reviewed' })) },
    [item('db_AniList_1'), item('db_AniList_2')]);
  assert.equal(result.length, 2); assert.ok(result.every(x => x.video_link_status === 'linked'));
});

test('manual and release members connect AniList; Anissia metadata alone is not video evidence', async () => {
  const result = await apply({ groups: [
    { work_id: 'db_AniList_1', member_id: 're_gin' },
    { work_id: 'db_AniList_2', member_id: 'ak_gin' },
    { work_id: 'db_AniList_3', member_id: 'ani_9' },
  ] }, [1, 2, 3].map(id => item('db_AniList_' + id)));
  assert.deepEqual(Array.from(result, x => x.video_link_status), ['linked', 'linked', 'unlinked']);
});

test('reviewed ReAnime links find Anikoto indexed on that video; local corrections override imported Anissia pair', async () => {
  const f = fixture({ korean: [{ source: 'AniList', source_record_id: '1', reanime_id: 'gin' }],
    matches: [{ anissia_no: 2, reanime_id: 'stale' }],
    overrides: [{ anissia_no: 2, reanime_id: 'gin' }],
    streams: [stream('gin', 'gin-ak', { source: 'ReAnime' })] });
  const result = await f.applyCatalogVideoLinkStatus([item('db_AniList_1'), item('ani_2'), item('re_gin')], { deduplicate: true });
  assert.equal(result.length, 1);
  const query = f.calls.find(x => x.query.includes('anime_anikoto_work_lookup'));
  assert.ok(query.params[0].includes('ReAnime:gin'));
  assert.equal(f.calls.length, 6); // Batches, not one query for each card.
});

test('non-catalog provider results skip the lookup unless DB search explicitly asks to deduplicate', async () => {
  const f = fixture(); const items = [item('re_gin'), item('ak_gin')];
  assert.equal(await f.applyCatalogVideoLinkStatus(items), items);
  assert.equal(f.calls.length, 0);
});

test('card renders a red text badge and information link only for unlinked AniList', () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const { default: Card } = load('src/components/AnimeCard.tsx', {
    'lucide-react': { PlayCircle: () => null },
    'next/link': { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) },
    '@/components/LocalizedAnimeTitle': { __esModule: true, default: () => null },
    '@/components/DbSearchPoster': { __esModule: true, default: () => null },
  });
  const html = renderToStaticMarkup(React.createElement(Card, { anime: item('db_AniList_1', { video_link_status: 'unlinked' }) }));
  assert.match(html, /영상 연결 없음/); assert.match(html, /bg-red-950/); assert.match(html, /작품 정보/);
  assert.match(html, /href="\/catalog\/AniList\/1"/);
  for (const anime of [item('db_AniList_1'), item('db_AniList_1', { video_link_status: 'linked' }),
    item('re_a', { video_link_status: 'unlinked' })]) {
    const rendered = renderToStaticMarkup(React.createElement(Card, { anime }));
    assert.doesNotMatch(rendered, /영상 연결 없음/); assert.match(rendered, /보러가기/);
  }
});

const direct = load('src/lib/catalogDirectPlayback.ts');
const manual = load('src/lib/manualSubtitleSearch.ts', { '@/lib/db': {}, '@/lib/catalogDirectPlayback': direct });
function pagination(helpers) {
  return load('src/lib/catalogSearchPagination.ts', { './catalogVideoLinkStatus': helpers,
    './manualSubtitleSearch': manual }).searchCatalogVideoPage;
}
test('deduplicates across upstream pages before slicing without losing the following ten works', async () => {
  const rows = { streams: Array.from({ length: 40 }, (_, i) => stream(String(i), 'video' + (i < 20 ? i : i - 10))) };
  const pages = [Array.from({ length: 20 }, (_, i) => item('db_AniList_' + i)),
    Array.from({ length: 20 }, (_, i) => item('db_AniList_' + (i + 20)))];
  const search = pagination(fixture(rows));
  const readPage = async p => ({ items: pages[p - 1] || [], page: p, has_next: p < 2, total_pages: 2 });
  const first = await search({ page: 1, readPage }), second = await search({ page: 2, readPage });
  assert.equal(first.items.length, 20); assert.equal(first.has_next, true);
  assert.equal(second.items.length, 10); assert.equal(second.has_next, false);
  assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 30);
  assert.equal(second.total_pages, 2); assert.equal(second.total_pages_exact, true);
});

test('manual overlay participates before pagination and an empty upstream page is not end-of-search', async () => {
  const search = pagination(fixture({}));
  const readPage = async p => ({ items: p === 2 ? [item('db_AniList_1')] : [], has_next: p === 1 });
  const result = await search({ page: 1, readPage,
    manual: [{ item: item('re_manual'), memberIds: ['re_manual'] }] });
  assert.equal(result.items.length, 2); assert.equal(result.has_next, false);
});

test('a manual work matching a later remote page never shifts already-returned results', async () => {
  const helpers = fixture({ streams: [stream('100', 'manual')] });
  const search = pagination(helpers);
  const pages = [Array.from({ length: 20 }, (_, i) => item('db_AniList_' + i)),
    [item('db_AniList_100'), item('db_AniList_20')]];
  const readPage = async p => ({ items: pages[p - 1], has_next: p < 2 });
  const manual = [{ item: item('ak_manual'), memberIds: ['db_AniList_100', 'ak_manual'] }];
  const first = await search({ page: 1, readPage, manual });
  const second = await search({ page: 2, readPage, manual });
  assert.equal(first.items[0].id, 'ak_manual');
  assert.deepEqual(Array.from(second.items, x => x.id), ['db_AniList_19', 'db_AniList_20']);
  assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 22);
});

test('failed later upstream page is not falsely published as a complete result', async () => {
  const search = pagination(fixture({}));
  const result = await search({ page: 1, readPage: async p => p === 1
    ? { items: [item('db_AniList_1')], has_next: true } : null });
  assert.equal(result, null);
});

test('PostgreSQL resolves persisted group and provider mappings with exact split preservation',
  { skip: !process.env.REVIEWED_TEST_DATABASE_URL }, async () => {
  const postgres = require('postgres'), url = process.env.REVIEWED_TEST_DATABASE_URL;
  const admin = postgres(url, { max: 1, onnotice() {} });
  const schema = 'video_links_' + process.pid + '_' + Date.now();
  let sql;
  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = postgres(url, { max: 1, connection: { search_path: schema }, onnotice() {} });
    await sql.unsafe(`
      CREATE TABLE anime_admin_work_titles(anime_id text,canonical_id text);
      CREATE TABLE anime_admin_subtitle_links(anime_id text,relative_path text);
      CREATE TABLE anime_admin_subtitle_link_members(anime_id text,relative_path text);
      CREATE TABLE anime_release_reviewed_work_group_members(member_id text,group_id text);
      CREATE TABLE anime_korean_catalog(source text,source_record_id text,payload jsonb);
      CREATE TABLE anime_subtitle_work_reanime_links(target_source text,target_id text,reanime_id text,automatic_eligible boolean);
      CREATE TABLE anime_reanime_matches(reanime_id text,anissia_no integer,review_status text);
      CREATE TABLE anime_work_match_overrides(reanime_id text,anissia_no integer);
      CREATE TABLE anime_anikoto_work_lookup(source text,source_record_id text,anikoto_id text,link_status text,
        anikoto_episode_start integer,anikoto_episode_end integer,target_episode_start integer,target_episode_end integer);
      INSERT INTO anime_admin_work_titles VALUES ('db_AniList_1','gin'),('db_Onnada_1','gin'),('re_gin','gin');
      INSERT INTO anime_admin_subtitle_links VALUES ('db_AniList_3','folder');
      INSERT INTO anime_admin_subtitle_link_members VALUES ('re_other','folder');
      INSERT INTO anime_release_reviewed_work_group_members VALUES ('db_AniList_4','release'),('ak_release','release');
      INSERT INTO anime_korean_catalog VALUES ('AniList','2','{"status":"검토된 사항","reanimeId":"gin"}');
      INSERT INTO anime_anikoto_work_lookup VALUES ('ReAnime','gin','gin','reviewed',NULL,NULL,NULL,NULL),
        ('AniList','2','split','reviewed',NULL,NULL,NULL,NULL),
        ('AniList','5','held','hold',NULL,NULL,NULL,NULL);
    `);
    const result = await fixture({}, sql).applyCatalogVideoLinkStatus([
      item('db_AniList_1'), item('db_Onnada_1'), item('re_gin'), item('db_AniList_2'),
      item('db_AniList_3'), item('db_AniList_4'), item('db_AniList_5'),
    ], { deduplicate: true });
    assert.deepEqual(Array.from(result, x => x.id), ['db_AniList_1','db_AniList_2','db_AniList_3','db_AniList_4','db_AniList_5']);
    assert.equal(result.at(-1).video_link_status, 'unlinked');
    assert.ok(result.slice(0, -1).every(x => x.video_link_status === 'linked'));
  } finally {
    await sql?.end(); await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
});
