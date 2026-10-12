const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript');
const root=path.join(__dirname,'..');
function load(file,deps={},globals={}) {
 const exports={};const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
 }).outputText;
 vm.runInNewContext(code,{exports,require:n=>deps[n]??require(n),URL,URLSearchParams,AbortSignal,console,setTimeout,clearTimeout,...globals});return exports;
}
const base='https://anikoto.example';
function provider() {
 let now=0,baseUrl=base,token='old',canonical='show',failDetail=false,hangDetail=false,empty=false,rejectToken=false,embedVersion=0;
 const calls=[];
 const api=load('src/lib/providers/anikoto.ts',{
  '@/lib/db':{DEFAULT_ANIKOTO_URL:base,getAnikotoBaseUrl:async()=>baseUrl},
  './ids':{toAnikotoId:id=>`ak_${id}`,stripAnikotoId:id=>id.replace(/^ak_/,'')},
  '@/lib/anikotoCatalog':{},'@/lib/chromiumFetch':{},
 },{Date:class extends Date {static now(){return now;}},console:{error(){}},fetch:async url=>{
  const u=new URL(url);calls.push({host:u.host,path:u.pathname,servers:u.searchParams.get('servers')});
  if(u.pathname.startsWith('/ajax/episode/list/')) return new Response(JSON.stringify({status:200,result:empty?'':[1,13,15].map(n=>`<a data-num="${n}" data-slug="${n}" data-ids="${token}" data-sub="1"></a>`).join('')}));
  if(u.pathname==='/ajax/server/list') {
   if(rejectToken&&u.searchParams.get('servers')==='old') return new Response(JSON.stringify({status:rejectToken==='empty'?200:403,result:''}));
   return new Response(JSON.stringify({status:200,result:'<div class="type" data-type="sub"><li data-link-id="server">Mega</li></div>'}));
  }
  if(u.pathname==='/ajax/server') return new Response(JSON.stringify({status:200,result:{url:`https://video.example/embed/${++embedVersion}`}}));
  if(!u.pathname.includes('/ep-')) {
   if(hangDetail) return new Promise(()=>{});
   if(failDetail) return new Response('Unavailable',{status:503});
   return new Response(`<h1 data-jp="作品 第2期">Work Season 2</h1><div id="watch-main" data-id="123" data-url="${baseUrl}/watch/${canonical}"></div>`);
  }
  return new Response('<html>Episode</html>');
 }});
 return{api,calls,set:values=>{if('now'in values)now=values.now;if('baseUrl'in values)baseUrl=values.baseUrl;if('token'in values)token=values.token;if('canonical'in values)canonical=values.canonical;if('failDetail'in values)failDetail=values.failDetail;if('hangDetail'in values)hangDetail=values.hangDetail;if('empty'in values)empty=values.empty;if('rejectToken'in values)rejectToken=values.rejectToken;}};
}
test('repeat/concurrent Anikoto switches share a short playlist lookup but resolve fresh video URLs',async()=>{
 const p=provider();const [a,b]=await Promise.all([p.api.getAnimeDetail('ak_show'),p.api.getAnimeDetail('ak_show')]);
 assert.equal(p.calls.length,2);assert.notEqual(a,b);assert.notEqual(a.sub_episodes,b.sub_episodes);
 a.sub_episodes[0].title='Modified by viewer';assert.equal((await p.api.getAnimeDetail('ak_show')).sub_episodes[0].title,'1화');
 assert.deepEqual(Array.from(b.sub_episodes,e=>e.number),[1,13,15]);
 const first=await p.api.getEpisodeStream(b.sub_episodes[0].watch_url),second=await p.api.getEpisodeStream(b.sub_episodes[0].watch_url);
 assert.notEqual(first.embed_url,second.embed_url);assert.equal(p.calls.length,8);
 p.set({now:30001});await p.api.getAnimeDetail('ak_show');await new Promise(setImmediate);assert.equal(p.calls.length,10);
 p.set({baseUrl:'https://changed.example'});await p.api.getAnimeDetail('ak_show');assert.equal(p.calls.length,12);assert.equal(p.calls.at(-1).host,'changed.example');
});
test('failed and empty playlist lookups are not retained across switches',async()=>{
 const p=provider();p.set({failDetail:true});assert.equal(await p.api.getAnimeDetail('ak_show'),null);
 p.set({failDetail:false,empty:true});assert.equal((await p.api.getAnimeDetail('ak_show')).total_episodes,0);
 p.set({empty:false});assert.equal((await p.api.getAnimeDetail('ak_show')).total_episodes,3);assert.equal(p.calls.length,6);
});
test('a temporary outage keeps the last successful playlist but a forced token refresh never reuses stale tokens',async()=>{
 const p=provider(),original=await p.api.getAnimeDetail('ak_show');
 p.set({now:30001,failDetail:true});
 assert.deepEqual(Array.from((await p.api.getAnimeDetail('ak_show')).sub_episodes,e=>e.number),[1,13,15]);
 p.set({rejectToken:true});assert.equal(await p.api.getEpisodeStream(original.sub_episodes[0].watch_url),null);
 p.set({now:630001});assert.equal(await p.api.getAnimeDetail('ak_show'),null);
});
test('cached navigation returns immediately while one hanging refresh runs in the background',{timeout:2000},async()=>{
 const p=provider();await p.api.getAnimeDetail('ak_show');p.set({now:30001,hangDetail:true});
 const [a,b]=await Promise.all([p.api.getAnimeDetail('ak_show'),p.api.getAnimeDetail('ak_show')]);
 assert.equal(a.total_episodes,3);assert.equal(b.total_episodes,3);
 assert.equal(p.calls.filter(c=>c.path==='/watch/show').length,2,'one initial request and one shared refresh');
});
test('an empty episode response is retried once without repeating show metadata',async()=>{
 let lists=0,shows=0;
 const p=load('src/lib/providers/anikoto.ts',{
  '@/lib/db':{DEFAULT_ANIKOTO_URL:base,getAnikotoBaseUrl:async()=>base},
  './ids':{toAnikotoId:id=>`ak_${id}`,stripAnikotoId:id=>id.replace(/^ak_/,'')},
  '@/lib/anikotoCatalog':{},'@/lib/chromiumFetch':{},
 },{fetch:async url=>{
  if(String(url).includes('/ajax/episode/list/')) return new Response(JSON.stringify({status:200,result:++lists===1?'':'<a data-num="51" data-ids="fresh" data-sub="1"></a>'}));
  shows++;return new Response(`<div id="watch-main" data-id="123" data-url="${base}/watch/show"></div>`);
 }});
 const detail=await p.getAnimeDetail('ak_show');assert.equal(detail.total_episodes,1);
 assert.equal(detail.sub_episodes[0].number,51);assert.equal(shows,1);assert.equal(lists,2);
});

