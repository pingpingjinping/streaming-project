const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const assert=require('node:assert/strict'),{test}=require('node:test');
const root=path.join(__dirname,'..');
const matchOverrides = {getWorkMatchOverrides:async()=>[], importedLinkIsOverridden:()=>false};
function load(file,deps={},globals={}) {
  // HomePage imports its search-only modules even in unrelated catalog tests.
  deps = {
    '@/components/AnissiaDbSearchFallback': { default: () => null },
    '@/lib/anissiaSearchStages': { prepareAnissiaApiSearch: (result) => ({result, needsDbFallback: result.items.length === 0}) },
    '@/lib/cloudflareAnimeSearch': { searchCloudflareAnimeFirst: async () => null },
    '@/lib/manualSubtitleSearch': {
      searchManualSubtitleLinks: async () => [],
      mergeManualSubtitleSearchResults: (remote) => remote,
    },
    '@/lib/animeSearchMode': {
      resolveAnimeSearchMode: (source, scope, mode) => source === 'anissia' && scope === 'current' && mode !== 'page' ? 'db' : 'page',
      shouldQueryCloudflare: mode => mode === 'db',
      shouldUseLocalDbFallback: mode => mode === 'db',
    },
    ...deps,
  };
  deps={'./provisionalWorkMatches':{getProvisionalWorkMatches:async()=>[]},'./workMatchOverrides':matchOverrides,
    '@/lib/koreanSubtitleCatalog':{getKoreanSubtitleCatalog:async()=>{
      throw Error('ReAnime artwork tests must not request the Korean subtitle catalog');
    }},...deps};
  const exports={};
  const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{exports,require:id=>id in deps?deps[id]:require(id.startsWith('@/')?path.join(root,'src',id.slice(2)):id),
    console,URL,URLSearchParams,AbortSignal,Date,process,Buffer,...globals});return exports;
}
const response=data=>({ok:true,json:async()=>data});
function anissia(fetch,links=new Map(),artwork=async()=>null,clock=Date) {
  return load('src/lib/providers/anissia.ts',{
    '../episodeMapping':load('src/lib/episodeMapping.ts'),
    './ids':requireIds(),'../resolvers/videoResolver':{resolveAnissiaStream:async()=>null,parseSeason:()=>null},
    '../reanimeMatches':{getConfirmedReanimeIdsForAnissia:async()=>links},'./reanime':{getReanimeArtwork:artwork,getAnimeDetail:async()=>null},
  },{fetch,Date:clock});
}
function requireIds(){return load('src/lib/providers/ids.ts');}
const meta={poster:'https://cdn.example/reanime-season2.jpg',banner:'',anilistId:2,romajiTitle:'Season 2',nativeTitle:'',
  rating:8,description:'',genres:[],totalEpisodes:12};
