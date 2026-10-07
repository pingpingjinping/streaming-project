const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const ts = require('typescript');
function load(file, deps) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  vm.runInNewContext(code, {exports, require: name => deps[name] || require(name), URL, AbortSignal,
    console: {warn() {}, error() {}, log() {}}, fetch: () => {throw Error('unexpected external fetch');}});
  return exports;
}
const korean = '파리에 피는 에투알', native = 'パリに咲くエトワール', romaji = 'Paris ni Saku Étoile';
const root = {title_ko: korean, title_native: native, year: 2027,
  cross_source_ids_json: JSON.stringify({anilist_ids: ['197097'], reanime_ids: ['paris-ni-saku-toile-g5y57f']})};
const movie = {title_native: native, title_romaji: romaji, format: 'MOVIE', year: 2026};
function identity(rootRow = root, linked = [movie]) {
  const calls = [];
  return {...load('src/lib/animeWorkIdentity.ts', {'@/lib/db': {getDb: () => async (sql, ...values) => {
    calls.push(values);
    return calls.length === 1 ? [{payload: JSON.stringify(rootRow)}] : linked.map(payload => ({payload}));
  }}}), calls};
}
test('exact ID and matching declared foreign title identify Etoile as a movie despite source year differences', async () => {
  const api = identity();
  const work = await api.getAnimeWorkIdentity('ani_3468');
  assert.deepEqual(api.calls[0], ['Anissia', '3468']);
  assert.equal(work.format, 'MOVIE');
  assert.ok(work.titles.includes(romaji));
  assert.equal(api.canSelectUnnumberedMovie(work, korean, 1, 1, null), true);
  assert.equal(api.canSelectUnnumberedMovie(work, korean + ' 자막', 1, 1, null), true);
});
test('wrong declared ID titles cannot contribute movie format or aliases', async () => {
  const api = identity(root, [{title_native: '別の作品', title_romaji: 'Other Movie', format: 'MOVIE'}]);
  const work = await api.getAnimeWorkIdentity('ani_3468');
  assert.equal(work.format, null);
  assert.equal(work.titles.includes('Other Movie'), false);
});
test('conflicting formats, unknown work, another title, offset or episode never unlock unnumbered files', async () => {
  const api = identity({...root, format: 'TV'});
  const conflicting = await api.getAnimeWorkIdentity('ani_3468');
  assert.equal(conflicting.format, null);
  const work = {titles: [korean], format: 'MOVIE'};
  for (const args of [[null,korean,1,1,null], [conflicting,korean,1,1,null],
    [work,'다른 영화',1,1,null], [work,korean,2,2,null], [work,korean,1,13,null], [work,korean,1,1,2]]) {
    assert.equal(api.canSelectUnnumberedMovie(...args), false);
  }
});
test('full title normalization permits accents but keeps sequel, OVA and distinguishing subtitle', () => {
  const api = identity();
  assert.equal(api.matchesIdentityTitle('Paris ni Saku Etoile', [romaji]), true);
  for (const title of ['Paris ni Saku Etoile 2', 'Paris ni Saku Etoile OVA', 'Paris ni Saku Etoile - Another Story']) {
    assert.equal(api.matchesIdentityTitle(title, [romaji]), false);
  }
});
function resolver({items = [], details = {}, meta = null, linked = [], failedQuery = "", work = {titles: [korean,native,romaji], format: 'MOVIE'}} = {}) {
  const streams = [], searches = [], detailCalls = [], metadataQueries = [];
  const api = load('src/lib/resolvers/videoResolver.ts', {
    '../providers/reanime': {reanimeProvider: {}}, '../providers/linkkf': {linkkfProvider: {}},
    '../providers/ohli24': {ohli24Provider: {}},
    '../db': {getAnissiaStreamCache: async () => null, setAnissiaStreamCache: async () => {}},
    '../providers/anissia': {fetchAniListMeta: async query => {metadataQueries.push(query);return meta;}},
    '../anikotoLinks': {getAnikotoPlaybackCandidates: async () => linked},
    '../animeWorkIdentity': {...identity(), getAnimeWorkIdentity: async () => work},
    '../providers/anikoto': {anikotoProvider: {
      searchAnime: async query => {searches.push(query); if (query === failedQuery) throw Error("search offline"); return {items};},
      getAnimeDetail: async id => {detailCalls.push(id); return details[id] || null;},
      getEpisodeStream: async url => {streams.push(url); return {success: true, embed_url: url, server_sources: []};},
    }},
  });
  return {...api, streams, searches, detailCalls, metadataQueries,
    run: () => api.resolveAnissiaStream(3468,1,korean,native,'anikoto','ani_3468')};
}
function detail(title, ep = 1, url = 'https://anikoto.example/correct') {
  return {title, sub_episodes: [{number: ep, watch_url: url}]};
}
test('Anikoto rejects the unrelated Etoile result even when episode 1 exists', async () => {
  const api = resolver({items: [{id:'ak_wrong',title:'I★Chu: Halfway Through the Idol'}],
    details: {ak_wrong: detail('I★Chu: Halfway Through the Idol')}});
  assert.equal((await api.run()).success, false);
  assert.equal(api.streams.length, 0);
  assert.equal(api.detailCalls.length, 0);
});
test('Anikoto selects the unique complete-title match rather than search order', async () => {
  const api = resolver({items: [{id:'ak_wrong',title:'Highspeed Etoile'}, {id:'ak_right',title:'Paris ni Saku Etoile'}],
    details: {ak_wrong: detail('Highspeed Etoile'), ak_right: detail(romaji)}});
  assert.equal((await api.run()).success, true);
  assert.deepEqual(api.streams, ['https://anikoto.example/correct']);
  assert.deepEqual(api.detailCalls, ['ak_right']);
});
test('Anikoto rechecks detail identity and refuses duplicate matching IDs', async () => {
  for (const details of [
    {ak_right: detail('Other Anime')},
    {ak_right: detail(romaji), ak_duplicate: detail(romaji)},
  ]) {
    const api = resolver({items: [{id:'ak_right',title:romaji}, {id:'ak_duplicate',title:romaji}], details});
    assert.equal((await api.run()).success, false);
    assert.equal(api.streams.length, 0);
  }
});
test('fuzzy AniList search cannot introduce unrelated aliases', async () => {
  const api = resolver({work:null, meta:{nativeTitle:'ハイスピード エトワール',romajiTitle:'Highspeed Etoile'},
    items:[{id:'ak_wrong',title:'Highspeed Etoile'}], details:{ak_wrong:detail('Highspeed Etoile')}});
  assert.equal((await api.run()).success,false);
  assert.equal(api.searches.includes('Highspeed Etoile'),false);
  assert.equal(api.streams.length,0);
});
test('verified native AniList match can supply romaji when catalog DB is unavailable', async () => {
  const api = resolver({work:null,meta:{nativeTitle:native,romajiTitle:romaji},
    items:[{id:'ak_right',title:romaji}],details:{ak_right:detail(romaji)}});
  assert.equal((await api.run()).success,true);
});
test('reviewed Anikoto mapping and episode offset stay authoritative', async () => {
  const api = resolver({linked:[{animeId:'ak_linked',episodeNumber:13}],
    details:{ak_linked:detail('Different merged-season page label',13,'https://anikoto.example/13')}});
  assert.equal((await api.run()).success,true);
  assert.deepEqual(api.streams,['https://anikoto.example/13']);
  assert.equal(api.searches.length,0);
});

test('one failed Anikoto alias search does not discard a proven match from another query', async () => {
  const api = resolver({failedQuery:native,items:[{id:'ak_right',title:romaji}],details:{ak_right:detail(romaji)}});
  assert.equal((await api.run()).success,true);
  assert.equal(api.metadataQueries.length,0);
  assert.equal(api.streams.length,1);
});
