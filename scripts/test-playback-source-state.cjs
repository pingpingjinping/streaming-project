const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript');
const root=path.join(__dirname,'..');
function load(file,deps={}){
 const exports={};const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
 }).outputText;
 vm.runInNewContext(code,{exports,require:name=>deps[name]||{},URL,AbortSignal,console});return exports;
}
const identity=load('src/lib/animeWorkIdentity.ts',{'@/lib/db':{getDb:()=>null}});
const resolver=load('src/lib/resolvers/videoResolver.ts',{'../animeWorkIdentity':identity});
const jp='ヘルモード ～やり込み好きのゲーマーは廃設定の異世界で無双する～';
const ko='헬 모드 ~파고들기 좋아하는 게이머는 폐급 설정 이세계에서 무쌍한다~ 2nd Season';
const en='Hell Mode: Yarikomi-zuki no Gamer wa Haisettei no Isekai de Musou Suru';
test('season parser does not read Knights or second-year curriculum numbers as the season',()=>{
 assert.equal(resolver.parseSeason('일곱 개의 대죄: 묵시록의 4기사 2기'),2);
 assert.equal(resolver.parseSeason('ようこそ実力至上主義の教室へ 4th Season 2年生編1学期'),4);
 assert.equal(resolver.parseSeason('Classroom of the Elite 4th Season 2-nensei-hen 1-gakki'),4);
 assert.equal(resolver.parseSeason('작품 Season 2'),2);
});
test('Hell Mode season 2 cannot match season 1 through its shared undecorated Japanese alias',()=>{
 const aliases=[ko,jp,en+' 2nd Season'];
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:en,original_title:jp},aliases,null,false),false);
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:en+' 2nd Season',original_title:jp},aliases,null,false),true);
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:en+' 3rd Season',original_title:jp},aliases,null,false),false);
});
test('combined provider playlists require explicit permission while correctly separated seasons still match',()=>{
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:'Work',original_title:'作品'},['Work 2nd Season','作品'],null,false),false);
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:'Work'},['Work 2nd Season'],null,true),true);
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:'Work'},['Work','作品'],null,false),true);
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:'Work 2nd Season'},['Work','作品'],null,false),false);
});
test('conflicting numbered season aliases are not accepted as proof of an automatic provider match',()=>{
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:'Work 2nd Season'},['Work 2nd Season','Work 3rd Season'],null,false),false);
});
test('ReAnime to Anikoto changes iframe identity as well as sandbox before the new document loads',()=>{
 const react={useRef:v=>({current:v}),useState:v=>[typeof v==='function'?v():v,()=>{}],useCallback:f=>f,useEffect(){}};
 const jsx={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})};
 const component=load('src/components/IframePlayer.tsx',{
  react,'react/jsx-runtime':jsx,'next/link':{default:'Link'},'lucide-react':{},
  './PlayerSettingsModal':{DEFAULT_PLAYER_SETTINGS:{},getSubtitleOffsetY:()=>0},
  './usePlayerFullscreen':{usePlayerFullscreen:()=>({mode:'inline',isFullscreen:false,toggleFullscreen(){}})},
  './useContainedPlayerFrame':{useContainedPlayerFrame(){}},
 }).default;
 function find(node){if(!node||typeof node!=='object')return;if(node.type==='iframe')return node;for(const child of [node.props?.children].flat(Infinity)){const found=find(child);if(found)return found;}}
 function frame(url,id){return find(component({animeId:'ani_3485',animeTitle:ko,episodeNumber:1,embedUrl:url,serverSources:[{id,label:id,player_url:url}]}));}
 const before=frame('https://video.example/embed/one','rean');
 const after=frame('https://video.example/embed/two','anikoto');
 assert.match(before.props.sandbox,/allow-scripts/);
 assert.equal(after.props.sandbox,undefined);
 assert.notEqual(before.key,after.key);
 assert.notEqual(before.key,frame('https://video.example/embed/one','anikoto').key,'same URL with new sandbox policy still gets a fresh iframe document');
 assert.equal(after.key,frame('https://video.example/embed/two','anikoto').key);
});
test('shared Anissia original title looks up season-2 metadata and selects its separate 13-episode Anikoto source',async()=>{
 const queries=[],played=[];
 const first={id:'ak_first',title:en,original_title:en,sub_episodes:Array.from({length:12},(_,i)=>({number:i+1,title:`${i+1}화`,watch_url:`https://video.example/first/${i+1}`}))};
 const second={id:'ak_second',title:en+' 2nd Season',original_title:en+' 2nd Season',sub_episodes:Array.from({length:13},(_,i)=>({number:i+1,title:`${i+1}화`,watch_url:`https://video.example/second/${i+1}`}))};
 const api=load('src/lib/resolvers/videoResolver.ts',{
  '../animeWorkIdentity':{...identity,getAnimeWorkIdentity:async()=>({titles:[ko,jp],format:'TV'})},
  '../db':{getAnissiaStreamCache:async()=>null,setAnissiaStreamCache:async()=>{}},
  '../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:async()=>new Set(),hasWorkMatchCandidates:async()=>false},
  '../workMatchOverrides':{getWorkMatchOverrides:async()=>[]},
  '../reanimeMatches':{getEffectiveReanimeIdsForAnissia:async()=>new Map()},
  '../anikotoWorkOverrides':{getAnikotoWorkOverride:async()=>null},
  '../anikotoLinks':{getAnikotoPlaybackCandidates:async()=>[]},
  '../providers/anissia':{fetchAniListMeta:async q=>{queries.push(q);return{anilistId:209983,nativeTitle:jp+' 2nd Season',romajiTitle:en+' 2nd Season'};}},
  '../providers/anikoto':{anikotoProvider:{searchAnime:async()=>({items:[first,second]}),getAnimeDetail:async id=>id==='ak_first'?first:second,
    getEpisodeStream:async url=>{played.push(url);return {success:true,embed_url:url,stream_type:'iframe'};}}},
 });
 const result=await api.resolveAnissiaStream(3485,1,ko,jp,'anikoto','ani_3485',null,undefined,true);
 assert.deepEqual(queries,[jp+' 2nd Season']);
 assert.deepEqual(played,['https://video.example/second/1']);
 assert.equal(result.video_source,'anikoto');
 assert.equal(result.video_episodes.length,13);
 assert.equal(result.video_episodes[0].number,1);
 assert.equal(result.video_episodes[12].number,13);
});