test('slow title lookup and subtitle extraction have one short total preload budget',{timeout:3000},async()=>{
 for(const slow of ['title','subtitle']) {
  const api=load('src/lib/playbackSubtitlePreload.ts',{'./subtitles':{
   resolveKoreanTitle:async()=>slow==='title'?new Promise(()=>{}):'Work',
   fetchCreatorSubtitle:async()=>new Promise(()=>{}),
  }});
  assert.equal(await api.preloadPlaybackSubtitle('creator','https://blog.example','Work',47,51,'re_work'),null);
 }
 const api=load('src/lib/playbackSubtitlePreload.ts',{'./subtitles':{
  resolveKoreanTitle:async()=> 'Work',fetchCreatorSubtitle:async(...args)=>({content:'Subtitle',episode:args[3]}),
 }});
 assert.equal((await api.preloadPlaybackSubtitle('creator','https://blog.example','Work',47,51,'re_work')).episode,47);
});
test('ReAnime alternate players use exact local metadata with no requests to ReAnime and never invent video episodes',async()=>{
 let sqlCalls=0,remote=0;
 const payload={title_english:"You're Under Arrest! (TV)",title_romaji:'Taiho Shichauzo (TV)',title_native:'逮捕しちゃうぞ (TV)',
  year:1996,format:'TV',status:'Finished',genres:'Action,Comedy',source_metadata_json:JSON.stringify({anilist_id:1372,can_watch:false,episodes_total:47,cover_image:{large:'https://image.example/1372.png'}})};
 const local=load('src/lib/localReanimeDetail.ts',{
  './db':{getDb:()=>async(strings,id)=>{sqlCalls++;assert.match(strings.join(''),/source='ReAnime'/);assert.equal(id,'under-arrest');return[{payload:JSON.stringify(payload)}];}},
  './reanimeMatches':{getBundledReanimeMatch:()=>null},
 });
 const api=load('src/lib/providers/reanime.ts',{
  '../localReanimeDetail':local,'../episodeMapping':{reviewedReanimeProjection:()=>null},'@/lib/reanimeMatches':{getBundledReanimeMatch:()=>null},
  '../anikotoLinks':{getAnikotoPlaybackCandidates:async()=>[link('ak_arrest')]},
  '@/lib/db':{getReanimeBaseUrl:async()=>base},'./ids':{toReanimeId:id=>id,stripReanimeId:id=>id.slice(3)},
 },{fetch:async url=>{remote++;return new Response(JSON.stringify(String(url).endsWith('/episodes')?{data:[]}:{title:{english:'Remote Work'},anime_id:'under-arrest'}));}});
 for(const videoSource of ['anikoto','linkkf','ohli24']) {
  const detail=await api.getAnimeDetail('re_under-arrest',{videoSource});
  assert.equal(detail.anilist_id,1372);assert.equal(detail.sub_episodes.length,0);assert.equal(detail.total_episodes,47);assert.equal(detail.poster,'https://image.example/1372.png');
 }
 assert.equal(remote,0);assert.equal(sqlCalls,3);
 assert.equal((await api.getAnimeDetail('re_under-arrest')).anilist_id,1372);assert.equal(remote,0,'metadata-only default goes directly to its reviewed alternate');
 assert.equal((await api.getAnimeDetail('re_under-arrest',{videoSource:'rean'})).title,'Remote Work');assert.equal(remote,2);
});
test('expired episode tokens refresh the exact playlist once, including redirected slugs',async()=>{
 for(const [canonical,rejectToken] of [['show',true],['canonical-show',true],['show','empty'],['canonical-show','empty']]) {
  const p=provider();p.set({canonical});const detail=await p.api.getAnimeDetail('ak_show');
  p.set({token:'fresh',rejectToken});
  const stream=await p.api.getEpisodeStream(detail.sub_episodes[1].watch_url);
  assert.equal(stream.success,true);assert.equal(p.calls.filter(c=>c.path==='/ajax/episode/list/123').length,2);
  assert.deepEqual(p.calls.filter(c=>c.path==='/ajax/server/list').map(c=>c.servers),['old','fresh']);
  assert.ok(p.calls.filter(c=>c.path.includes('/ep-')).every(c=>c.path.endsWith('/ep-13')));
 }
});
test('unchanged invalid tokens stop after one metadata refresh',async()=>{
 const p=provider(),detail=await p.api.getAnimeDetail('ak_show');p.set({rejectToken:true});
 assert.equal(await p.api.getEpisodeStream(detail.sub_episodes[0].watch_url),null);
 assert.equal(p.calls.filter(c=>c.path==='/ajax/episode/list/123').length,2);
 assert.equal(p.calls.filter(c=>c.path==='/ajax/server/list').length,1);
});
test('concurrent stale episode requests share refresh and still resolve separate video URLs',async()=>{
 const p=provider(),detail=await p.api.getAnimeDetail('ak_show');p.set({token:'fresh',rejectToken:true});
 const [first,second]=await Promise.all([p.api.getEpisodeStream(detail.sub_episodes[0].watch_url),p.api.getEpisodeStream(detail.sub_episodes[0].watch_url)]);
 assert.equal(first.success,true);assert.equal(second.success,true);assert.notEqual(first.embed_url,second.embed_url);
 assert.equal(p.calls.filter(c=>c.path==='/ajax/episode/list/123').length,2);
});

