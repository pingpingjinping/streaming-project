const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.join(__dirname, '..');
const id = 're_you-re-under-arrest-tv-m29pp3';
const ak = 'ak_you-re-under-arrest-1996-4cefz';
const range = n => Array.from({length:n}, (_,i)=>i+1);
const plain = x => JSON.parse(JSON.stringify(x));
function load(file, deps={}, globals={}) {
  deps={'@/lib/adminWorkTitles':{applyAdminWorkTitles:async items=>items,applyAdminWorkTitle:async item=>item},...deps};
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true},
  }).outputText;
  vm.runInNewContext(code,{exports,require:name=>{
    if(name in deps) return deps[name];
    if(name.endsWith('/episodeMapping')||name==='@/lib/episodeMapping') return load('src/lib/episodeMapping.ts');
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==='next/link')return 'Link';
    if(name==='lucide-react')return new Proxy({},{get:(_,k)=>k});
    if(name.startsWith('@/components/'))return name.split('/').at(-1);
    return require(name);
  },console,URL,URLSearchParams,AbortSignal,Date,...globals});
  return exports;
}
const raw = {id,title:"You're Under Arrest! (TV)",anilist_id:1372,video_available:false,genres:[],
  sub_episodes:range(30).map(number=>({number,title:`${number}화`,watch_url:`https://rean.example/${number}`})),
  dub_episodes:[],total_episodes:47};
