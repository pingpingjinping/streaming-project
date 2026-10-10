const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const ts = require('typescript');
const root = path.join(__dirname, '..');
const matchOverrides = {getWorkMatchOverrides:async()=>[], importedLinkIsOverridden:()=>false};
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, deps = {}, globals = {}) {
  deps={'../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:async()=>new Set(),hasWorkMatchCandidates:async()=>false},'../workMatchOverrides':matchOverrides,'./workMatchOverrides':matchOverrides,'../reanimeMatches':{getConfirmedReanimeIdsForAnissia:async()=>new Map(),getEffectiveReanimeIdsForAnissia:async()=>new Map()},...deps};
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true},
  }).outputText;
  vm.runInNewContext(code, {exports, require: name => {
    if (name in deps) return deps[name];
    if (name.endsWith('/episodeMapping')) return mapping;
    if (name === './ids') return load('src/lib/providers/ids.ts');
    return require(name);
  }, URL, URLSearchParams, AbortSignal, console, ...globals});
  return exports;
}
const mapping = load('src/lib/episodeMapping.ts');
const range = (first, last) => Array.from({length: last - first + 1}, (_, i) => first + i);
const korean = '정반대의 너와 나 2기';
const native = '正反対な君と僕 第2期';
const romaji = 'Seihantai na Kimi to Boku Season 2';
function anissia(captionNumbers = range(13,25), metaCount = 13) {
  return load('src/lib/providers/anissia.ts', {
    '../reanimeMatches': {getConfirmedReanimeIdsForAnissia: async () => new Map(),getEffectiveReanimeIdsForAnissia:async()=>new Map()},
    './reanime': {getReanimeArtwork: async () => null},
    '../resolvers/videoResolver': {},
  }, {fetch: async url => {
    if (String(url).includes('graphql')) return {ok: true, json: async () => ({data: {Media: {
      id: 1, title: {}, episodes: metaCount,
    }}})};
    const data = String(url).includes('/caption/')
      ? captionNumbers.map(episode => ({episode: String(episode), name: 'creator', website: `https://blog.example/${episode}`}))
      : {subject: korean, originalSubject: native, status: 'END'};
    return {ok: true, json: async () => ({data})};
  }}).anissiaProvider;
}
test('configured Anissia 13-25 produces only local 1-13 and attaches source 13/25 posts', async () => {
  const detail = await anissia().getAnimeDetail('ani_42', {subtitleEpisodeStart: 13});
  assert.equal(detail.total_episodes, 13);
  assert.deepEqual(plain(detail.sub_episodes.map(e => e.number)), range(1,13));
  for (const e of detail.sub_episodes) {
    assert.equal(e.title, `${e.number}화 [creator]`);
    assert.equal(new URL(e.watch_url, 'https://app.example').pathname, `/watch/ani_42/${e.number}`);
    assert.equal(e.caption_url, `https://blog.example/${e.number+12}`);
  }
  assert.ok(!detail.sub_episodes.some(e => e.number >= 14));
});
test('episode conversion is general, reversible and excludes captions before the season boundary', () => {
  for (const start of [1,13,26,101]) {
    assert.equal(mapping.toSourceEpisode(1,start), start);
    assert.equal(mapping.toSourceEpisode(13,start), start+12);
    assert.equal(mapping.toLocalEpisode(start+12,start), 13);
    assert.equal(mapping.localEpisodeCount(range(start,start+12),start),13);
  }
  assert.equal(mapping.toSourceEpisode(1,13),13);
  assert.equal(mapping.toSourceEpisode(13,13),25);
  assert.equal(mapping.toLocalEpisode(12,13),null);
  assert.equal(mapping.localEpisodeCount(range(1,25),13),13);
});
test('default numbering, ranged labels, sparse captions and metadata fallback preserve normal works', async () => {
  for (const [numbers, start, expected] of [[range(1,12),null,12], [['13~25'],13,13], [[13,20,25],13,13], [[],13,13]]) {
    const detail = await anissia(numbers).getAnimeDetail('ani_42', {subtitleEpisodeStart:start});
    assert.equal(detail.total_episodes,expected);
  }
});
test('video policy distinguishes cumulative sources, season-local sources and explicit wrong seasons', () => {
  assert.equal(mapping.mapVideoEpisode(1,range(1,25),13,2,null,13),13);
  assert.equal(mapping.mapVideoEpisode(13,range(1,25),13,2,null,13),25);
  assert.equal(mapping.mapVideoEpisode(1,range(1,13),13,2,2,13),1);
  assert.equal(mapping.mapVideoEpisode(13,range(1,13),13,2,2,13),13);
  assert.equal(mapping.mapVideoEpisode(1,range(13,25),13,2,2,13),13);
  assert.equal(mapping.mapVideoEpisode(1,range(1,12),13,2,1,13),null);
  assert.equal(mapping.mapVideoEpisode(1,range(1,13),13,2,null,13),null);
  assert.equal(mapping.mapVideoEpisode(14,range(1,25),13,2,null,13),null);
  assert.equal(mapping.mapVideoEpisode(14,range(1,37),13,2,null,13),null);
  assert.equal(mapping.mapVideoEpisode(1,range(1,13),null,2,2,13),1);
  assert.equal(mapping.mapVideoEpisode(1,range(1,12),null,1,null),1);
});
function resolver({sourceTitle = 'Seihantai na Kimi to Boku', numbers = range(1,25), cached = true,
  items, details, linked = [], provider = 'rean'} = {}) {
  const streams = [], mappingRequests = [];
  const detail = {title: sourceTitle, sub_episodes: numbers.map(number => ({number, watch_url:`https://video.example/${number}`}))};
  const source = {
    getAnimeDetail: async id => details ? details[id] : detail,
    searchAnime: async () => ({items: items || [{id:'merged',title:sourceTitle}]}),
    getEpisodeStream: async url => {streams.push(url); return {success:true,embed_url:url,server_sources:[]};},
  };
  const api = load('src/lib/resolvers/videoResolver.ts', {
    '../providers/reanime': {reanimeProvider:source},
    '../providers/anikoto': {anikotoProvider:source},
    '../providers/linkkf': {linkkfProvider:source},
    '../providers/ohli24': {ohli24Provider:source},
    '../providers/anissia': {fetchAniListMeta: async () => ({romajiTitle:romaji})},
    '../db': {getAnissiaStreamCache: async () => cached ? {reanime_id:'merged'} : null,
      setAnissiaStreamCache: async () => {}},
    '../anikotoLinks': {getAnikotoPlaybackCandidates: async (id,ep) => {mappingRequests.push([id,ep]);return linked;}},
    '../animeWorkIdentity': {getAnimeWorkIdentity: async () => ({titles:[romaji]}),
      normalizeIdentityTitle: value => value.toLowerCase().replace(/\W/g,''),
      matchesIdentityTitle: (value,aliases) => aliases.includes(value)},
  }, {fetch: () => {throw Error('unexpected network');}});
  return {...api, streams, mappingRequests,
    run: ep => api.resolveAnissiaStream(42,ep,korean,native,provider,'ani_42',13,13)};
}
test('ReAnime cached and searched combined source plays source 13/25 for local 1/13', async () => {
  for (const cached of [true,false]) {
    const api = resolver({cached});
    assert.equal((await api.run(1)).success,true);
    assert.equal((await api.run(13)).success,true);
    assert.deepEqual(api.streams,['https://video.example/13','https://video.example/25']);
    assert.ok(!api.streams.includes('https://video.example/1'));
  }
});
test('ReAnime season-specific 1-13 stays local and cumulative 13-25 maps exactly once', async () => {
  for (const [numbers,expected] of [[range(1,13),1],[range(13,25),13]]) {
    const api = resolver({sourceTitle:romaji,numbers});
    await api.run(1);
    assert.deepEqual(api.streams,[`https://video.example/${expected}`]);
  }
});
test('a partially uploaded combined video source can play local 1 without waiting for source 25', async () => {
  const api = resolver({numbers:range(1,14)});
  assert.equal((await api.run(1)).success,true);
  assert.equal((await api.run(3)).max_available_ep,2);
  assert.deepEqual(api.streams,['https://video.example/13']);
});
test('wrong cached first season never plays source 1; latest availability is local and local 14 is unavailable', async () => {
  const wrong = resolver({sourceTitle:'Seihantai na Kimi to Boku Season 1',numbers:range(1,12)});
  assert.equal((await wrong.run(1)).success,false);
  assert.deepEqual(wrong.streams,[]);
  const combined = resolver();
  const result = await combined.run(14);
  assert.equal(result.success,false);
  assert.equal(result.max_available_ep,13);
  assert.deepEqual(combined.streams,[]);
  const threeSeasons = resolver({numbers:range(1,37)});
  assert.equal((await threeSeasons.run(14)).max_available_ep,13);
  assert.deepEqual(threeSeasons.streams,[]);
});
test('search examines a valid combined source after rejecting a first-season candidate', async () => {
  const api = resolver({cached:false,items:[{id:'first',title:'Show Season 1'},{id:'merged',title:'Show'}],details:{
    first:{title:'Show Season 1',sub_episodes:range(1,12).map(number=>({number,watch_url:`wrong/${number}`}))},
    merged:{title:'Show',sub_episodes:range(1,25).map(number=>({number,watch_url:`correct/${number}`}))},
  }});
  await api.run(1);
  assert.deepEqual(api.streams,['correct/13']);
});
test('Anikoto reviewed multi ranges remain authoritative and never receive a second offset', async () => {
  const links = load('src/lib/anikotoLinks.ts', {'./db':{getDb:()=>null}});
  const row = {mapping_kind:'range',anikoto_episode_start:13,anikoto_episode_end:25,target_episode_start:1,target_episode_end:13};
  for (const local of [1,13]) {
    const mapped = links.mapAnikotoEpisode(row,local);
    assert.equal(mapped,local+12);
    const api = resolver({provider:'anikoto', linked:[{animeId:'ak_merged',episodeNumber:mapped,mappingKind:'range'}]});
    assert.equal((await api.run(local)).success,true);
    assert.deepEqual(api.streams,[`https://video.example/${mapped}`]);
    assert.deepEqual(api.mappingRequests,[['ani_42',local]]);
  }
  assert.equal(links.mapAnikotoEpisode(row,14),null);
});
test('Anikoto whole and exact season-local fallback keep source-local episode 1', async () => {
  for (const linked of [[],[{animeId:'ak_season2',episodeNumber:1,mappingKind:'whole'}]]) {
    const api = resolver({provider:'anikoto',sourceTitle:romaji,numbers:range(1,13),linked});
    assert.equal((await api.run(1)).success,true);
    assert.deepEqual(api.streams,['https://video.example/1']);
  }
});
const response = {json:(data,options) => ({data,headers:options?.headers})};
function routes(start) {
  const streamCalls = [];
  const deps = {
    'next/server':{NextResponse:response}, '@/lib/auth':{getSessionUser:async()=>({username:'viewer'})},
    '@/lib/db':{getSubtitleEpisodeStart:async (user,id) => {assert.equal(user,'viewer');assert.equal(id,'ani_42');return start;}},
    '@/lib/providers':{getProviderByAnimeId:()=>anissia()},
    '@/lib/resolvers/videoResolver':{resolveAnissiaStream:async (...args)=>{streamCalls.push(args);return {server_sources:[]};}},
  };
  return {detail:load('src/app/api/anime/detail/route.ts',deps),
    episode:load('src/app/api/anime/episode_info/route.ts',deps),streamCalls};
}
test('authenticated detail and episode APIs use the viewer offset and never publicly cache mapped lists', async () => {
  const api = routes(13);
  const detail = await api.detail.GET({url:'https://app.example/api?id=ani_42'});
  assert.equal(detail.data.total_episodes,13);
  assert.equal(detail.headers['Cache-Control'],'no-store');
  const episode = await api.episode.GET({url:'https://app.example/api?id=ani_42&ep=1'});
  assert.equal(episode.data.episode_number,1);
  assert.equal(episode.data.link_next_ep_num,2);
  assert.equal(episode.headers['Cache-Control'],'no-store');
  assert.deepEqual(api.streamCalls[0].slice(0,2),[42,1]);
  assert.deepEqual(api.streamCalls[0].slice(5),['ani_42',13,13]);
  const last = await api.episode.GET({url:'https://app.example/api?id=ani_42&ep=13'});
  assert.equal(last.data.link_next_ep_num,null);
  const calls = api.streamCalls.length;
  const invalid = await api.episode.GET({url:'https://app.example/api?id=ani_42&ep=14'});
  assert.equal(invalid.data.success,false);
  assert.equal(api.streamCalls.length,calls);
  assert.equal((await routes(null).detail.GET({url:'https://app.example/api?id=ani_42'})).data.total_episodes,25);
});

