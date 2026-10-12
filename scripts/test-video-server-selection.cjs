const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript');
const root=path.join(__dirname,'..');
function load(file,deps={},globals={}) {
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true},
 }).outputText,{exports,require:n=>deps[n]??require(n),URL,URLSearchParams,AbortSignal,Date,console,setTimeout,clearTimeout,...globals});return exports;
}
const base='https://anikoto.example';
function provider() {
 let version=0;const calls=[];
 const api=load('src/lib/providers/anikoto.ts',{
  '@/lib/db':{DEFAULT_ANIKOTO_URL:base,getAnikotoBaseUrl:async()=>base},'./ids':{stripAnikotoId:id=>id.replace(/^ak_/,''),toAnikotoId:id=>'ak_'+id},
  '@/lib/chromiumFetch':{},'@/lib/anikotoCatalog':{},
 },{fetch:async url=>{
  const u=new URL(url);calls.push({path:u.pathname,server:u.searchParams.get('get')});
  if(u.pathname==='/ajax/server/list')return new Response(JSON.stringify({status:200,result:
   `<div class="type" data-type="dub"><li data-link-id="dub">HD-1</li></div><div class="type" data-type="sub">
   <li data-link-id="slow-${version}">Vidstream 2</li><li data-link-id="hd1-${version}">HD-1</li><li data-link-id="hd3-${version}">HD-3</li></div>`}));
  if(u.pathname==='/ajax/server')return new Response(JSON.stringify({status:200,result:{url:`https://video.example/${u.searchParams.get('get')}?v=${++version}`}}));
  if(u.pathname.startsWith('/ajax/episode/list/'))return new Response(JSON.stringify({status:200,result:[1,2,51].map(n=>`<a data-num="${n}" data-ids="episode" data-sub="1"></a>`).join('')}));
  return new Response(`<h1>Work</h1><div id="watch-main" data-id="12" data-url="${base}/watch/show"></div>`);
 }});
 return{api,calls};
}
test('Anikoto exposes every non-dub choice but fetches only the selected address, including after token changes',async()=>{
 const p=provider(),detail=await p.api.getAnimeDetail('ak_show');
 const first=await p.api.getEpisodeStream(detail.sub_episodes[0].watch_url);
 assert.equal(first.video_server,'sub:HD-1');assert.equal(first.source_anime_id,'ak_show');
 assert.equal(first.server_sources.length,3);assert.equal(first.server_sources.filter(s=>s.player_url).length,1);
 assert.deepEqual(p.calls.filter(c=>c.path==='/ajax/server').map(c=>c.server),['hd1-0']);
 const second=await p.api.getEpisodeStream(detail.sub_episodes[1].watch_url,{serverKey:'sub:Vidstream 2'});
 assert.equal(second.video_server,'sub:Vidstream 2');assert.match(second.embed_url,/slow-1/);
 assert.deepEqual(p.calls.filter(c=>c.path==='/ajax/server').map(c=>c.server),['hd1-0','slow-1']);
 const invalid=await p.api.getEpisodeStream(detail.sub_episodes[0].watch_url,{serverKey:'dub:HD-1'});
 assert.equal(invalid,null);assert.equal(p.calls.filter(c=>c.path==='/ajax/server').length,2);
});
test('ReAnime alternate server selection keeps the provider response immutable and handles a missing next-episode server',()=>{
 const {selectVideoServer}=load('src/lib/videoServerSelection.ts');
 const first={key:'sub:HD-1',player_url:'https://video.example/1',label:'HD-1'},second={key:'sub:HD-2',player_url:'https://video.example/2',label:'HD-2'};
 const original={success:true,stream_type:'iframe',embed_url:first.player_url,player_url:first.player_url,video_server:first.key,server_sources:[first,second]};
 const selected=selectVideoServer(original,second.key);
 assert.equal(selected.embed_url,second.player_url);assert.equal(selected.video_server,second.key);
 assert.equal(selected.server_sources[0],second);assert.equal(original.embed_url,first.player_url);assert.equal(original.server_sources[0],first);
 assert.equal(selectVideoServer(original,'missing'),original);
});
function route(provider,user={username:'viewer'}) {
 return load('src/app/api/anime/video-server/route.ts',{
  '@/lib/auth':{getSessionUser:async()=>user},'@/lib/providers/anikoto':{anikotoProvider:provider},
  'next/server':{NextResponse:{json:(data,init)=>({data,status:init.status,headers:init.headers})}},
 }).GET;
}
test('lazy Anikoto switching uses the exact provider episode and fresh selected server, with no signed URL HTTP caching',async()=>{
 const p=provider(),run=route(p.api);
 const result=await run({url:'https://app.example/api?id=ak_show&ep=51&server=sub%3AVidstream%202'});
 assert.equal(result.status,200);assert.equal(result.data.video_server,'sub:Vidstream 2');
 assert.equal(result.headers['Cache-Control'],'no-store');assert.match(result.data.embed_url,/slow-0/);
 assert.equal(p.calls.filter(c=>c.path==='/ajax/server').length,1);
 assert.ok(p.calls.some(c=>c.path==='/watch/show/ep-51'));
});
test('lazy switching rejects unauthenticated and invalid work/episode requests before provider access',async()=>{
 let lookups=0;const p={getAnimeDetail:async()=>{lookups++;return null;}};
 assert.equal((await route(p,null)({url:'https://app.example/api?id=ak_show&ep=1&server=x'})).status,401);
 for(const query of ['id=re_show&ep=1&server=x','id=ak_..%2Fsecret&ep=1&server=x','id=ak_show&ep=-1&server=x','id=ak_show&server=x','id=ak_show&ep=1']) {
  assert.equal((await route(p)({url:'https://app.example/api?'+query})).status,400);
 }
 assert.equal(lookups,0);
});
test('episode-info preserves the chosen Anikoto server through the canonical work resolver',async()=>{
 const calls=[];
 const api=load('src/app/api/anime/episode_info/route.ts',{
  '@/lib/auth':{getSessionUser:async()=>({username:'viewer'})},'@/lib/db':{getSubtitleEpisodeStart:async()=>null},
  '@/lib/providers':{getProviderByAnimeId:()=>({name:'anissia',getAnimeDetail:async()=>({title:'Work',sub_episodes:[{number:1,watch_url:'/1'},{number:2,watch_url:'/2'}],dub_episodes:[]})})},
  '@/lib/resolvers/videoResolver':{resolveAnissiaStream:async(...args)=>{calls.push(args);return{success:true,embed_url:'https://video.example/second',video_server:'sub:Vidstream 2',video_source:'anikoto',server_sources:[]};}},
  '@/lib/reviewedProviderPlayback':{reviewedProviderPlayback:async anime=>anime},
  '@/lib/episodeMapping':{attachEpisodeCaptions:(a)=>a},
  'next/server':{NextResponse:{json:(data,init)=>({data,status:init?.status||200,headers:init?.headers})}},
 });
 const result=await api.GET({url:'https://app.example/api?id=ani_42&ep=2&video_source=anikoto&video_server=sub%3AVidstream%202'});
 assert.equal(result.data.success,true);assert.equal(result.data.video_server,'sub:Vidstream 2');assert.equal(calls[0].at(-1),'sub:Vidstream 2');
});
