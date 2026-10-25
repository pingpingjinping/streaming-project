const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test'),ts=require('typescript');
const root=path.join(__dirname,'..');
function load(file,deps={}) {
  const exports={};
  const js=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  vm.runInNewContext(js,{exports,require:id=>id in deps?deps[id]:require(id),console,URL,URLSearchParams,AbortSignal,Date});
  return exports;
}
const id='re_you-re-under-arrest-tv-m29pp3', ak='ak_you-re-under-arrest-1996-4cefz';
function pref({selected=null,unavailable=true,candidates=[{animeId:ak,linkStatus:'multi_reviewed'}],linked='you-re-under-arrest-tv-m29pp3'}={}) {
  const calls=[];
  const choice=load('src/lib/workVideoSourcePreference.ts',{
    './db':{getWorkVideoSourceChoice:async(...args)=>{calls.push(['user',...args]);return selected;}},
    './localReanimeDetail':{getLocalReanimeDetail:async(...args)=>{calls.push(['local',...args]);return unavailable?{video_available:false}:null;}},
    './anikotoLinks':{getAnikotoPlaybackCandidates:async(...args)=>{calls.push(['candidates',...args]);return candidates;}},
    './reanimeMatches':{getConfirmedReanimeIdsForAnissia:async()=>new Map([[42,linked]])},
  });
  return {...choice,calls};
}
test('DB-confirmed metadata-only ReAnime enters the single Anikoto listing with no upstream calls',async()=>{
  const x=pref();
  assert.equal(await x.resolveWorkVideoSource('alice',id),'anikoto');
  assert.deepEqual(x.calls.map(a=>a[0]),['user','local','candidates']);
  assert.equal(x.calls[1][2],true);
  assert.equal(await x.getDbBackedWorkVideoSource('ani_42'),'anikoto');
});
test('Explicit work/account selection always wins including ReAnime exception',async()=>{
  for(const selected of ['rean','anikoto','linkkf','ohli24']) {
    const x=pref({selected});
    assert.equal(await x.resolveWorkVideoSource('alice',id),selected);
    assert.equal(x.calls.length,1,'must not query provider when account preference is explicit');
  }
});
test('Unverified or ambiguous availability does not force Anikoto',async()=>{
  assert.equal(await pref({unavailable:false}).getDbBackedWorkVideoSource(id),null);
  assert.equal(await pref({candidates:[]}).getDbBackedWorkVideoSource(id),null);
  assert.equal(await pref({candidates:[{animeId:ak,linkStatus:'reviewed'},{animeId:'ak_other',linkStatus:'reviewed'}]}).getDbBackedWorkVideoSource(id),null);
  assert.equal(await pref({candidates:[{animeId:ak,linkStatus:'hold'}]}).getDbBackedWorkVideoSource(id),null);
  assert.equal(await pref({linked:''}).getDbBackedWorkVideoSource('ani_42'),null);
  assert.equal(await pref().getDbBackedWorkVideoSource('db_AniList_1372'),null);
});
test('No preference means the normal ReAnime default is implicit',async()=>{
  assert.equal(await pref({unavailable:false}).resolveWorkVideoSource('alice',id),undefined);
  assert.equal(await pref({unavailable:false}).resolveWorkVideoSource('bob','ani_42'),undefined);
});
test('Work and episode routing always consult preference before any provider details',()=>{
  for(const file of ['src/app/anime/[id]/page.tsx','src/app/watch/[id]/[ep]/page.tsx']) {
    const s=fs.readFileSync(path.join(root,file),'utf8');
    assert.match(s,/resolveWorkVideoSource\(user.username, id\)/);
    assert.ok(s.indexOf('resolveWorkVideoSource(user.username, id)')<s.indexOf('provider.getAnimeDetail(id,'),
      'explicit/account preferred source must reach provider on its first detail query');
    if (file.includes('/anime/')) {
      assert.match(s,/reviewedProviderPlayback\(anime, videoSource\)/,
        'account-selected Anikoto must be respected even if ReAnime claims a playable source');
      assert.doesNotMatch(s,/reviewedProviderPlayback\(anime, video_source\)/,
        'raw URL query is undefined when preference came from the account');
    }
  }
  const source=fs.readFileSync(path.join(root,'src/components/AnissiaVideoSourceSelect.tsx'),'utf8');
  assert.match(source,/\/api\/settings\/work-video-source/);
  assert.match(source,/event.preventDefault\(\)/);
  assert.match(source,/router.push\(href\)/);
});
test('Generic player settings writes preserve per-work source choices',()=>{
  const s=fs.readFileSync(path.join(root,'src/lib/db.ts'),'utf8');
  assert.match(s,/CASE WHEN user_settings.settings::jsonb \? 'workVideoSources'/);
  assert.match(s,/COALESCE\(user_settings.settings::jsonb -> 'workVideoSources'/);
  assert.match(s,/\{workVideoSources\}/);
});
test('Only source-button PUT persists, and ReAnime normally clears redundant overrides',async()=>{
  const writes=[],manual=[];
  const route=load('src/app/api/settings/work-video-source/route.ts',{
    '@/lib/auth':{getSessionUser:async()=>({username:'alice'})},
    '@/lib/db':{saveWorkVideoSourceChoice:async(...args)=>{writes.push(args);return true;},
      validWorkVideoSource:v=>['rean','anikoto','linkkf','ohli24'].includes(v),
      validWorkVideoSourceId:v=>typeof v==='string'&&(v.startsWith('ani_')||v.startsWith('re_'))},
    '@/lib/workVideoSourcePreference':{getDbBackedWorkVideoSource:async id=>{manual.push(id);return manual.length===1?'anikoto':null;}},
    'next/server':{NextResponse:{json:(data,opt={})=>({data,status:opt.status??200,headers:opt.headers})}},
  });
  const req=(animeId,source)=>({json:async()=>({animeId,source})});
  let response=await route.PUT(req(id,'rean'));
  assert.equal(response.data.choice,'rean');
  response=await route.PUT(req(id,'rean'));
  assert.equal(response.data.choice,null);
  response=await route.PUT(req(id,'anikoto'));
  assert.equal(response.data.choice,'anikoto');
  assert.deepEqual(writes.map(x=>x[2]),['rean',null,'anikoto']);
  assert.equal(manual.length,2,'non-ReAnime explicit choices must not query availability');
});