test('Anissia uses confirmed ReAnime artwork first and only missing works call AniList',async()=>{
  const searches=[],reanime=[];
  const api=anissia(async(url,options)=>{
    if(url.includes('/anime/list/'))return response({data:{content:[
      {animeNo:1,subject:'연결 작품',originalSubject:'Linked Season 2'},
      {animeNo:2,subject:'없는 작품',originalSubject:'Missing Season 2'}],last:true,totalPages:1}});
    assert.equal(url,'https://graphql.anilist.co');const title=JSON.parse(options.body).variables.search;searches.push(title);
    return response({data:{Media:{id:5,coverImage:{large:'https://cdn.example/anilist.jpg'},title:{native:title}}}});
  },new Map([[1,'linked-season2']]),async id=>{reanime.push(id);return meta;});
  const result=await api.anissiaProvider.searchAnime('작품');
  assert.equal(result.items[0].poster,meta.poster);assert.equal(result.items[1].poster,'https://cdn.example/anilist.jpg');
  assert.deepEqual(reanime,['linked-season2']);assert.deepEqual(searches,['Missing Season 2']);
});
test('Anissia detail also falls back to AniList only if the linked ReAnime poster is absent',async()=>{
  const searches=[];
  const api=anissia(async(url,options)=>{
    if(url.includes('/anime/animeNo/'))return response({data:{subject:'작품 2기',originalSubject:'My Anime Season 2',status:'ON'}});
    if(url.includes('/caption/'))return response({data:[{episode:'1'}]});
    searches.push(JSON.parse(options.body).variables.search);
    return response({data:{Media:{id:22,coverImage:{extraLarge:'https://cdn.example/fallback.jpg'},title:{},episodes:12}}});
  },new Map([[22,'missing-cover']]),async()=>null);
  const result=await api.anissiaProvider.getAnimeDetail('ani_22');
  assert.equal(result.poster,'https://cdn.example/fallback.jpg');assert.deepEqual(searches,['My Anime Season 2']);
});
test('AniList preserves letters, subtitles and seasons and retries transient failures after five minutes',async()=>{
  let now=1000,calls=0;
  class Clock extends Date {static now(){return now;}}
  const titles=[],api=anissia(async(url,options)=>{
    calls++;titles.push(JSON.parse(options.body).variables.search);
    if(calls===1)return {ok:false};
    return response({data:{Media:{id:1,coverImage:{large:'https://cdn.example/one.jpg'},title:{}}}});
  },new Map(),async()=>null,Clock);
  const title='Seasonal Anime Season 2 - The Second Story';
  assert.equal(await api.fetchAniListMeta(title),null);assert.equal(await api.fetchAniListMeta(title),null);assert.equal(calls,1);
  now+=6*60*1000;assert.ok(await api.fetchAniListMeta(title));assert.deepEqual(titles,[title,title]);
});
test('same source titles with different confirmed IDs do not share another season poster',async()=>{
  const api=anissia(async()=>response({data:{content:[{animeNo:11,subject:'동명',originalSubject:'Same'},
    {animeNo:12,subject:'동명',originalSubject:'Same'}],last:true}}),new Map([[11,'season-one'],[12,'season-two']]),
    async id=>({...meta,poster:`https://cdn.example/${id}.jpg`}));
  const result=await api.anissiaProvider.searchAnime('동명');
  assert.equal(result.items[0].poster,'https://cdn.example/season-one.jpg');assert.equal(result.items[1].poster,'https://cdn.example/season-two.jpg');
});
function reanime(fetch,clock=Date) {
  return load('src/lib/providers/reanime.ts',{'./ids':requireIds(),
    '../episodeMapping':load('src/lib/episodeMapping.ts'),
    '@/lib/reanimeMatches':{},'@/lib/db':{DEFAULT_REANIME_URL:'https://reanime.example',getReanimeBaseUrl:async()=> 'https://reanime.example'}},{fetch,Date:clock});
}
test('ReAnime poster lookup fetches only the linked ID, caches and deduplicates concurrent requests',async()=>{
  const requests=[],api=reanime(async url=>{requests.push(url);await new Promise(r=>setImmediate(r));
    return response({anime_id:'actual-season2',title:{},cover_image:{extra_large:'/images/season2.jpg',large:'https://cdn.example/small.jpg'}});});
  const values=await Promise.all([api.getReanimeArtwork('re_actual-season2'),api.getReanimeArtwork('actual-season2')]);
  assert.equal(values[0].poster,'https://reanime.example/images/season2.jpg');assert.equal(values[1].poster,values[0].poster);
  await api.getReanimeArtwork('actual-season2');assert.deepEqual(requests,['https://reanime.example/api/v1/anime/actual-season2']);
  assert.equal(await api.getReanimeArtwork('../escape'),null);assert.equal(requests.length,1);
});
test('wrong ReAnime response IDs and invalid image schemes cannot become a poster',async()=>{
  const api=reanime(async()=>response({anime_id:'another-work',cover_image:{large:'https://cdn.example/wrong.jpg'}}));
  assert.equal(await api.getReanimeArtwork('requested-work'),null);
  const invalid=reanime(async()=>response({anime_id:'requested-work',cover_image:{large:'javascript:alert(1)'},banner_image:'data:image/png,x'}));
  assert.equal(await invalid.getReanimeArtwork('requested-work'),null);
});
test('confirmed reverse lookup refuses multiple works and does not resurrect absent current DB links',async()=>{
  const matches=load('src/lib/reanimeMatches.ts',{'@/data/reanime-matches.json':{'old-link':['기존 제목',3,'']},
    '@/lib/db':{getDb:()=>async()=>[{anissia_no:1,reanime_id:'first'},{anissia_no:1,reanime_id:'second'},{anissia_no:2,reanime_id:'only'}]}});
  const links=await matches.getConfirmedReanimeIdsForAnissia([1,2,3]);
  assert.equal(links.has(1),false);assert.equal(links.get(2),'only');assert.equal(links.has(3),false);
});
test('filtered catalog does not fall back to an unfiltered network feed when DB is unavailable',async()=>{
  const api=load('src/lib/linkedReanimeCatalog.ts',{'./db':{getDb:()=>null},
    './providers/reanime':{getReanimeArtwork:()=>{throw Error('must not fetch');}},'./providers/anissia':{}});
  const result=await api.getLinkedReanimeCatalog({page:2});
  assert.equal(result.items.length,0);assert.equal(result.page,2);assert.equal(result.has_next,false);
});
test('ReAnime page preserves linked mode in pagination/year and never renders an unfiltered fallback',async()=>{
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),requests=[];
  const emptyComponent=()=>null;
  const providers={getProvider:()=>new Proxy({},{get:()=>()=>{throw Error('unfiltered provider must not run');}}),
    LINKKF_GENRES:[],LINKKF_YEARS:[],LINKKF_TYPES:[],REANIME_GENRES:[['액션','Action']],ANISSIA_PRIMARY_GENRES:[],ANISSIA_ALL_GENRES:[]};
  const page=load('src/app/page.tsx',{
    '@/lib/linkedReanimeCatalog':{getLinkedReanimeCatalog:async options=>{requests.push(options);return {items:[],page:options.page,has_next:options.page===1,total_pages:2};}},
    '@/components/Navbar':{__esModule:true,default:emptyComponent},'@/components/AnimeCard':{__esModule:true,default:emptyComponent},
    '@/components/HistoryList':{__esModule:true,default:emptyComponent},'@/components/ReanimeFeedFallback':{__esModule:true,default:()=>React.createElement('div',null,'UNFILTERED_MARKER')},
    '@/components/AnikotoCatalogFilters':{__esModule:true,default:emptyComponent},
    'next/headers':{cookies:async()=>({get:()=>({value:'reanime'})})},'@/lib/providers':providers,
    '@/lib/providers/ohli24':{OHLI24_GENRES:[]},'@/lib/db':{getEnabledStreamingProviders:async()=>['reanime']},
    '@/lib/historyPromotion':{},'@/lib/subtitles':{},'@/lib/auth':{requireAuth:async()=>{}},
    'lucide-react':new Proxy({},{get:()=>emptyComponent}),
    'next/link':{__esModule:true,default:({href,children,...props})=>React.createElement('a',{href,...props},children)},'next/navigation':{},
  });
  const html=renderToStaticMarkup(await page.default({searchParams:Promise.resolve({tab:'list',linked:'1',year:'2024',sort:'year_asc'})}));
  assert.equal(requests[0].year,'2024');assert.equal(requests[0].sort,'year_asc');
  assert.ok(html.includes('name="linked" value="1"'));assert.ok(html.includes('aria-pressed="true"'));
  assert.ok(!html.includes('UNFILTERED_MARKER'));assert.ok(!html.includes('Action'));
  const urls=[...html.matchAll(/href="([^"]+)"/g)].map(m=>new URL(m[1].replaceAll('&amp;','&'),'https://test.example'));
  const next=urls.find(url=>url.searchParams.get('page')==='2');assert.ok(next);
  assert.equal(next.searchParams.get('linked'),'1');assert.equal(next.searchParams.get('year'),'2024');assert.equal(next.searchParams.get('sort'),'year_asc');
  const search=renderToStaticMarkup(await page.default({searchParams:Promise.resolve({tab:'search',linked:'1',q:'작품'})}));
  assert.equal(requests[1].q,'작품');assert.ok(!search.includes('UNFILTERED_MARKER'));
});
test('list API routes confirmed-link search and paging to DB catalog without remote feed',async()=>{
  const requests=[],api=load('src/app/api/anime/list/route.ts',{
    '@/lib/linkedReanimeCatalog':{getLinkedReanimeCatalog:async options=>{requests.push(options);return {items:[],page:options.page,has_next:false,total_pages:1};}},
    '@/lib/providers':{getProvider:()=>new Proxy({},{get:()=>()=>{throw Error('remote provider must not run');}}),REANIME_GENRES:[]},
    '@/lib/providers/ohli24':{},'@/lib/auth':{getSessionUser:async()=>({id:1})},
    '@/lib/db':{getAnissiaCatalogCaptionsOnly:async()=>false},
    '@/lib/anikotoCatalog':{},
    'next/server':{NextResponse:{json:(data,options)=>({data,options})}},
  });
  const result=await api.GET({url:'https://test.example/api/anime/list?source=reanime&linked=1&q=Season%202&page=3&year=2024&sort=year_asc'});
  assert.equal(requests[0].q,'Season 2');assert.equal(requests[0].page,3);assert.equal(requests[0].year,'2024');
  assert.equal(result.options.headers['Cache-Control'],'no-store');assert.equal(result.data.source,'reanime');
});
test('actual Postgres pages confirmed DB works, applies titles/year, and preserves all source rows',
  {skip:!process.env.REVIEWED_TEST_DATABASE_URL},async()=>{
    const postgres=require('postgres'),url=process.env.REVIEWED_TEST_DATABASE_URL,schema=`artwork_test_${process.pid}_${Date.now()}`;
    const admin=postgres(url,{max:1});let sql;
    try {
      await admin.unsafe(`CREATE SCHEMA ${schema}`);sql=postgres(url,{max:3,connection:{search_path:schema}});
      await sql.unsafe(`CREATE TABLE anime_reanime_matches(reanime_id text PRIMARY KEY,korean_title text,anissia_no integer,review_status text);
        CREATE TABLE anime_catalog_entries(source text,source_record_id text,payload jsonb);`);
      for(let i=0;i<45;i++) {
        await sql`INSERT INTO anime_reanime_matches VALUES(${`work-${i}`},${`작품 ${i}`},${i+1},'검토된 사항')`;
        await sql`INSERT INTO anime_catalog_entries VALUES('ReAnime',${`work-${i}`},${sql.json({year:i<23?2024:2023,title_english:`Season ${i}`})})`;
      }
      await sql`INSERT INTO anime_reanime_matches VALUES('held','보류 작품',99,'보류'),('second','다른 연결',1,'자동확정')`;
      await sql`INSERT INTO anime_catalog_entries VALUES('ReAnime','held',${sql.json({year:2025})})`;
      const snapshot=async()=>JSON.stringify([await sql`SELECT * FROM anime_reanime_matches ORDER BY reanime_id`,await sql`SELECT * FROM anime_catalog_entries ORDER BY source_record_id`]);
      const before=await snapshot(),requested=[];
      const api=load('src/lib/linkedReanimeCatalog.ts',{'./db':{getDb:()=>sql},
        './providers/reanime':{getReanimeArtwork:async id=>{requested.push(id);return meta;}},'./providers/anissia':{}});
      const first=await api.getLinkedReanimeCatalog(),second=await api.getLinkedReanimeCatalog({page:2}),last=await api.getLinkedReanimeCatalog({page:3});
      assert.equal(first.items.length,20);assert.equal(first.total_pages,3);assert.equal(first.has_next,true);
      assert.equal(second.items.length,20);assert.equal(last.items.length,5);assert.equal(last.has_next,false);
      assert.equal(new Set([...first.items,...second.items,...last.items].map(i=>i.id)).size,45);
      assert.equal((await api.getLinkedReanimeCatalog({year:'2023'})).total_pages,2);
      assert.equal((await api.getLinkedReanimeCatalog({q:'작품 44'})).items[0].id,'re_work-44');
      assert.equal((await api.getLinkedReanimeCatalog({q:'Season 44'})).items[0].id,'re_work-44');
      assert.equal((await api.getLinkedReanimeCatalog({q:'보류'})).items.length,0);
      assert.equal((await api.getLinkedReanimeCatalog({page:4})).has_next,false);
      assert.ok(!requested.includes('held'));assert.ok(!requested.includes('second'));
      const reverse=load('src/lib/reanimeMatches.ts',{'@/data/reanime-matches.json':{},'@/lib/db':{getDb:()=>sql}});
      const links=await reverse.getConfirmedReanimeIdsForAnissia([1,2,99]);
      assert.equal(links.has(1),false);assert.equal(links.get(2),'work-1');assert.equal(links.has(99),false);
      assert.equal(await snapshot(),before);
    }finally {if(sql)await sql.end();await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
  });