test('ani_3485 provider switch uses exact local season-2 metadata when remote AniList is unavailable',async()=>{
 const played=[],localQueries=[];let remoteCalls=0;
 const native=jp+' 2nd Season',romaji=en+' 2nd Season';
 const localIdentity=load('src/lib/animeWorkIdentity.ts',{'@/lib/db':{getDb:()=>async(strings,...values)=>{
   localQueries.push(values);assert.match(strings.join(''),/source='AniList'/);
   assert.ok(values.every(list=>list.includes(identity.normalizeIdentityTitle(native))&&!list.includes(identity.normalizeIdentityTitle(jp))));
   return [{source_record_id:'209983',payload:{title_native:native,title_romaji:romaji,title_english:'HELL MODE: The Hardcore Gamer Dominates in Another World with Garbage Balancing Season 2',format:'TV'}}];
 }}});
 const first={id:'ak_first',title:en,original_title:jp,sub_episodes:[{number:1,watch_url:'https://video.example/first/1'}]};
 const second={id:'ak_second',title:romaji,original_title:romaji,sub_episodes:Array.from({length:13},(_,i)=>({number:i+1,watch_url:`https://video.example/second/${i+1}`}))};
 const api=load('src/lib/resolvers/videoResolver.ts',{
  '../animeWorkIdentity':{...localIdentity,getAnimeWorkIdentity:async()=>({titles:[ko,jp],format:'TV'})},
  '../db':{getAnissiaStreamCache:async()=>null,setAnissiaStreamCache:async()=>{}},
  '../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:async()=>new Set(),hasWorkMatchCandidates:async()=>false},
  '../workMatchOverrides':{getWorkMatchOverrides:async()=>[]},'../reanimeMatches':{getEffectiveReanimeIdsForAnissia:async()=>new Map()},
  '../anikotoWorkOverrides':{getAnikotoWorkOverride:async()=>null},'../anikotoLinks':{getAnikotoPlaybackCandidates:async()=>[]},
  '../providers/anissia':{fetchAniListMeta:async()=>{remoteCalls++;return null;}},
  '../providers/anikoto':{anikotoProvider:{searchAnime:async()=>({items:[first,second]}),getAnimeDetail:async id=>id==='ak_first'?first:second,
    getEpisodeStream:async url=>{played.push(url);return {success:true,embed_url:url,stream_type:'iframe'};}}},
 });
 const result=await api.resolveAnissiaStream(3485,1,ko,jp,'anikoto','ani_3485',null,undefined,true);
 assert.equal(remoteCalls,0);assert.equal(localQueries.length,1);
 assert.deepEqual(played,['https://video.example/second/1']);assert.equal(result.video_source,'anikoto');assert.equal(result.video_episodes.length,13);
});