const full = {id:ak,title:"You're Under Arrest (1996)",sub_episodes:range(51).map(number=>({number,title:`${number}화`,watch_url:`https://anikoto.example/${number}`}))};
function fixture(rows=[{anikoto_id:ak.slice(3),target_order:2,link_status:'multi_reviewed',mapping_kind:'range',
  anikoto_episode_start:5,anikoto_episode_end:51,target_episode_start:1,target_episode_end:47}], detail=full) {
  const links=load('src/lib/anikotoLinks.ts',{'./db':{getDb:()=>async sql=>{
    assert.ok(String(sql).includes('SELECT'));return rows;
  }},'./anikotoWorkOverrides':{getAnikotoWorkOverride:async()=>null}});
  const helper=load('src/lib/reviewedProviderPlayback.ts',{'./anikotoLinks':links,
    './providers/anikoto':{anikotoProvider:{getAnimeDetail:async target=>{assert.equal(target,ak);return detail;}}}});
  return {links,helper};
}
test('combined TV page has 51 episodes and source 1/4/5/51 remain 1/4/5/51',async()=>{
  const {links,helper}=fixture();const result=await helper.reviewedProviderPlayback(raw);
  assert.equal(result.id,id);assert.equal(result.anilist_id,1372);assert.equal(result.playback_source,'anikoto');
  assert.deepEqual(plain(result.sub_episodes.map(e=>e.number)),range(51));
  assert.equal(result.total_episodes,51);assert.equal(raw.sub_episodes.length,30);
  for(const number of [1,4,5,51]) {
    const c=await links.getAnikotoPlaybackCandidates(id,number);
    assert.equal(c[0]?.episodeNumber ?? null, number<=47 ? number+4 : null);
    assert.equal(result.sub_episodes[number-1].watch_url,`/watch/${id}/${number}?video_source=anikoto`);
  }
  assert.equal((await links.getAnikotoPlaybackCandidates(id,52)).length,0);
});
test('explicit ReAnime choice and unrelated works retain their existing playlist',async()=>{
  const {helper}=fixture();assert.equal(await helper.reviewedProviderPlayback(raw,'rean'),raw);
  const other={...raw,id:'re_other',video_available:true};
  assert.equal(await helper.reviewedProviderPlayback(other),other);
});
test('watch source switches fetch one Anikoto playlist and retain native episodes and caption ranges',async()=>{
  for (const workId of [id,'ani_42']) {
    let details=0;const streams=[],captions=[],options=[];
    const {links}=fixture();
    const provider={getAnimeDetail:async()=>{details++;return full;},getEpisodeStream:async url=>{
      streams.push(url);return {success:true,embed_url:'https://video.example',stream_type:'iframe',server_sources:[{id:'anikoto',player_url:'https://video.example',label:'Anikoto'}]};}};
    const helper=load('src/lib/reviewedProviderPlayback.ts',{'./anikotoLinks':links,'./providers/anikoto':{anikotoProvider:provider}});
    const resolver=load('src/lib/resolvers/videoResolver.ts',{
      '../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:async()=>new Set(),hasWorkMatchCandidates:async()=>false},
      '../workMatchOverrides':{getWorkMatchOverrides:async()=>[]},'../reanimeMatches':{getEffectiveReanimeIdsForAnissia:async()=>new Map()},
      '../anikotoWorkOverrides':{getAnikotoWorkOverride:async()=>null},'../db':{getAnissiaStreamCache:async()=>null},
      '../providers/reanime':{},'../providers/linkkf':{},'../providers/ohli24':{},'../providers/anissia':{},
      '../animeWorkIdentity':{},'../anikotoLinks':links,'../providers/anikoto':{anikotoProvider:provider},
    });
    const anime={...raw,id:workId,sub_episodes:range(47).map(number=>({number,title:`${number}화`,watch_url:'/unused',caption_url:`https://caption.example/${number}`,creator_name:'creator'}))};
    const page=load('src/app/watch/[id]/[ep]/page.tsx',{
      '@/lib/auth':{requireAuth:async()=>({username:'viewer'})},'@/lib/db':{getSubtitleEpisodeStart:async()=>null},
      '@/lib/providers':{getProviderByAnimeId:()=>({getAnimeDetail:async(_,o)=>{options.push(o);return anime;},getEpisodeStream:async()=>{throw Error('Wrong provider');}})},
      '@/lib/reviewedProviderPlayback':helper,'@/lib/resolvers/videoResolver':resolver,
      '@/lib/playbackSubtitlePreload':{preloadPlaybackSubtitle:async(...args)=>{captions.push(args);return null;}},
      'next/navigation':{notFound:()=>{throw Error('Unexpected 404');}},
    }).default;
    const tree=await page({params:Promise.resolve({id:workId,ep:'51'}),searchParams:Promise.resolve({video_source:'anikoto'})});
    function nodes(v){return !v||typeof v!=='object'?[]:[v,...Object.values(v).flatMap(nodes)];}
    const player=nodes(tree).find(n=>n.type==='Player');
    assert.equal(details,1);assert.deepEqual(streams,['https://anikoto.example/51']);
    assert.equal(options[0].videoSource,'anikoto');assert.equal(player.props.subEpisodes.length,51);
    assert.equal(player.props.videoSource,'anikoto');assert.equal(player.props.initialSubUrl,'https://caption.example/47');
    assert.equal(captions[0][3],47);
  }
});
test('custom reviewed ranges are preserved and missing source episodes are never invented',async()=>{
  const row={anikoto_id:ak.slice(3),link_status:'reviewed',mapping_kind:'range',anikoto_episode_start:8,
    anikoto_episode_end:12,target_episode_start:1,target_episode_end:5};
  const {links,helper}=fixture([row]);assert.equal((await links.getAnikotoPlaybackCandidates(id,1))[0].episodeNumber,8);
  assert.equal((await helper.reviewedProviderPlayback(raw)).total_episodes,51);
  const sparse=fixture(undefined,{...full,sub_episodes:full.sub_episodes.filter(e=>e.number!==35)});
  const result=await sparse.helper.reviewedProviderPlayback(raw);
  assert.equal(result.total_episodes,50);assert.ok(!result.sub_episodes.some(e=>e.number===35));
  const missing=fixture(undefined,null);assert.equal(await missing.helper.reviewedProviderPlayback(raw),raw);
});
test('episode API keeps Anikoto, reaches episode 51 and does not report empty streams as success',async()=>{
  const {helper}=fixture();const calls=[];let available=true;
  const api=load('src/app/api/anime/episode_info/route.ts',{
    'next/server':{NextResponse:{json:(data,init)=>({data,status:init?.status||200})}},
    '@/lib/auth':{getSessionUser:async()=>({username:'viewer'})},
    '@/lib/db':{getSubtitleEpisodeStart:async()=>5},
    '@/lib/providers':{getProviderByAnimeId:()=>({name:'reanime',getAnimeDetail:async()=>raw,
      getEpisodeStream:async()=>{throw Error('Unavailable ReAnime must not be fetched');}})},
    '@/lib/reviewedProviderPlayback':helper,
    '@/lib/resolvers/videoResolver':{resolveAnissiaStream:async(...args)=>{calls.push(args);return available?
      {success:true,embed_url:'https://video.example',video_source:'anikoto',video_episodes:full.sub_episodes}:null;}},
  });
  const res=await api.GET({url:`https://app.example/api?id=${id}&ep=51`});
  assert.equal(res.data.success,true);assert.equal(res.data.video_source,'anikoto');
  assert.equal(res.data.link_pre_ep_num,50);assert.equal(res.data.link_next_ep_num,null);
  assert.equal(calls[0][0],null);assert.equal(calls[0][4],'anikoto');assert.equal(calls[0][6],5);
  available=false;
  const fail=await api.GET({url:`https://app.example/api?id=${id}&ep=1`});
  assert.equal(fail.status,502);assert.equal(fail.data.success,false);
});
test('detail page displays 51 episodes and retains source selection on the start button',async()=>{
  const {helper}=fixture();
  const page=load('src/app/anime/[id]/page.tsx',{
    '@/lib/auth':{requireAuth:async()=>({username:'viewer'}),getCurrentUserId:async()=>1},
    '@/lib/db':{getSubtitleEpisodeStart:async()=>5,getAnimeHistoryMap:async()=>({})},
    '@/lib/providers':{getProviderByAnimeId:()=>({getAnimeDetail:async()=>raw})},
    '@/lib/reviewedProviderPlayback':helper,'next/navigation':{notFound:()=>{throw Error('Unexpected 404');}},
  }).default;
  const tree=await page({params:Promise.resolve({id}),searchParams:Promise.resolve({})});
  function nodes(value) {return !value||typeof value!=='object'?[]:[value,...Object.values(value).flatMap(nodes)];}
  const episodeSection=nodes(tree).find(n=>n.type==='EpisodeListSection');
  assert.equal(episodeSection.props.subEpisodes.length,51);assert.equal(episodeSection.props.videoSource,'anikoto');
  assert.ok(nodes(tree).some(n=>n.type==='Link'&&n.props.href===`/watch/${id}/1?video_source=anikoto`));
});