const identity=load('src/lib/animeWorkIdentity.ts',{'@/lib/db':{getDb:()=>null}});
function resolver(rows,provider,aliases=['Work Season 2']) {
 return load('src/lib/resolvers/videoResolver.ts',{
  '../db':{getAnissiaStreamCache:async()=>null},
  '../workMatchOverrides':{getWorkMatchOverrides:async()=>[]},
  '../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:async()=>new Set(),hasWorkMatchCandidates:async()=>false},
  '../reanimeMatches':{getEffectiveReanimeIdsForAnissia:async()=>new Map()},
  '../anikotoWorkOverrides':{getAnikotoWorkOverride:async()=>null},
  '../anikotoLinks':{getAnikotoPlaybackCandidates:async()=>rows},
  '../animeWorkIdentity':{...identity,getAnimeWorkIdentity:async()=>({titles:aliases}),getCatalogWorkIdentityByTitle:async()=>null},
  '../episodeMapping':load('src/lib/episodeMapping.ts'),
  '../providers/reanime':{},'../providers/linkkf':{},'../providers/ohli24':{},'../providers/anissia':{},
  '../providers/anikoto':{anikotoProvider:provider},
 }).resolveAnissiaStream;
}
const detail=id=>({id,title:'Work Season 2',sub_episodes:Array.from({length:15},(_,i)=>({number:i+1,title:`${i+1}화`,watch_url:`https://video.example/${id}/${i+1}`}))});
const link=(animeId,linkStatus='reviewed')=>({animeId,linkStatus,episodeNumber:1,mappingKind:'whole'});
test('native source switch returns the first reviewed player without fetching a hanging later candidate',{timeout:3000},async()=>{
 const first=detail('ak_first'),calls=[];
 const run=resolver([link('ak_first'),link('ak_hanging')],{
  getAnimeDetail:async id=>{calls.push(id);return new Promise(()=>{});},
  getEpisodeStream:async url=>({success:true,embed_url:url}),
 });
 const result=await run(42,15,'Work Season 2','作品 第2期','anikoto','ani_42',null,undefined,true,new Map([['ak_first',first]]));
 assert.deepEqual(calls,[]);assert.equal(result.embed_url,'https://video.example/ak_first/15');assert.equal(result.video_episodes.length,15);
});
test('native source switch advances after a failed earlier stream without racing the priority order',async()=>{
 const calls=[],played=[];
 const run=resolver([link('ak_first'),link('ak_second')],{
  getAnimeDetail:async id=>{calls.push(id);return detail(id);},
  getEpisodeStream:async url=>{played.push(url);return url.includes('ak_first')?null:{success:true,embed_url:url};},
 });
 const result=await run(42,1,'Work Season 2','作品 第2期','anikoto','ani_42',null,undefined,true);
 assert.deepEqual(calls,['ak_first','ak_second']);assert.deepEqual(played,['https://video.example/ak_first/1','https://video.example/ak_second/1']);assert.equal(result.video_episodes.length,15);
});
test('a fast automatic first-season link cannot bypass validation or replace a reviewed second season',async()=>{
 const played=[];
 const run=resolver([link('ak_wrong','automatic'),link('ak_correct')],{
  getAnimeDetail:async id=>({...detail(id),title:id==='ak_wrong'?'Work Season 1':'Work Season 2'}),
  getEpisodeStream:async url=>{played.push(url);return{success:true,embed_url:url};},
 });
 const result=await run(42,1,'Work Season 2','作品 第2期','anikoto','ani_42',null,undefined,true);
 assert.deepEqual(played,['https://video.example/ak_correct/1']);assert.equal(result.video_episodes.length,15);
});
test('explicit Anikoto playback never waits for unrelated ReAnime matching queries',{timeout:2000},async()=>{
 const unrelated=()=>{throw Error('Unrelated ReAnime query');};
 const run=load('src/lib/resolvers/videoResolver.ts',{
  '../db':{getAnissiaStreamCache:unrelated},
  '../workMatchOverrides':{getWorkMatchOverrides:unrelated},
  '../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:unrelated,hasWorkMatchCandidates:unrelated},
  '../reanimeMatches':{getEffectiveReanimeIdsForAnissia:unrelated},
  '../anikotoWorkOverrides':{getAnikotoWorkOverride:async()=>null},
  '../anikotoLinks':{getAnikotoPlaybackCandidates:async()=>[link('ak_first')]},
  '../animeWorkIdentity':identity,'../episodeMapping':load('src/lib/episodeMapping.ts'),
  '../providers/reanime':{},'../providers/linkkf':{},'../providers/ohli24':{},'../providers/anissia':{},
  '../providers/anikoto':{anikotoProvider:{getAnimeDetail:async()=>detail('ak_first'),getEpisodeStream:async url=>({success:true,embed_url:url})}},
 }).resolveAnissiaStream;
 const stream=await run(42,15,'Work Season 2','作品 第2期','anikoto','ani_42',null,undefined,true);
 assert.equal(stream.video_source,'anikoto');assert.equal(stream.video_episodes.length,15);
});

