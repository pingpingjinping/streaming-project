const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const assert=require('node:assert/strict'),{test}=require('node:test');
const root=path.join(__dirname,'..');
function load(file,deps={},globals={}) {
  const exports={};
  const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{exports,require:name=>name in deps?deps[name]:require(name),
    console,URL,URLSearchParams,AbortSignal,AbortController,Date,process,Buffer,...globals});return exports;
}
const manual=[{reanimeId:'fixed-season-2',anissiaNo:42,updatedBy:'admin'}];
const overrideApi=(sql)=>load('src/lib/workMatchOverrides.ts',{'./db':{getDb:()=>sql,initDb:async()=>{}}});
function matches(sql,overrides=manual,bundled={}) {
  const helpers=overrideApi(null);
  return load('src/lib/reanimeMatches.ts',{'@/data/reanime-matches.json':bundled,'@/lib/db':{getDb:()=>sql},
    './provisionalWorkMatches':{getProvisionalWorkMatches:async()=>[]},'./workMatchOverrides':{...helpers,getWorkMatchOverrides:async()=>overrides}});
}
test('manual reverse link displaces old imported links in both directions',async()=>{
  const api=matches(async()=>[
    {reanime_id:'wrong-season-1',anissia_no:42},
    {reanime_id:'fixed-season-2',anissia_no:99},
    {reanime_id:'unrelated',anissia_no:7},
  ]);
  const links=await api.getConfirmedReanimeIdsForAnissia([42,99,7]);
  assert.equal(links.get(42),'fixed-season-2');assert.equal(links.has(99),false);assert.equal(links.get(7),'unrelated');
});
test('manual subtitle target overrides imported and bundled targets',async()=>{
  const sql=async(strings)=>String(strings).includes('anime_catalog_entries')?[{title:'올바른 2기'}]:[{korean_title:'이전 연결',anissia_no:42}];
  const api=matches(sql);
  assert.equal((await api.getReanimeMatch('re_fixed-season-2')).anissiaNo,42);
  assert.equal((await api.getReanimeMatch('re_wrong-season-1')).anissiaNo,null);
  const fallback=matches(null,manual,{'wrong-season-1':['이전',42,'']});
  assert.equal((await fallback.getReanimeMatch('re_wrong-season-1')).anissiaNo,null);
});
test('older schema falls back only for absent override table; DB errors are surfaced',async()=>{
  assert.equal((await overrideApi(async()=>{throw {code:'42P01'};}).getWorkMatchOverrides()).length,0);
  await assert.rejects(overrideApi(async()=>{throw new Error('connection failed');}).getWorkMatchOverrides(),/connection failed/);
});
test('manual pair is stored in a separate transaction and playback cache is discarded',async()=>{
  const calls=[];const sql=()=>{};sql.begin=async fn=>fn(async(strings,...values)=>{calls.push({text:strings.join('?'),values});return [];});
  await overrideApi(sql).saveWorkMatchOverride('ani_42','fixed-season-2',42,'admin');
  assert.ok(calls[0].text.includes('advisory_xact_lock'));
  assert.ok(calls.some(c=>c.text.includes('INSERT INTO anime_work_match_overrides') && c.values.includes('admin')));
  assert.ok(calls.some(c=>c.text.includes('DELETE FROM anissia_stream_cache')));
  assert.ok(calls.every(c=>!c.text.includes('DELETE FROM anime_reanime_matches') && !c.text.includes('UPDATE anime_catalog_entries')));
});
test('reset deletes only manual pair and clears its playback cache',async()=>{
  const calls=[];const sql=()=>{};sql.begin=async fn=>fn(async(strings,...values)=>{
    const text=strings.join('?');calls.push({text,values});return text.includes('RETURNING')?[{anissia_no:42}]:[];
  });
  await overrideApi(sql).resetWorkMatchOverride('re_fixed-season-2');
  assert.ok(calls.some(c=>c.text.includes('DELETE FROM anime_work_match_overrides')));
  assert.ok(calls.some(c=>c.text.includes('DELETE FROM anissia_stream_cache') && c.values[0]===42));
});
function route(user,sql) {
  const calls=[];
  const response={json:(data,options={})=>({data,status:options.status||200})};
  const api=load('src/app/api/anime/work-match/route.ts',{
    'next/server':{NextResponse:response},'@/lib/auth':{getSessionUser:async()=>user},'@/lib/db':{getDb:()=>sql},
    '@/lib/provisionalWorkMatches':{getProvisionalWorkMatches:async()=>[],candidateReason:x=>x},'@/lib/reanimeMatches':{getReanimeMatch:async()=>null,getEffectiveReanimeIdsForAnissia:async()=>new Map()},
    '@/lib/workMatchOverrides':{...overrideApi(null),getWorkMatchOverrides:async()=>[],
      saveWorkMatchOverride:async(...values)=>{calls.push(values);},resetWorkMatchOverride:async(...values)=>calls.push(values)},
  });return {...api,calls};
}
const request=(body={},params={})=>({json:async()=>body,nextUrl:new URL('https://app.example/api?'+new URLSearchParams(params))});
test('shared manual matching requires authentication and administrator for mutation',async()=>{
  assert.equal((await route(null,null).PUT(request())).status,401);
  assert.equal((await route({isAdmin:false},null).PUT(request())).status,403);
  assert.equal((await route({isAdmin:false},null).DELETE(request({}, {animeId:'ani_42'}))).status,403);
});
test('API validates both imported works before accepting either direction',async()=>{
  const api=route({isAdmin:true,username:'admin'},async()=>[{source:'Anissia'},{source:'ReAnime'}]);
  assert.equal((await api.PUT(request({animeId:'ani_42',targetId:'fixed-season-2'}))).status,200);
  assert.equal((await api.PUT(request({animeId:'re_fixed-season-2',targetId:'42'}))).status,200);
  assert.equal(api.calls.length,2);assert.equal(api.calls[0][2],42);
  assert.equal((await api.PUT(request({animeId:'ani_42',targetId:'../invalid'}))).status,400);
  const absent=route({isAdmin:true},async()=>[{source:'Anissia'}]);
  assert.equal((await absent.PUT(request({animeId:'ani_42',targetId:'missing'}))).status,404);assert.equal(absent.calls.length,0);
});
function resolver(hasEpisode=true,confirmed=true,held=false) {
  const searches=[],streams=[],details=[];
  const mapping=load('src/lib/episodeMapping.ts');
  const reanime={getAnimeDetail:async id=>{details.push(id);return {title:'Correct Season 2',sub_episodes:hasEpisode?[{number:1,watch_url:'correct/1'}]:[]};},
    getEpisodeStream:async url=>{streams.push(url);return {embed_url:url};},searchAnime:async q=>{searches.push(q);return {items:confirmed?[]:[{id:'fixed-season-2',title:'Correct Season 2'}]};}};
  const api=load('src/lib/resolvers/videoResolver.ts',{
    '../provisionalWorkMatches':{getReservedReanimeIdsForOtherWorks:async()=>new Set(),hasWorkMatchCandidates:async()=>held},'../workMatchOverrides':{getWorkMatchOverrides:async()=>manual},
    '../episodeMapping':mapping,'../reanimeMatches':{getEffectiveReanimeIdsForAnissia:async()=>confirmed?new Map([[42,'fixed-season-2']]):new Map()},
    '../providers/reanime':{reanimeProvider:reanime},'../providers/anissia':{fetchAniListMeta:async()=>null},
    '../providers/anikoto':{},'../providers/linkkf':{},'../providers/ohli24':{},'../anikotoLinks':{},'../animeWorkIdentity':load('src/lib/animeWorkIdentity.ts',{'@/lib/db':{getDb:()=>null}}),
    '../db':{getAnissiaStreamCache:async()=>({reanime_id:confirmed?'wrong-season-1':'fixed-season-2'}),setAnissiaStreamCache:async()=>{}},
  },{fetch:()=>{throw Error('unexpected network');}});
  return {...api,searches,streams,details};
}
test('confirmed work wins over heuristic cache and does not run title search',async()=>{
  const api=resolver();const result=await api.resolveAnissiaStream(42,1,'Correct Season 2','Correct Season 2','rean','ani_42');
  assert.equal(result.embed_url,'correct/1');assert.equal(api.searches.length,0);assert.ok(api.details.every(id=>id==='fixed-season-2'));
});
test('withheld catalog candidates cannot be bypassed by title search or stale playback cache',async()=>{
  const api=resolver(true,false,true);await api.resolveAnissiaStream(42,1,'Sequel Season 4','Original','rean','ani_42');
  assert.equal(api.searches.length,0);assert.equal(api.streams.length,0);assert.equal(api.details.length,0);
});
test('missing episode on selected work cannot silently pick another ReAnime work',async()=>{
  const api=resolver(false);await api.resolveAnissiaStream(42,1,'Correct Season 2','Correct Season 2','rean','ani_42');
  assert.equal(api.searches.length,0);assert.equal(api.streams.length,0);
});
test('a manual target reserved for another work is excluded from heuristic search',async()=>{
  const api=resolver(true,false);
  await api.resolveAnissiaStream(99,1,'Correct Season 2','Correct Season 2','rean','ani_99');
  assert.equal(api.streams.length,0);assert.ok(!api.details.includes('fixed-season-2'));
});
test('Postgres migration, collision rollback, refresh persistence and linked catalog use manual pairs',
  {skip:!process.env.REVIEWED_TEST_DATABASE_URL},async()=>{
    const postgres=require('postgres'),schema=`work_match_${process.pid}_${Date.now()}`;
    const admin=postgres(process.env.REVIEWED_TEST_DATABASE_URL,{max:1});let sql;
    try {
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      sql=postgres(process.env.REVIEWED_TEST_DATABASE_URL,{max:3,connection:{search_path:schema}});
      const db=load('src/lib/db.ts',{'postgres':()=>sql,'./subtitleLocalIdentity':{},'./episodeMapping':load('src/lib/episodeMapping.ts')},
        {process:{env:{DATABASE_URL:'test'}}});
      await db.initDb();
      await sql.unsafe(`CREATE TABLE anime_catalog_entries(source text,source_record_id text,payload jsonb);
        CREATE TABLE anime_reanime_matches(reanime_id text PRIMARY KEY,korean_title text,anissia_no integer,review_status text);
        CREATE TABLE anime_monthly_match_candidates(reanime_id text,anissia_no integer,score integer,reason text,evidence jsonb);`);
      await sql`INSERT INTO anime_catalog_entries VALUES
        ('Anissia','42',${sql.json({title_ko:'올바른 2기',year:2026})}),
        ('Anissia','99',${sql.json({title_ko:'다른 작품',year:2026})}),
        ('ReAnime','fixed-season-2',${sql.json({title_english:'Correct Season 2',year:2026})}),
        ('ReAnime','wrong-season-1',${sql.json({title_english:'Wrong Season 1',year:2026})})`;
      await sql`INSERT INTO anime_reanime_matches VALUES ('wrong-season-1','이전',42,'자동확정'),('fixed-season-2','다른 작품',99,'자동확정')`;
      const search=await route({isAdmin:true},sql).GET(request({}, {animeId:'ani_42',q:'다른 작품'}));
      assert.equal(search.status,200);assert.equal(search.data.candidates[0].id,'fixed-season-2');
      await sql`INSERT INTO anime_monthly_match_candidates VALUES ('fixed-season-2',42,80,'season_missing','{"conflicts":[],"missing":["season_missing"]}')`;
      const heldSearch=await route({isAdmin:true},sql).GET(request({}, {animeId:'ani_99',q:'올바른'}));
      assert.equal(heldSearch.data.candidates[0].id,'fixed-season-2');
      const before=JSON.stringify(await sql`SELECT * FROM anime_reanime_matches ORDER BY reanime_id`);
      const api=load('src/lib/workMatchOverrides.ts',{'./db':db});
      await api.saveWorkMatchOverride('ani_42','fixed-season-2',42,'admin');
      await sql`INSERT INTO anime_work_match_overrides(reanime_id,anissia_no,updated_by) VALUES('another-manual',99,'admin')`;
      await assert.rejects(api.saveWorkMatchOverride('ani_42','another-manual',42,'admin'),error=>error.code==='23505');
      assert.equal((await api.getWorkMatchOverrides()).find(r=>r.anissiaNo===42).reanimeId,'fixed-season-2');
      const linked=load('src/lib/linkedReanimeCatalog.ts',{'./db':db,'./workMatchOverrides':api,'./provisionalWorkMatches':{getProvisionalWorkMatches:async()=>[]},
        './providers/reanime':{getReanimeArtwork:async()=>({poster:'correct.jpg'})},'./providers/anissia':{}});
      const result=await linked.getLinkedReanimeCatalog();
      assert.equal(result.items.length,1);assert.equal(result.items[0].id,'re_fixed-season-2');assert.equal(result.items[0].title,'올바른 2기');
      assert.equal(JSON.stringify(await sql`SELECT * FROM anime_reanime_matches ORDER BY reanime_id`),before);
      await sql`UPDATE anime_reanime_matches SET anissia_no=100,korean_title='갱신 결과'`;
      assert.equal((await api.getWorkMatchOverrides()).find(r=>r.anissiaNo===42).reanimeId,'fixed-season-2');
      await api.resetWorkMatchOverride('ani_42');
      assert.ok(!(await api.getWorkMatchOverrides()).some(r=>r.anissiaNo===42));
      assert.equal((await sql`SELECT korean_title FROM anime_reanime_matches WHERE reanime_id='fixed-season-2'`)[0].korean_title,'갱신 결과');
      // Candidate allocation is live, symmetric, and survives catalog storage
      // without mutating any confirmed import row.
      await sql`INSERT INTO anime_catalog_entries VALUES
        ('Anissia','11',${sql.json({title_ko:'후보 작품',year:2027})}),
        ('Anissia','12',${sql.json({title_ko:'후보 작품 2기',year:2027})}),
        ('ReAnime','candidate-one',${sql.json({title_english:'Candidate Season 1',year:2027})}),
        ('ReAnime','candidate-two',${sql.json({title_english:'Candidate Season 2',year:2027})})`;
      await sql`INSERT INTO anime_reanime_matches VALUES ('candidate-two','후보 작품 2기',12,'자동확정')`;
      await sql`INSERT INTO anime_monthly_match_candidates VALUES
        ('candidate-one',11,80,'season_missing',${sql.json({conflicts:[],missing:['season_missing'],source_seasons:[],target_seasons:[1]})}),
        ('candidate-two',11,90,'season_missing',${sql.json({conflicts:[],missing:['season_missing'],source_seasons:[],target_seasons:[1]})})`;
      const provisional=load('src/lib/provisionalWorkMatches.ts',{'./db':db,'./workMatchOverrides':api});
      const actualMatches=load('src/lib/reanimeMatches.ts',{'@/lib/db':db,'@/data/reanime-matches.json':{},
        './workMatchOverrides':api,'./provisionalWorkMatches':provisional});
      const candidates=await provisional.getProvisionalWorkMatches();
      assert.equal(candidates.length,1);assert.equal(candidates[0].reanimeId,'candidate-one');
      assert.equal((await actualMatches.getReanimeMatch('re_candidate-one')).matchStatus,'candidate');
      assert.equal((await actualMatches.getEffectiveReanimeIdsForAnissia([11])).get(11),'candidate-one');
      const linkedWithCandidates=load('src/lib/linkedReanimeCatalog.ts',{'./db':db,'./workMatchOverrides':api,
        './provisionalWorkMatches':provisional,'./providers/reanime':{getReanimeArtwork:async()=>({poster:'correct.jpg'})},'./providers/anissia':{}});
      const candidateCatalog=await linkedWithCandidates.getLinkedReanimeCatalog();
      assert.equal(candidateCatalog.items[0].id,'re_candidate-one');assert.ok(candidateCatalog.items[0].remarks.startsWith('후보 연결'));
      const actualRoute=load('src/app/api/anime/work-match/route.ts',{'next/server':{NextResponse:{json:(data,options={})=>({data,status:options.status||200})}},
        '@/lib/auth':{getSessionUser:async()=>({isAdmin:true,username:'admin'})},'@/lib/db':db,
        '@/lib/reanimeMatches':actualMatches,'@/lib/workMatchOverrides':api,'@/lib/provisionalWorkMatches':provisional});
      const candidateDetail=await actualRoute.GET(request({}, {animeId:'ani_11'}));
      assert.equal(candidateDetail.status,200);assert.equal(candidateDetail.data.matchStatus,'candidate');
      assert.equal(candidateDetail.data.current.id,'candidate-one');assert.equal(candidateDetail.data.candidates[0].id,'candidate-one');
      assert.equal((await actualRoute.GET(request({}, {animeId:'re_candidate-one'}))).data.matchStatus,'candidate');
      assert.equal((await actualRoute.PUT(request({animeId:'ani_11',targetId:'candidate-one'}))).status,200);
      assert.equal((await provisional.getProvisionalWorkMatches()).length,0);
      assert.equal((await actualRoute.GET(request({}, {animeId:'ani_11'}))).data.matchStatus,'confirmed');
      assert.equal((await sql`SELECT anissia_no FROM anime_reanime_matches WHERE reanime_id='candidate-two'`)[0].anissia_no,12);

    }finally{if(sql)await sql.end();await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
  });

function treeElements(tree) {
  if(!tree || typeof tree!=='object')return [];
  if(Array.isArray(tree))return tree.flatMap(treeElements);
  return [tree,...treeElements(tree.props?.children)];
}
function workMatchControl({retryPlayback=true,canEdit=true,saveOk=true}={}) {
  const states=[],effects=[],requests=[],replacements=[];
  let cursor=0,refreshes=0,retries=0;
  const right={id:'ensemble',title:'Tokubetsu-hen Hibike! Euphonium: Ensemble Contest'};
  const component=load('src/components/WorkMatchSetting.tsx',{
    react:{useState:initial=>{
      const index=cursor++;
      if(!(index in states))states[index]=initial;
      return [states[index],value=>{states[index]=value;}];
    },useEffect:callback=>{effects.push(callback);}},
    'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
    'next/navigation':{useRouter:()=>({replace:url=>replacements.push(url),refresh:()=>refreshes++})},
  },{window:{location:{pathname:'/watch/ani_2425/7',search:'?video_source=anikoto&creator=author&sub_url=https%3A%2F%2Fblog.example%2F7&dub=1&source_ep=1&manual_source=9'}},
    fetch:async(url,options={})=>{
      requests.push({url,options});
      if(options.method==='PUT')return {ok:saveOk,json:async()=>saveOk?{success:true}:{message:'save failed'}};
      const searching=new URL(url,'https://app.example').searchParams.get('q');
      return {ok:true,json:async()=>({current:null,manual:false,canEdit,candidates:searching?[right]:[]})};
    }}).default;
  const render=()=>{cursor=0;return component({animeId:'ani_2425',retryPlayback,onConnectionSaved:()=>retries++});};
  const init=async()=>{render();effects.shift()();await new Promise(resolve=>setImmediate(resolve));return render();};
  return {init,render,requests,replacements,get refreshes(){return refreshes;},get retries(){return retries;}};
}
test('failed playback can search the DB, save a link and retry the same episode using its linked provider',async()=>{
  const ui=workMatchControl();
  let tree=await ui.init();
  treeElements(tree).find(e=>e.type==='input').props.onChange({target:{value:'Ensemble Contest'}});
  tree=ui.render();
  await treeElements(tree).find(e=>e.type==='form').props.onSubmit({preventDefault(){}});
  tree=ui.render();
  const save=treeElements(tree).find(e=>e.type==='button' && e.props.children==='연결하고 다시 재생');
  assert.ok(save);
  await save.props.onClick();
  const put=ui.requests.find(r=>r.options.method==='PUT');
  assert.deepEqual(JSON.parse(put.options.body),{animeId:'ani_2425',targetId:'ensemble'});
  assert.equal(ui.refreshes,1);assert.equal(ui.retries,1);assert.equal(ui.replacements.length,1);
  const retry=new URL(ui.replacements[0],'https://app.example');
  assert.equal(retry.pathname,'/watch/ani_2425/7');
  assert.equal(retry.searchParams.get('video_source'),'rean');
  assert.equal(retry.searchParams.get('creator'),'author');
  assert.equal(retry.searchParams.get('sub_url'),'https://blog.example/7');
  assert.equal(retry.searchParams.get('dub'),'1');
  assert.equal(retry.searchParams.get('source_ep'),'1');
  assert.equal(retry.searchParams.has('manual_source'),false);
});
test('detail page connection retains its existing save behavior without playback navigation',async()=>{
  const ui=workMatchControl({retryPlayback:false});
  let tree=await ui.init();
  treeElements(tree).find(e=>e.type==='input').props.onChange({target:{value:'Ensemble Contest'}});
  await treeElements(ui.render()).find(e=>e.type==='form').props.onSubmit({preventDefault(){}});
  const save=treeElements(ui.render()).find(e=>e.type==='button' && e.props.children==='이 작품으로 변경');
  await save.props.onClick();
  assert.equal(ui.refreshes,1);assert.equal(ui.retries,0);assert.deepEqual(ui.replacements,[]);
});
test('failed playback connection preserves administrator permissions and does not retry a failed save',async()=>{
  const readonly=workMatchControl({canEdit:false});
  const tree=await readonly.init();
  assert.ok(!treeElements(tree).some(e=>e.type==='form' || e.type==='button'));
  const ui=workMatchControl({saveOk:false});
  let editable=await ui.init();
  treeElements(editable).find(e=>e.type==='input').props.onChange({target:{value:'Ensemble Contest'}});
  await treeElements(ui.render()).find(e=>e.type==='form').props.onSubmit({preventDefault(){}});
  const save=treeElements(ui.render()).find(e=>e.type==='button' && e.props.children==='연결하고 다시 재생');
  await save.props.onClick();
  assert.equal(ui.refreshes,0);assert.equal(ui.retries,0);assert.deepEqual(ui.replacements,[]);
  assert.ok(treeElements(ui.render()).some(e=>e.props?.role==='status' && e.props.children==='save failed'));
});