test('12 TV plus 3 OVA remain 15 on either card; subtitle ranges do not remove videos',async()=>{
  const source={...full,sub_episodes:full.sub_episodes.slice(0,15)};
  for(const [start,end] of [[1,12],[13,15]]) {
    const {helper}=fixture([{anikoto_id:ak.slice(3),link_status:'multi_reviewed',mapping_kind:'range',
      anikoto_episode_start:start,anikoto_episode_end:end,target_episode_start:1,target_episode_end:end-start+1}],source);
    const detail={...raw,sub_episodes:[{number:1,watch_url:'/1',caption_url:'https://caption.example/1',creator_name:'creator'}]};
    const result=await helper.reviewedProviderPlayback(detail);
    assert.deepEqual(plain(result.sub_episodes.map(e=>e.number)),range(15));
    assert.equal(result.sub_episodes[start-1].subtitle_episode,1);
    assert.equal(result.sub_episodes[start-1].caption_url,'https://caption.example/1');
    assert.equal(result.sub_episodes[start===1?14:0].subtitle_episode,null);
    assert.equal(result.sub_episodes[start===1?14:0].caption_url,undefined);
  }
});
test('native Anikoto navigation selects video 1/51, not the old TV-only offset 5/55',async()=>{
  const {links}=fixture();const calls=[];
  const api=load('src/lib/resolvers/videoResolver.ts',{
    '../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:async()=>new Set(),hasWorkMatchCandidates:async()=>false},
    '../workMatchOverrides':{getWorkMatchOverrides:async()=>[]},
    '../reanimeMatches':{getEffectiveReanimeIdsForAnissia:async()=>new Map()},
    '../anikotoWorkOverrides':{getAnikotoWorkOverride:async()=>null},'../db':{},
    '../providers/reanime':{},'../providers/linkkf':{},'../providers/ohli24':{},
    '../providers/anissia':{},'../animeWorkIdentity':{},'../anikotoLinks':links,
    '../providers/anikoto':{anikotoProvider:{getAnimeDetail:async()=>full,
      getEpisodeStream:async url=>{calls.push(url);return {success:true,embed_url:'https://video.example'};}}},
  });
  for(const episode of [1,51]) {
    const result=await api.resolveAnissiaStream(null,episode,raw.title,'','anikoto',id,5,47,true);
    assert.equal(result.video_source,'anikoto');assert.equal(result.video_episodes.length,51);
    assert.equal(calls.at(-1),`https://anikoto.example/${episode}`);
    assert.equal(result.video_episodes[0].subtitle_episode,null);
    assert.equal(result.video_episodes[4].subtitle_episode,1);
    assert.equal(result.video_episodes[50].subtitle_episode,47);
  }
});
test('next-episode API automatically falls back after a supposedly available ReAnime stream fails',async()=>{
  const availableDetail={...raw,video_available:true};let alternate=0;
  const api=load('src/app/api/anime/episode_info/route.ts',{
    'next/server':{NextResponse:{json:(data,init)=>({data,status:init?.status||200})}},
    '@/lib/auth':{getSessionUser:async()=>({username:'viewer'})},'@/lib/db':{getSubtitleEpisodeStart:async()=>null},
    '@/lib/providers':{getProviderByAnimeId:()=>({name:'reanime',getAnimeDetail:async()=>availableDetail,getEpisodeStream:async()=>null})},
    '@/lib/resolvers/videoResolver':{resolveAnissiaStream:async(...args)=>{
      alternate++;assert.equal(args[4],'anikoto');assert.equal(args[8],true);
      return {success:true,embed_url:'https://video.example',video_source:'anikoto',video_episodes:full.sub_episodes};}},
  });
  const result=await api.GET({url:`https://app.example/api?id=${id}&ep=30`});
  assert.equal(result.data.success,true);assert.equal(result.data.link_next_ep_num,31);
  assert.equal(result.data.video_source,'anikoto');assert.equal(alternate,1);
});