test('Anikoto uses the working HD-1 server before Vidstream 2 and resolves only the chosen server',async()=>{
 for(const label of ['HD-1','HD1','HD 1','HD‑1']) {
  const resolved=[];
  const api=load('src/lib/providers/anikoto.ts',{
   '@/lib/db':{DEFAULT_ANIKOTO_URL:base,getAnikotoBaseUrl:async()=>base},
   './ids':{toAnikotoId:id=>`ak_${id}`,stripAnikotoId:id=>id.replace(/^ak_/,'')},
   '@/lib/anikotoCatalog':{},'@/lib/chromiumFetch':{},
  },{fetch:async url=>{
   const u=new URL(url);
   if(u.pathname==='/ajax/server/list') return new Response(JSON.stringify({status:200,result:
    `<div class="type" data-type="dub"><li data-link-id="dub">HD-1</li></div>
     <div class="type" data-type="softsub"><li data-link-id="soft">HD-1</li></div>
     <div class="type" data-type="sub"><li data-link-id="slow">Vidstream 2</li><li data-link-id="ten">HD-10</li><li data-link-id="hd1">${label}</li></div>`}));
   if(u.pathname==='/ajax/server') {
    resolved.push(u.searchParams.get('get'));return new Response(JSON.stringify({status:200,result:{url:'https://video.example/hd1'}}));
   }
   return new Response('<html>Episode</html>');
  }});
  const stream=await api.getEpisodeStream(`${base}/watch/show/ep-1?__ak_token=episode`);
  assert.deepEqual(resolved,['hd1']);assert.equal(stream.embed_url,'https://video.example/hd1');
  assert.equal(stream.server_sources[0].label,`Anikoto · ${label}`);
 }
});
test('a show without HD-1 keeps its existing server choice and excludes dub HD-1',async()=>{
 const resolved=[];
 const api=load('src/lib/providers/anikoto.ts',{
  '@/lib/db':{DEFAULT_ANIKOTO_URL:base,getAnikotoBaseUrl:async()=>base},
  './ids':{toAnikotoId:id=>`ak_${id}`,stripAnikotoId:id=>id.replace(/^ak_/,'')},
  '@/lib/anikotoCatalog':{},'@/lib/chromiumFetch':{},
 },{fetch:async url=>{
  const u=new URL(url);
  if(u.pathname==='/ajax/server/list') return new Response(JSON.stringify({status:200,result:
   '<div class="type" data-type="dub"><li data-link-id="dub">HD-1</li></div><div class="type" data-type="sub"><li data-link-id="ten">HD-10</li><li data-link-id="mega">Mega</li></div>'}));
  if(u.pathname==='/ajax/server'){resolved.push(u.searchParams.get('get'));return new Response(JSON.stringify({status:200,result:{url:'https://video.example/mega'}}));}
  return new Response('<html>Episode</html>');
 }});
 const stream=await api.getEpisodeStream(`${base}/watch/show/ep-1?__ak_token=episode`);
 assert.deepEqual(resolved,['mega']);assert.equal(stream.server_sources[0].label,'Anikoto · Mega');
});

// Keep the server-selection regression in the existing playback test entry point.
require('./test-video-server-selection.cjs');