test('local title lookup rejects conflicting catalog IDs and a different season returned by storage',async()=>{
 const requested=jp+' 2nd Season';
 const row={source_record_id:'209983',payload:JSON.stringify({title_native:requested,title_romaji:en+' 2nd Season',format:'TV'})};
 let rows=[row];
 const local=load('src/lib/animeWorkIdentity.ts',{'@/lib/db':{getDb:()=>async()=>rows}});
 assert.equal((await local.getCatalogWorkIdentityByTitle(requested)).anilistId,209983);
 rows=[row,{...row,source_record_id:'999'}];assert.equal(await local.getCatalogWorkIdentityByTitle(requested),null);
 rows=[{source_record_id:'185262',payload:{title_native:jp,title_romaji:en}}];assert.equal(await local.getCatalogWorkIdentityByTitle(requested),null);
});

test('local sequel title variants keep complete franchise, fraction and part names while changing only the season suffix',()=>{
 const variants=identity.catalogSeasonTitleVariants('作品',2);
 assert.ok(variants.includes('作品 第2期'));assert.ok(variants.includes('作品 II'));assert.ok(variants.includes('作品 Season 2'));
 assert.ok(!variants.includes('作品'));
 assert.ok(identity.catalogSeasonTitleVariants('作品２',2).includes('作品2'));
 assert.ok(identity.catalogSeasonTitleVariants('作品 II',2).includes('作品 第2期'));
 assert.ok(identity.catalogSeasonTitleVariants('らんま 1/2',2).includes('らんま 1/2 第2期'));
 assert.ok(identity.catalogSeasonTitleVariants('作品 Part 2',3).includes('作品 Part 2 第3期'));
 assert.ok(identity.catalogSeasonTitleVariants('ダンジョンⅣ 深章 厄災篇',4).includes('ダンジョンⅣ 深章 厄災篇'));
 assert.ok(identity.catalogSeasonTitleVariants('Work 4th Season Part 2',4).includes('Work 4th Season Part 2'));
});

test('bare numeric sequel playback needs a verified catalog ID and exact full title, and cannot use the first season',()=>{
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:'Isekai wa Smartphone to Tomo ni. 2'},['作品 2기','Isekai wa Smartphone to Tomo ni. 2'],147571,false),true);
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:'Isekai wa Smartphone to Tomo ni. 2'},['作品 2기','Isekai wa Smartphone to Tomo ni. 2'],null,false),false);
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:'Isekai wa Smartphone to Tomo ni.'},['作品 2기','Isekai wa Smartphone to Tomo ni. 2','Isekai wa Smartphone to Tomo ni.'],147571,false),false);
 assert.equal(resolver.matchesVideoPlaybackIdentity({title:'Work 12'},['作品 2기','Work 12'],147571,false),false);
});

test('Postgres local lookup handles 第2期, II, Japanese season labels and full-width digits without matching the first season', {skip:!process.env.REVIEWED_TEST_DATABASE_URL}, async()=>{
 const sql=require('postgres')(process.env.REVIEWED_TEST_DATABASE_URL,{max:1});
 try {await sql.begin(async tx=>{
  await tx`CREATE TEMP TABLE anime_catalog_entries (source text, source_record_id text, payload jsonb) ON COMMIT DROP`;
  const fixtures=[
   ['154768','その着せ替え人形は恋をする Season 2','その着せ替え人形は恋をする',2],
   ['185542','骸骨騎士様、只今異世界へお出掛け中Ⅱ','骸骨騎士様、只今異世界へお出掛け中',2],
   ['185660','ダンダダン 第2期','ダンダダン',2],
   ['176314','佐々木とピーちゃん シーズン２','佐々木とピーちゃん',2],
   ['147571','異世界はスマートフォンとともに。2','異世界はスマートフォンとともに。2',2],
  ];
  for(const [id,native,base] of fixtures){
   await tx`INSERT INTO anime_catalog_entries VALUES ('AniList',${id},${tx.json({title_native:native,title_romaji:'Unique Work '+id+' Season 2',format:'TV'})})`;
   await tx`INSERT INTO anime_catalog_entries VALUES ('AniList',${'first-'+id},${tx.json({title_native:base.replace(/2$/,''),format:'TV'})})`;
  }
  const local=load('src/lib/animeWorkIdentity.ts',{'@/lib/db':{getDb:()=>tx}});
  for(const [id,,base,season] of fixtures)assert.equal((await local.getCatalogWorkIdentityByTitle(base,season))?.anilistId,Number(id));
  await tx`INSERT INTO anime_catalog_entries VALUES ('AniList','999',${tx.json({title_native:'ダンダダン 第２期'})})`;
  assert.equal(await local.getCatalogWorkIdentityByTitle('ダンダダン',2),null);
 });} finally {await sql.end();}
});