test('metadata-only ReAnime without an available alternate exposes no fictitious play buttons',async()=>{
  const {helper}=fixture(undefined,null);
  const page=load('src/app/anime/[id]/page.tsx',{
    '@/lib/auth':{requireAuth:async()=>({username:'viewer'}),getCurrentUserId:async()=>1},
    '@/lib/db':{getSubtitleEpisodeStart:async()=>5,getAnimeHistoryMap:async()=>({})},
    '@/lib/providers':{getProviderByAnimeId:()=>({getAnimeDetail:async()=>raw})},
    '@/lib/reviewedProviderPlayback':helper,'next/navigation':{notFound:()=>{throw Error('Unexpected 404');}},
  }).default;
  const tree=await page({params:Promise.resolve({id}),searchParams:Promise.resolve({})});
  function nodes(v){return !v||typeof v!=='object'?[]:[v,...Object.values(v).flatMap(nodes)];}
  const list=nodes(tree).find(n=>n.type==='EpisodeListSection');
  assert.equal(list.props.subEpisodes.length,0);
  assert.ok(!nodes(tree).some(n=>n.type==='Link'&&n.props.href.startsWith('/watch/')));
  assert.ok(nodes(tree).some(n=>n.type==='WorkMatchSetting'&&n.props.animeId===id));
});

