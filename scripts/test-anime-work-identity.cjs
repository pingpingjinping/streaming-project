const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const ts = require('typescript');
const matchOverrides = {getWorkMatchOverrides:async()=>[],importedLinkIsOverridden:()=>false};
function load(file, deps) {
  deps={'../anikotoWorkOverrides':{getAnikotoWorkOverride:async()=>null},'../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:async()=>new Set(),hasWorkMatchCandidates:async()=>false},'../workMatchOverrides':matchOverrides,'./workMatchOverrides':matchOverrides,'../reanimeMatches':{getConfirmedReanimeIdsForAnissia:async()=>new Map(),getEffectiveReanimeIdsForAnissia:async()=>new Map()},...deps};
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
    '../episodeMapping': load('src/lib/episodeMapping.ts', {}),
    '../providers/reanime': {reanimeProvider: {}}, '../providers/linkkf': {linkkfProvider: {}},
    '../providers/ohli24': {ohli24Provider: {}},
    '../db': {getAnissiaStreamCache: async () => null, setAnissiaStreamCache: async () => {}},
    '../providers/anissia': {fetchAniListMeta: async query => {metadataQueries.push(query);return meta;}},
    '../anikotoLinks': {getAnikotoPlaybackCandidates: async () => linked.map(row => ({linkStatus:"reviewed",...row}))},
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


const ensembleNative = '特別編 響け! ユーフォニアム～アンサンブルコンテスト～';
const ensembleRomaji = 'Tokubetsu-hen Hibike! Euphonium: Ensemble Contest';
const ensembleKo = '특별편 울려라! 유포니엄: 앙상블 콘테스트';
const elfenTitle = 'Elfen Lied: Just How Did the Young Girl Arrive at Those Feelings?';
const ensembleMeta = {anilistId:150429,nativeTitle:ensembleNative,romajiTitle:ensembleRomaji};
function reanimeResolver({items = [], details = {}, cache = null, meta = ensembleMeta,
  selected = null, held = false, failedQuery = ''} = {}) {
  const searches = [], streams = [], writes = [], detailCalls = [], metadataQueries = [];
  const api = load('src/lib/resolvers/videoResolver.ts', {
    '../episodeMapping': load('src/lib/episodeMapping.ts', {}),
    '../animeWorkIdentity': {...identity(),getAnimeWorkIdentity:async()=>null},
    '../providers/anissia': {fetchAniListMeta:async q=>{metadataQueries.push(q);return meta;}},
    '../providers/reanime': {reanimeProvider:{
      searchAnime:async q=>{searches.push(q);if(q===failedQuery)throw Error('offline');return {items};},
      getAnimeDetail:async id=>{detailCalls.push(id);return details[id] || null;},
      getEpisodeStream:async url=>{streams.push(url);return {success:true,embed_url:url,server_sources:[]};},
    }},
    '../providers/anikoto':{},'../providers/linkkf':{},'../providers/ohli24':{},
    '../reanimeMatches':{getEffectiveReanimeIdsForAnissia:async()=>selected?new Map([[2425,selected]]):new Map()},
    '../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:async()=>new Set(),hasWorkMatchCandidates:async()=>held},
    '../db':{getAnissiaStreamCache:async()=>cache?{reanime_id:cache}:null,setAnissiaStreamCache:async row=>{writes.push(row);}},
    '../anikotoLinks':{},
  });
  return {...api,searches,streams,writes,detailCalls,metadataQueries,
    run:()=>api.resolveAnissiaStream(2425,1,ensembleKo,ensembleNative,'rean','ani_2425')};
}
const reDetail = (title, anilist_id, identity_titles = [title]) => ({id:'re_detail',title,
  anilist_id,identity_titles,sub_episodes:[{number:1,watch_url:`https://video.example/${anilist_id}/1`}]});
const rightItem = {id:'re_ensemble',title:ensembleRomaji,original_title:ensembleNative,anilist_id:150429};
const wrongItem = {id:'re_elfen',title:elfenTitle,anilist_id:376};

test('ReAnime selects Ensemble in position five and never fetches unrelated episode-one candidates',async()=>{
  const api=reanimeResolver({items:[wrongItem,...['Blue Giant','Wonder Egg Priority','Kill la Kill'].map(title=>({id:title,title})),rightItem],
    details:{re_elfen:reDetail(elfenTitle,376),re_ensemble:reDetail(ensembleRomaji,150429)}});
  assert.equal((await api.run()).success,true);
  assert.deepEqual(api.streams,['https://video.example/150429/1']);
  assert.deepEqual(api.writes.map(x=>x.reanime_id),['re_ensemble']);
  assert.ok(!api.detailCalls.includes('re_elfen'));
  assert.equal(api.searches[0],ensembleNative);
  assert.ok(!api.searches.includes('Tokubetsu'));
  assert.deepEqual(api.metadataQueries,[ensembleNative]);
});
test('ReAnime ignores the Elfen cache and overwrites it only with proven Ensemble playback',async()=>{
  const api=reanimeResolver({cache:'re_elfen',items:[wrongItem,rightItem],
    details:{re_elfen:reDetail(elfenTitle,376),re_ensemble:reDetail(ensembleRomaji,150429)}});
  assert.equal((await api.run()).success,true);
  assert.deepEqual(api.streams,['https://video.example/150429/1']);
  assert.deepEqual(api.writes.map(x=>x.reanime_id),['re_ensemble']);
});
test('ReAnime will not play or refresh a wrong cache when no proven replacement exists',async()=>{
  const api=reanimeResolver({cache:'re_elfen',items:[wrongItem],details:{re_elfen:reDetail(elfenTitle,376)}});
  assert.equal((await api.run()).success,false);
  assert.deepEqual(api.streams,[]);assert.deepEqual(api.writes,[]);
});
test('ReAnime refuses a matching label hiding another raw title or conflicting AniList ID',async()=>{
  for(const wrong of [reDetail(ensembleRomaji,376,[elfenTitle]),reDetail(ensembleRomaji,376,[ensembleRomaji])]) {
    const api=reanimeResolver({items:[rightItem],details:{re_ensemble:wrong}});
    assert.equal((await api.run()).success,false);
    assert.deepEqual(api.streams,[]);assert.deepEqual(api.writes,[]);
  }
});
test('unrelated fuzzy AniList metadata cannot contribute a ReAnime alias',async()=>{
  const api=reanimeResolver({meta:{anilistId:376,nativeTitle:'エルフェンリート',romajiTitle:elfenTitle},
    items:[wrongItem],details:{re_elfen:reDetail(elfenTitle,376)}});
  assert.equal((await api.run()).success,false);
  assert.ok(!api.searches.includes(elfenTitle));assert.deepEqual(api.writes,[]);
});
test('duplicate exact-title ReAnime candidates are not resolved by search ordering',async()=>{
  const api=reanimeResolver({items:[rightItem,{...rightItem,id:'re_duplicate'}],
    details:{re_ensemble:reDetail(ensembleRomaji,150429),re_duplicate:reDetail(ensembleRomaji,150429)}});
  assert.equal((await api.run()).success,false);
  assert.deepEqual(api.streams,[]);assert.deepEqual(api.writes,[]);
});
test('failed complete-native ReAnime search can continue to the proven complete romaji alias',async()=>{
  const api=reanimeResolver({failedQuery:ensembleNative,items:[rightItem],details:{re_ensemble:reDetail(ensembleRomaji,150429)}});
  assert.equal((await api.run()).success,true);
  assert.ok(api.searches.includes(ensembleRomaji));
});
test('reviewed ReAnime identity remains authoritative and a missing episode cannot select another work',async()=>{
  const api=reanimeResolver({selected:'re_reviewed',details:{re_reviewed:reDetail('Reviewed provider alias',150429)}});
  assert.equal((await api.run()).success,true);
  assert.equal(api.searches.length,0);assert.equal(api.metadataQueries.length,0);
  const missing=reanimeResolver({selected:'re_missing',details:{re_missing:{title:'reviewed',sub_episodes:[]}},items:[rightItem]});
  assert.equal((await missing.run()).success,false);
  assert.equal(missing.searches.length,0);assert.equal(missing.writes.length,0);
});
test('combined-season identity requires the same franchise and keeps named specials and parts distinct',()=>{
  const api=reanimeResolver();
  const match=api.matchesVideoPlaybackIdentity;
  assert.equal(match({title:'Example'},['Example Season 2'],2,true),true);
  assert.equal(match({title:'Unrelated'},['Example Season 2'],2,true),false);
  assert.equal(match({title:'Example'},['Example Season 2'],2,false),false);
  assert.equal(match({title:'Example'},['Example Part 2'],null,true),false);
  assert.equal(match({title:'Hibike! Euphonium: Kakedasu Monaka'},[ensembleRomaji],null,true),false);
  assert.equal(match({title:'Ensemble',anilist_id:376},['Ensemble'],150429,false),false);
});

test('Anikoto checks the entire first result page instead of discarding a match after position five',async()=>{
  const api=resolver({items:[...Array.from({length:5},(_,i)=>({id:`ak_wrong${i}`,title:`Other ${i}`})),{id:'ak_right',title:romaji}],
    details:{ak_right:detail(romaji)}});
  assert.equal((await api.run()).success,true);
  assert.deepEqual(api.streams,['https://anikoto.example/correct']);
});
test('Anikoto imported automatic link to an unrelated work cannot contribute a stream',async()=>{
  const api=resolver({linked:[{animeId:'ak_wrong',episodeNumber:1,mappingKind:'whole',linkStatus:'automatic'}],
    details:{ak_wrong:detail('Other Anime')}});
  assert.equal((await api.run()).success,false);
  assert.deepEqual(api.streams,[]);
});
test('Anikoto exact automatic link still plays without a title search',async()=>{
  const api=resolver({linked:[{animeId:'ak_right',episodeNumber:1,mappingKind:'whole',linkStatus:'automatic'}],
    details:{ak_right:detail(romaji)}});
  assert.equal((await api.run()).success,true);
  assert.equal(api.searches.length,0);
});