function elements(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return [tree, ...elements(tree.props?.children)];
}
function pageDeps() {
  const calls = [], subtitles = [];
  const deps = {
    '@/components/WorkMatchSetting':'WorkMatchSetting','@/components/WorkMatchBadge':'WorkMatchBadge',
    'lucide-react': {Play:'Play',Film:'Film',Calendar:'Calendar',CheckCircle2:'CheckCircle2',ArrowLeft:'ArrowLeft'},
    'react/jsx-runtime': {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
    'next/link': 'Link', 'next/navigation': {notFound:()=>{throw Error('not found');}},
    '@/lib/auth': {requireAuth:async()=>({username:'viewer'}),getCurrentUserId:async()=>'viewer'},
    '@/lib/db': {getSubtitleEpisodeStart:async()=>13,getAnimeHistoryMap:async()=>({}),getManualStreamSourceById:async()=>null},
    '@/lib/providers': {getProviderByAnimeId:()=>anissia()},
    '@/lib/preferredAnikotoSeason': {
      anikotoSeasonHref:()=>null,
      filterSeasonEpisodes:episodes=>({episodes,filtered:false}),
      getAnikotoSeasons:async()=>[],
      getPreferredAnikotoSeason:async()=>null,
      validSeasonOrder:n=>typeof n==='number'&&Number.isInteger(n)&&n>0,
    },
    '@/components/PreferredSeasonButton':'PreferredSeasonButton',
    '@/lib/resolvers/videoResolver': {resolveAnissiaStream:async (...args)=>{
      calls.push(args); return {success:true,embed_url:'https://video.example/13',server_sources:[]};
    }},
    '@/lib/subtitles': {resolveKoreanTitle:async title=>title,fetchCreatorSubtitle:async (...args)=>{subtitles.push(args);return null;}},
  };
  for (const name of ['Navbar','Player','ReanimeWatchFallback','AnissiaStreamFallback','ManualSourcePanel',
    'AnissiaVideoSourceSelect','FavoriteButton','EpisodeListSection','SubtitleEpisodeStartSetting',
    'SubtitleBundleAssignmentSetting','ReanimeDetailFallback','LocalizedAnimeTitle']) deps[`@/components/${name}`]=name;
  return {deps,calls,subtitles};
}
test('server detail page and watch navigation render only local 1-13; recent source links normalize once', async () => {
  const api = pageDeps();
  const detail = await load('src/app/anime/[id]/page.tsx',api.deps).default({params:Promise.resolve({id:'ani_42'}),searchParams:Promise.resolve({})});
  const list = elements(detail).find(e=>e.type==='EpisodeListSection');
  assert.deepEqual(plain(list.props.subEpisodes.map(e=>e.number)),range(1,13));
  const watch = load('src/app/watch/[id]/[ep]/page.tsx',api.deps).default;
  for (const [ep,query,expected,next] of [['1',{},1,2],['13',{},13,null],['13',{source_ep:'1'},1,2]]) {
    const tree = await watch({params:Promise.resolve({id:'ani_42',ep}),searchParams:Promise.resolve(query)});
    const player = elements(tree).find(e=>e.type==='Player');
    assert.equal(player.props.episodeNumber,expected);
    assert.equal(player.props.linkNextEp,next);
    assert.equal(player.props.subEpisodes.length,13);
    assert.equal(api.calls.at(-1)[1],expected);
    assert.equal(api.calls.at(-1)[6],13);
    assert.equal(api.subtitles.at(-1)[3],expected+12);
    assert.equal(api.subtitles.at(-1)[5],expected);
  }
  const calls = api.calls.length;
  const invalid = await watch({params:Promise.resolve({id:'ani_42',ep:'14'}),searchParams:Promise.resolve({})});
  assert.ok(!elements(invalid).some(e=>e.type==='Player'));
  assert.equal(api.calls.length,calls);
});
test('explicit subtitle selection passes source 13/25 and retains local 1/13 extraction context', async () => {
  const calls = [];
  const api = load('src/app/api/anime/subtitles/route.ts', {
    'next/server':{NextResponse:response}, '@/lib/auth':{getSessionUser:async()=>({username:'viewer'})},
    '@/lib/db':{getSubtitleEpisodeStart:async()=>13,getSubtitleRejections:async()=>[],saveSubtitleCreatorPreference:async()=>true},
    '@/lib/subtitles':{resolveKoreanTitle:async title=>title,parseSeason:()=>2,
      fetchCreatorSubtitle:async (...args)=>{calls.push(args);return {content:'WEBVTT',format:'VTT'};}},
    '@/lib/proxyGuard':{assertSafeProxyUrl:async()=>{}},
    '@/lib/subtitleStorage':{}, '@/lib/reviewedSubtitleStorage':{}, '@/lib/reanimeMatches':{},
    '@/lib/subtitleLocalIdentity':{}, '@/lib/subtitleOverrides':{}, '@/lib/subtitleCache':{},
    '@/lib/adminSubtitleLinker':{getAdminLinkedSubtitles:async()=>[]},
  });
  for (const ep of [1,13]) {
    const result = await api.POST({json:async()=>({animeId:'ani_42',title:korean,episodeNumber:ep,
      creatorName:'creator',website:'https://blog.example/post',sourceProvider:'anissia'})});
    assert.equal(result.data.success,true);
    assert.equal(calls.at(-1)[3],ep+12);
    assert.equal(calls.at(-1)[5],ep);
  }
});

test('completed local episode 13 never promotes fictitious local 14 from cumulative captions', async () => {
  let writes = 0;
  const api = load('src/lib/historyPromotion.ts', {
    './db': {getDb:()=>async sql => {
      if (String(sql).includes('SELECT *')) return [{anime_id:'ani_42',episode_number:13}];
      writes++; return [];
    }, getSubtitleEpisodeStart:async (user,id)=>{
      assert.equal(user,'viewer'); assert.equal(id,'ani_42'); return 13;
    }},
    './providers': {getProviderByAnimeId:()=>anissia()},
  }, {setTimeout,clearTimeout});
  assert.equal(await api.checkAndPromoteNewEpisodes('viewer'),false);
  assert.equal(writes,0);
});
test('segment discovery resolves the same local episode and refuses local 14', async () => {
  const calls = [];
  const api = load('src/app/api/anime/stream/segments_info/route.ts', {
    'next/server':{NextResponse:response}, '@/lib/auth':{getSessionUser:async()=>({username:'viewer'})},
    '@/lib/linkkf':{}, '@/lib/proxyGuard':{assertSafeProxyUrl:async()=>{}},
    '@/lib/db':{getSubtitleEpisodeStart:async()=>13},
    '@/lib/providers':{getProviderByAnimeId:()=>anissia()},
    '@/lib/resolvers/videoResolver':{resolveAnissiaStream:async (...args)=>{
      calls.push(args);return {m3u8_url:'https://video.example/master.m3u8'};
    }},
  }, {fetch:async()=>({ok:true,text:async()=> '#EXTM3U\n#EXTINF:10,\nsegment.ts\n'})});
  const result = await api.GET({url:'https://app.example/api?anime_id=ani_42&ep=1'});
  assert.equal(result.data.success,true);
  assert.deepEqual(calls[0].slice(0,2),[42,1]);
  assert.deepEqual(calls[0].slice(5),['ani_42',13,13]);
  assert.equal((await api.GET({url:'https://app.example/api?anime_id=ani_42&ep=14'})).data.success,false);
  assert.equal(calls.length,1);
});
