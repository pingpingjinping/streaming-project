const ts=require('typescript'),Module=require('node:module'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto'),assert=require('node:assert/strict'),{test,after}=require('node:test');
const originalResolve=Module._resolveFilename;
Module._resolveFilename=function(id,...args){return originalResolve.call(this,id.startsWith('@/')?path.join(__dirname,'../src',id.slice(2)):id,...args);};
const compilerOptions={module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions}).outputText,file);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtitle-overrides-'));process.env.SUBTITLE_STORAGE_DIR=root;delete process.env.DATABASE_URL;
const AdmZip=require('adm-zip'),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const srt=text=>Buffer.from(`1\n00:00:01,000 --> 00:00:03,000\n${text}\n`);
function put(relative,bytes){const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;}
function zipFile(relative,files){const zip=new AdmZip();for(const[name,bytes]of Object.entries(files))zip.addFile(name,bytes);const bytes=zip.toBuffer();put(relative,bytes);return bytes;}
zipFile('anissia_subtitles/101__작품 A/1화/제작자/subtitle.zip',{'01ns.srt':srt('A one ns'),'01s.srt':srt('A one sponsor')});
zipFile('anissia_subtitles/101__작품 A/2화/제작자/subtitle.zip',{'02ns.srt':srt('A two ns'),'02s.srt':srt('A two sponsor')});
zipFile('anissia_subtitles/102__작품 B/1화/제작자/subtitle.zip',{'01ns.srt':srt('B one ns')});
const mixedBytes=zipFile('aniall_subtitles/혼합 작품/all.zip',{'TV/S01E01.srt':srt('TV one'),'TV/S01E02.srt':srt('TV two'),
  'OVA/01.srt':srt('OVA one'),'bonus.ass':Buffer.from('[Script Info]\nTitle: unnumbered bonus')});
zipFile('aniall_subtitles/버전 작품/all.zip',{'01.srt':srt('version one'),'01ns.srt':srt('version two')});
const registryBytes=zipFile('aniall_subtitles/registry.zip',{'TV/01.srt':srt('reviewed TV'),'OVA/01.srt':srt('reviewed OVA'),'bonus.ass':Buffer.from('[Script Info]\nTitle: unnumbered')});
for(const ep of [1,2,3]) {
  put(`anissia_subtitles/풀린 작품/${String(ep).padStart(2,'0')}.srt`,srt(`flat base ${ep}`));
  put(`anissia_subtitles/풀린 작품/${String(ep).padStart(2,'0')}__2.srt`,srt(`flat variant two ${ep}`));
}
put('anissia_subtitles/풀린 작품/04.srt',srt('flat base 4'));
put('anissia_subtitles/풀린 작품/OVA/01.srt',srt('flat OVA'));
put('anissia_subtitles/풀린 작품/S02/01.srt',srt('flat season two'));
put('anissia_subtitles/풀린 작품/unknown.ass',Buffer.from('[Script Info]\nTitle: unknown'));
for(const ep of [1,2]) {
  put(`aniall_subtitles/풀린 애니올/TV/${String(ep).padStart(2,'0')}.srt`,srt(`aniall flat ${ep}`));
}
put('aniall_subtitles/풀린 애니올/OVA/01.srt',srt('aniall flat OVA'));
for(const provider of ['anissia','aniall']) put(`${provider}_subtitles/평면 작품 S02/01.srt`,srt(`${provider} flat season two`));
zipFile('aniall_subtitles/복수 ZIP/all.zip',Object.fromEntries([1,2,3].flatMap(ep=>[[`${String(ep).padStart(2,'0')}.srt`,srt(`zip base ${ep}`)],[`${String(ep).padStart(2,'0')}__2.srt`,srt(`zip variant two ${ep}`)]])));
for(const ep of Array.from({length:12},(_,i)=>i+1)) {
  for(const provider of ['anissia','aniall']) for(const suffix of ['','__2'])
    put(`${provider}_subtitles/연속 작품/${String(ep).padStart(2,'0')}${suffix}.srt`,srt(`${provider} series${suffix} episode ${ep}`));
}
for(const provider of ['anissia','aniall']) {
  for(const ep of [15,16,17]) {
    put(`${provider}_subtitles/완성 상태 ${provider}/${ep}화${ep===16?' 미완성':''}.srt`,srt(`${provider} completion ${ep}`));
    zipFile(`${provider}_subtitles/완성 ZIP ${provider}/${provider==='anissia'?`${ep}화/제작자/`:''}${ep}화${ep===16?' 미완성':''}.zip`,
      {[`${ep}화${ep===16?' (미완성)':''}.srt`]:srt(`${provider} ZIP completion ${ep}`)});
  }
  for(const suffix of ['',' 미완성'])
    put(`${provider}_subtitles/완성 중복 ${provider}/16화${suffix}.srt`,srt(`${provider} duplicate ${suffix||'complete'}`));
  for(const ep of [15,16]) for(const variant of ['ns','s','__2'])
    put(`${provider}_subtitles/완성 구분 ${provider}/${ep}화${variant}${ep===16?' [미완성]':''}.srt`,srt(`${provider} variant ${variant} ${ep}`));
  for(const ep of [15,16])
    put(`${provider}_subtitles/미완성 제목 ${provider}/미완성의 작품 ${ep}화.srt`,srt(`${provider} title ${ep}`));
}
const db=require('../src/lib/db.ts'),auth=require('../src/lib/auth.ts'),storage=require('../src/lib/subtitleStorage.ts');
const reviewed=require('../src/lib/reviewedSubtitleStorage.ts'),titles=require('../src/lib/subtitles.ts'),matches=require('../src/lib/reanimeMatches.ts');
const identity=require('../src/lib/subtitleLocalIdentity.ts');
const {NextRequest}=require('next/server'),bundleRoute=require('../src/app/api/anime/subtitle-bundle/route.ts');
const exceptionRoute=require('../src/app/api/anime/subtitle-exceptions/route.ts'),automatic=require('../src/app/api/anime/subtitles/route.ts');
const native=require('../src/app/api/anime/subtitles/vtt/route.ts');
const patches=[];function patch(o,k,v){patches.push([o,k,o[k]]);o[k]=v;}
let username='alice';const assignments=new Map(),exceptions=new Map();let rows=[];
patch(auth,'getSessionUser',async()=>({username}));
patch(db,'getSubtitleBundleAssignment',async(u,a)=>assignments.get(`${u}:${a}`)||null);
patch(db,'getSubtitleBundleAssignments',async u=>[...assignments.entries()].filter(([k])=>k.startsWith(u+':')).map(([,v])=>v));
patch(db,'saveSubtitleBundleAssignment',async(u,a,provider,bundleKey,label)=>{
  for(const[k,v]of assignments)if(k.startsWith(u+':')&&v.provider===provider&&identity.bundleScopesOverlap(v.bundleKey,bundleKey))assignments.delete(k);
  assignments.set(`${u}:${a}`,{animeId:a,provider,bundleKey,label,exclusive:true});return true;
});
patch(db,'deleteSubtitleBundleAssignment',async(u,a)=>{assignments.delete(`${u}:${a}`);return true;});
patch(db,'getSubtitleEpisodeOverrides',async(u,a)=>exceptions.get(`${u}:${a}`)||[]);
patch(db,'saveSubtitleEpisodeOverride',async(u,a,v)=>{const key=`${u}:${a}`;exceptions.set(key,[...(exceptions.get(key)||[]).filter(e=>e.episodeNumber!==v.episodeNumber),v]);return true;});
patch(db,'deleteSubtitleEpisodeOverride',async(u,a,ep)=>{const key=`${u}:${a}`;exceptions.set(key,(exceptions.get(key)||[]).filter(e=>e.episodeNumber!==ep));return true;});
patch(db,'getSubtitleEpisodeStart',async()=>null);patch(db,'getSubtitleRejections',async()=>[]);patch(db,'getSubtitleSourcePriority',async()=>'aniall');
patch(db,'getAniAllMatches',async()=>[]);patch(db,'getManualSubtitleLink',async()=>null);patch(matches,'getReanimeMatch',async()=>null);
patch(titles,'resolveKoreanTitle',async t=>t);patch(db,'getDb',()=>async(strings,...values)=>{
  const query=strings.join('?');
  if(query.includes('f.pid=?'))return rows.filter(r=>r.pid===values[1]);
  if(query.includes('f.pack_id=?'))return rows.filter(r=>r.source===values[1]&&r.pack_id===values[2]&&r.target_source===values[3]&&r.target_id===values[4]);
  return [];
});
patch(titles,'searchAllSubtitlesParallel',async()=>({subtitles:[],creators:[]}));
after(()=>{for(const[o,k,v]of patches.reverse())o[k]=v;fs.rmSync(root,{recursive:true,force:true});});
const request=(endpoint,method,body)=>new NextRequest(`http://localhost/api/anime/${endpoint}`,{method,body:body?JSON.stringify(body):undefined,headers:body?{'Content-Type':'application/json'}:undefined});
const play=async(id,title,ep=1)=>(await automatic.GET(request(`subtitles?animeId=${id}&title=${encodeURIComponent(title)}&ep=${ep}`,'GET'))).json();
const assign=async(id,provider,subtitle)=>(await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:id,provider,bundleKey:subtitle.sourceBundleKey,
  fileId:subtitle.reviewedFileId || subtitle.localFileId}))).json();
function registryRow(pid,member,title,target,confirmed=[]){return{pid,source:'aniall',pack_id:'registry',zip_relative_path:'aniall/registry.zip',member_path:member,
  sha256:digest(member==='bonus.ass'?Buffer.from('[Script Info]\nTitle: unnumbered'):srt(member.startsWith('TV')?'reviewed TV':'reviewed OVA')),
  archive_sha256:digest(registryBytes),work_title_ko:title,reanime_id:null,target_source:'AniList',target_id:target,content_extension:'.srt',confirmed_episodes:confirmed};}

test('same creator and generic ZIP names are scoped by work; assigned ns track follows episode two',async()=>{
  const a=await storage.getAnissiaArchiveSubtitles(['작품 A'],1,101),b=await storage.getAnissiaArchiveSubtitles(['작품 B'],1,102);
  assert.notEqual(a[0].sourceBundleKey,b[0].sourceBundleKey);
  const ns=a.find(s=>s.content.includes('A one ns'));assert.equal((await assign('re_a','anissia',ns)).success,true);
  const next=await play('re_a','작품 A',2);assert.equal(next.count,1);assert.equal(next.needs_manual_subtitle_choice,false);
  assert.ok(next.subtitles[0].content.includes('A two ns'));
  const other=await play('re_b','작품 B');assert.ok(other.subtitles[0].content.includes('B one ns'));
});
test('one physical TV+OVA ZIP has independent scopes and preserves original bytes',async()=>{
  const files=await storage.getAniAllArchiveSubtitles('혼합 작품',1,null,null,'',{manualSearch:true});
  const tv=files.find(s=>s.content.includes('TV one')),ova=files.find(s=>s.content.includes('OVA one'));
  assert.notEqual(tv.sourceBundleKey,ova.sourceBundleKey);
  assert.equal((await assign('re_tv','aniall',tv)).success,true);assert.equal((await assign('re_ova','aniall',ova)).success,true);
  const second=await play('re_tv','혼합 작품',2);assert.equal(second.count,1);assert.ok(second.subtitles[0].content.includes('TV two'));
  const special=await play('re_ova','혼합 작품 OVA');assert.equal(special.count,1);assert.ok(special.subtitles[0].content.includes('OVA one'));
  const hidden=await play('re_wrong_season','혼합 작품');assert.equal(hidden.subtitles?.some(s=>s.content.includes('TV one')),false);
  assert.deepEqual(fs.readFileSync(path.join(root,'aniall_subtitles/혼합 작품/all.zip')),mixedBytes);
});
test('different same-episode versions require a choice, even with a work assignment',async()=>{
  const result=await play('re_versions','버전 작품');assert.equal(result.count,2);assert.equal(result.needs_manual_subtitle_choice,true);
  const files=await storage.getAniAllArchiveSubtitles('버전 작품',1);await assign('re_versions','aniall',files[0]);
  // One selected release track can be applied; other tracks are never chosen arbitrarily.
  const assigned=await play('re_versions','버전 작품');assert.equal(assigned.count,1);assert.ok(assigned.subtitles[0].content.includes('version one'));
});
test('trailing completion status preserves the selected track across loose files and ZIPs',async()=>{
  for(const provider of ['anissia','aniall']) for(const layout of ['완성 상태','완성 ZIP']) {
    const title=`${layout} ${provider}`,id=`re_completion_${provider}_${layout}`;
    const files=provider==='anissia' ? await storage.getAnissiaArchiveSubtitles([title],15)
      : await storage.getAniAllArchiveSubtitles(title,15);
    assert.equal(files.length,1,`${provider} ${layout}`);assert.equal((await assign(id,provider,files[0])).success,true);
    const incomplete=await play(id,title,16);
    assert.equal(incomplete.count,1);assert.equal(incomplete.needs_manual_subtitle_choice,false);
    assert.equal(incomplete.subtitles[0].episodeConfirmed,true);
    assert.match(incomplete.subtitles[0].orig_filename,/미완성/);
    const complete=await play(id,title,17);
    assert.equal(complete.count,1);assert.equal(complete.needs_manual_subtitle_choice,false);
    assert.ok(complete.subtitles[0].content.includes('17'));
    assert.equal((await assign(id,provider,incomplete.subtitles[0])).success,true);
    assert.equal((await play(id,title,17)).count,1);
  }
});
test('complete and incomplete files for the same episode still require a choice',async()=>{
  for(const provider of ['anissia','aniall']) {
    const title=`완성 중복 ${provider}`,id=`re_completion_duplicate_${provider}`;
    const files=provider==='anissia' ? await storage.getAnissiaArchiveSubtitles([title],16)
      : await storage.getAniAllArchiveSubtitles(title,16);
    assert.equal(files.length,2);assert.equal(files[0].sourceBundleKey,files[1].sourceBundleKey);
    assert.notEqual(files[0].localFileId,files[1].localFileId);
    await assign(id,provider,files[0]);
    const result=await play(id,title,16);
    assert.equal(result.count,2);assert.equal(result.needs_manual_subtitle_choice,true);
  }
});
test('completion suffix normalization preserves sponsor, copy and title distinctions',async()=>{
  for(const provider of ['anissia','aniall']) {
    const title=`완성 구분 ${provider}`;
    const get=ep=>provider==='anissia' ? storage.getAnissiaArchiveSubtitles([title],ep)
      : storage.getAniAllArchiveSubtitles(title,ep);
    const first=await get(15),second=await get(16);
    assert.equal(first.length,3);assert.equal(second.length,3);
    assert.equal(new Set(second.map(s=>s.sourceBundleKey)).size,3);
    for(const variant of ['ns','s','__2']) {
      const initial=first.find(s=>s.orig_filename===`15화${variant}.srt`);
      const next=second.find(s=>s.orig_filename===`16화${variant} [미완성].srt`);
      assert.equal(next.sourceBundleKey,initial.sourceBundleKey);
    }
    const titled=provider==='anissia' ? await storage.getAnissiaArchiveSubtitles([`미완성 제목 ${provider}`],16)
      : await storage.getAniAllArchiveSubtitles(`미완성 제목 ${provider}`,16);
    assert.equal(titled.length,1);
    assert.match(identity.parseBundleScope(titled[0].sourceBundleKey).track,/미완성의작품/);
  }
});
test('previously saved incomplete tracks match while creator, source, season and kind stay scoped',async()=>{
  const title='완성 상태 anissia',files=await storage.getAnissiaArchiveSubtitles([title],16);
  const current=identity.parseBundleScope(files[0].sourceBundleKey);
  const oldTrack=current.track.split('|').map((part,index)=>index===1||index===2?part+'미완성':part).join('|');
  for(const type of ['folder','local']) {
    for(const [key,value]of assignments)if(identity.parseBundleScope(value.bundleKey)?.work===current.work)assignments.delete(key);
    const legacy=identity.bundleScopeKey({...current,type,track:oldTrack});
    const id=`re_legacy_completion_${type}`;
    assignments.set(`alice:${id}`,{animeId:id,provider:'anissia',bundleKey:legacy,label:'기존 미완성 선택',exclusive:true});
    const next=await play(id,title,17);assert.equal(next.count,1);assert.equal(next.needs_manual_subtitle_choice,false);
    for(const changed of [{season:2},{kind:'ova'},{work:'다른 작품'},{track:current.track.replace(/^로컬파일/,'다른제작자')},
      {track:current.track+'|source:anissia:999'}])
      assert.equal(identity.bundleMatchesAssignment(legacy,identity.bundleScopeKey({...current,...changed})),false);
  }
});
test('single unnumbered reviewed special remains manual after work-wide assignment',async()=>{
  const bonus=registryRow('bonus','bonus.ass','작품 특전','special-work');rows=[bonus];
  const subtitle=await reviewed.readReviewedFile(bonus);assert.equal((await assign('re_bonus','aniall',subtitle)).success,true);
  const result=await play('re_bonus','작품 특전',4);assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,true);
  assert.equal(result.subtitles[0].episodeConfirmed,false);
});
test('reviewed TV and OVA in the same pack stay within current work scopes',async()=>{
  const tv=registryRow('tv','TV/01.srt','검수 TV','tv-work',[1]),ova=registryRow('ova','OVA/01.srt','검수 OVA','ova-work',[1]);rows=[tv,ova];
  const tvSub=await reviewed.readReviewedFile(tv),ovaSub=await reviewed.readReviewedFile(ova);
  await assign('re_reviewed_tv','aniall',tvSub);await assign('re_reviewed_ova','aniall',ovaSub);
  const before=JSON.stringify(rows);
  assert.equal((await play('re_reviewed_tv','검수 TV')).subtitles[0].reviewedFileId,'reviewed_v6_1109:tv');
  assert.equal((await play('re_reviewed_ova','검수 OVA')).subtitles[0].reviewedFileId,'reviewed_v6_1109:ova');
  assert.equal(JSON.stringify(rows),before);
});
test('episode exception overrides the bundle only on its target episode, persists and can be removed',async()=>{
  rows=[];const files=await storage.getAniAllArchiveSubtitles('혼합 작품',1,null,null,'',{manualSearch:true});
  const ova=files.find(s=>s.content.includes('OVA one'));
  const response=await exceptionRoute.PUT(request('subtitle-exceptions','PUT',{animeId:'re_tv',episodeNumber:2,provider:'aniall',fileId:ova.localFileId}));
  assert.equal(response.status,200);
  assert.equal((await (await exceptionRoute.GET(request('subtitle-exceptions?animeId=re_tv','GET'))).json()).exceptions.length,1);
  const current=await play('re_tv','혼합 작품',2);assert.equal(current.subtitles[0].episodeException,true);assert.ok(current.subtitles[0].content.includes('OVA one'));
  assert.ok((await play('re_tv','혼합 작품',1)).subtitles[0].content.includes('TV one'));
  assert.equal((await exceptionRoute.DELETE(request('subtitle-exceptions?animeId=re_tv&ep=2','DELETE'))).status,200);
  assert.ok((await play('re_tv','혼합 작품',2)).subtitles[0].content.includes('TV two'));
});
test('missing bundle or changed exception blocks web/cache fallback and reports the missing file',async()=>{
  let webRequests=0;patch(titles,'searchAllSubtitlesParallel',async()=>{webRequests++;return{subtitles:[],creators:[]};});
  const missing=await play('re_tv','혼합 작품',13);assert.equal(missing.assignment_missing,true);assert.equal(missing.count,0);assert.match(missing.subtitle_notice,/이 회차/);
  const files=await storage.getAniAllArchiveSubtitles('혼합 작품',1,null,null,'',{manualSearch:true});const ova=files.find(s=>s.content.includes('OVA one'));
  await exceptionRoute.PUT(request('subtitle-exceptions','PUT',{animeId:'re_tv',episodeNumber:3,provider:'aniall',fileId:ova.localFileId}));
  zipFile('aniall_subtitles/혼합 작품/all.zip',{'OVA/01.srt':srt('changed')});
  const changed=await play('re_tv','혼합 작품',3);assert.equal(changed.assignment_missing,true);assert.match(changed.subtitle_notice,/변경/);assert.equal(webRequests,0);
  put('aniall_subtitles/혼합 작품/all.zip',mixedBytes);
});
test('exception API rejects unsafe IDs and native VTT reads the saved exact override',async()=>{
  assert.equal((await exceptionRoute.PUT(request('subtitle-exceptions','PUT',{animeId:'re_tv',episodeNumber:0,provider:'aniall',fileId:'bad'}))).status,400);
  const forged=identity.localFileKey('../outside.ass','','a'.repeat(64));
  assert.equal(await storage.getLocalSubtitleFile(forged),null);
  rows=[registryRow('ova','OVA/01.srt','검수 OVA','ova-work',[1])];
  const fileId='reviewed_v6_1109:ova';
  assert.equal((await exceptionRoute.PUT(request('subtitle-exceptions','PUT',{animeId:'re_crosswork',episodeNumber:5,provider:'aniall',fileId}))).status,200);
  const response=await native.GET(request(`subtitles/vtt?animeId=re_crosswork&ep=5&reviewedFileId=${fileId}`,'GET'));
  assert.equal(response.status,200);assert.ok((await response.text()).includes('reviewed OVA'));
});
test('assignments and exceptions belong to the signed-in user',async()=>{
  username='bob';
  assert.equal((await (await bundleRoute.GET(request('subtitle-bundle?animeId=re_tv','GET'))).json()).assignment,null);
  assert.equal((await (await exceptionRoute.GET(request('subtitle-exceptions?animeId=re_crosswork','GET'))).json()).exceptions.length,0);
  username='alice';
});

function loadSettingsDb(sql) {
  const exports={},vm=require('node:vm');
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/db.ts'),'utf8'),{compilerOptions}).outputText;
  vm.runInNewContext(code,{exports,require:id=>id==='postgres'?()=>sql:id==='./subtitleLocalIdentity'?identity:require(id),
    process:{env:{DATABASE_URL:'postgres://test'}},console,Buffer,setTimeout,clearTimeout});
  return exports;
}

test('concurrent cold DB requests wait for one complete initialization',async()=>{
  const counts=new Map();let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const sql=async(strings)=>{
    const query=strings.join('?').trim();
    counts.set(query,(counts.get(query)||0)+1);
    if(query.startsWith('CREATE TABLE IF NOT EXISTS anime_history'))await gate;
    return [];
  };
  const api=loadSettingsDb(sql);let completed=0;
  const requests=Array.from({length:5},()=>api.initDb().then(()=>{completed++;}));
  assert.equal(completed,0);
  assert.equal([...counts.values()].reduce((a,b)=>a+b,0),1);
  release();await Promise.all(requests);
  assert.equal(completed,5);
  const createCounts=[...counts].filter(([query])=>query.startsWith('CREATE TABLE'));
  assert.ok(createCounts.length>1);
  assert.ok(createCounts.every(([,count])=>count===1));
  const total=counts.size;await api.initDb();assert.equal(counts.size,total);
  assert.ok([...counts.values()].every(count=>count===1));
});

test('a failed shared DB initialization rejects all callers and permits a later retry',async()=>{
  const failure=Object.assign(new Error('temporary initialization failure'),{code:'XX000'});
  let fail=true,attempts=0;
  const sql=async(strings)=>{
    const query=strings.join('?').trim();
    if(query.startsWith('CREATE TABLE IF NOT EXISTS anime_history'))attempts++;
    if(query.startsWith('CREATE TABLE IF NOT EXISTS subtitle_episode_overrides')&&fail)throw failure;
    return [];
  };
  const api=loadSettingsDb(sql);
  const results=await Promise.allSettled([api.initDb(),api.initDb()]);
  assert.ok(results.every(result=>result.status==='rejected'&&result.reason===failure));
  assert.equal(attempts,1);
  fail=false;await api.initDb();assert.equal(attempts,2);
  await api.initDb();assert.equal(attempts,2);
});

test('Postgres persists scoped ownership and episode exceptions without modifying reviewed rows',
  {skip:!process.env.REVIEWED_TEST_DATABASE_URL},async()=>{
  const postgres=require('postgres'),vm=require('node:vm');
  const url=process.env.REVIEWED_TEST_DATABASE_URL,schema=`override_test_${process.pid}_${Date.now()}`;
  const admin=postgres(url,{max:1});let sql;
  const previous=db.getDb;
  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql=postgres(url,{max:5,connection:{search_path:schema}});db.getDb=()=>sql;
    await sql.unsafe(`CREATE TABLE anime_subtitle_archives(dataset_key text,pack_id text,sha256 text);
      CREATE TABLE anime_subtitle_files(dataset_key text,pid text,source text,pack_id text,zip_relative_path text,
        member_path text,sha256 text,work_title_ko text,reanime_id text,target_source text,target_id text,content_extension text,work_confirmed boolean);
      CREATE TABLE anime_subtitle_file_origins(dataset_key text,pid text,file_id text);
      CREATE TABLE anime_subtitle_confirmed_episodes(dataset_key text,file_id text,target_source text,target_id text,target_episode int,status text);`);
    await sql`INSERT INTO anime_subtitle_archives VALUES('reviewed_v6_1109','registry',${digest(registryBytes)})`;
    const tv=registryRow('pg-tv','TV/01.srt','검수 TV','tv',[1]),ova=registryRow('pg-ova','OVA/01.srt','검수 OVA','ova',[1]);
    for(const file of [tv,ova]) {
      await sql`INSERT INTO anime_subtitle_files VALUES('reviewed_v6_1109',${file.pid},'aniall','registry','aniall/registry.zip',
        ${file.member_path},${file.sha256},${file.work_title_ko},NULL,'AniList',${file.target_id},'.srt',true)`;
      await sql`INSERT INTO anime_subtitle_file_origins VALUES('reviewed_v6_1109',${file.pid},${file.pid})`;
      await sql`INSERT INTO anime_subtitle_confirmed_episodes VALUES('reviewed_v6_1109',${file.pid},'AniList',${file.target_id},1,'confirmed_episode')`;
    }
    await sql`INSERT INTO anime_subtitle_confirmed_episodes VALUES('reviewed_v6_1109','pg-tv','AniList','historical-other',12,'confirmed_episode')`;
    const snapshot=async()=>JSON.stringify([await sql`SELECT * FROM anime_subtitle_files ORDER BY pid`,await sql`SELECT * FROM anime_subtitle_confirmed_episodes ORDER BY file_id,target_id`]);
    const before=await snapshot();
    const tvKey=reviewed.reviewedBundleKey(tv),ovaKey=reviewed.reviewedBundleKey(ova);
    const scoped=await reviewed.findReviewedBundleFiles('aniall',tvKey);
    assert.deepEqual(scoped.map(r=>r.pid),['pg-tv']);assert.deepEqual(scoped[0].confirmed_episodes,[1]);
    assert.deepEqual((await reviewed.findReviewedBundleFiles('aniall',ovaKey)).map(r=>r.pid),['pg-ova']);
    // The production settings module uses a real isolated Postgres connection.
    const exports={},code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/db.ts'),'utf8'),{compilerOptions}).outputText;
    vm.runInNewContext(code,{exports,require:id=>id==='postgres'?()=>sql:id==='./subtitleLocalIdentity'?identity:require(id),process:{env:{DATABASE_URL:url}},console,Buffer,setTimeout,clearTimeout});
    await Promise.all([exports.getSubtitleEpisodeOverrides('alice','re_tv'),exports.getSubtitleEpisodeOverrides('bob','re_tv')]);
    assert.equal(await exports.saveSubtitleBundleAssignment('alice','re_tv','aniall',tvKey,'TV'),true);
    assert.equal(await exports.saveSubtitleBundleAssignment('alice','re_ova','aniall',ovaKey,'OVA'),true);
    assert.equal((await exports.getSubtitleBundleAssignments('alice')).length,2);
    await exports.saveSubtitleBundleAssignment('alice','re_new_tv','aniall',tvKey,'TV moved');
    assert.equal(await exports.getSubtitleBundleAssignment('alice','re_tv'),null);
    assert.equal((await exports.getSubtitleBundleAssignment('alice','re_ova')).bundleKey,ovaKey);
    await exports.saveSubtitleBundleAssignment('bob','re_tv','aniall',tvKey,'Independent user');
    assert.equal((await exports.getSubtitleBundleAssignments('bob')).length,1);
    assert.equal(await exports.saveSubtitleEpisodeOverride('alice','re_new_tv',{episodeNumber:4,provider:'aniall',fileId:'reviewed_v6_1109:pg-ova',label:'OVA exception'}),true);
    assert.equal((await exports.getSubtitleEpisodeOverrides('alice','re_new_tv'))[0].episodeNumber,4);
    assert.equal((await exports.getSubtitleEpisodeOverrides('bob','re_new_tv')).length,0);
    await exports.deleteSubtitleEpisodeOverride('alice','re_new_tv',4);
    assert.equal((await exports.getSubtitleEpisodeOverrides('alice','re_new_tv')).length,0);
    await exports.deleteSubtitleBundleAssignment('alice','re_new_tv');
    const localKey=identity.bundleScopeKey({type:'local',provider:'anissia',work:'풀린 작품',track:'base',kind:'main',season:1});
    const folderKey=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'풀린 작품',kind:'main',season:1});
    const folderVariant=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'풀린 작품',track:'variant-two',kind:'main',season:1});
    const folderOva=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'풀린 작품',kind:'ova',season:1});
    const folderSeason=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'풀린 작품',kind:'main',season:2});
    for(const [anime,key] of [['old-track',localKey],['folder-ova',folderOva],['folder-season',folderSeason]])
      assert.equal(await exports.saveSubtitleBundleAssignment('alice',anime,'anissia',key,anime),true);
    await exports.saveSubtitleBundleAssignment('bob','bob-track','anissia',localKey,'Bob');
    assert.equal(await exports.saveSubtitleBundleAssignment('alice','new-folder','anissia',folderKey,'Folder'),true);
    assert.equal(await exports.getSubtitleBundleAssignment('alice','old-track'),null);
    assert.equal(await exports.saveSubtitleBundleAssignment('alice','new-folder','anissia',folderVariant,'Variant two'),true);
    assert.equal((await exports.getSubtitleBundleAssignment('alice','new-folder')).bundleKey,folderVariant);
    assert.equal((await exports.getSubtitleBundleAssignment('alice','folder-ova')).bundleKey,folderOva);
    assert.equal((await exports.getSubtitleBundleAssignment('alice','folder-season')).bundleKey,folderSeason);
    assert.equal((await exports.getSubtitleBundleAssignment('bob','bob-track')).bundleKey,localKey);
    assert.equal(await snapshot(),before);
  } finally {
    db.getDb=previous;if(sql) await sql.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});

test('folder can be assigned without a file; unpacked numbered members follow successive episodes',async()=>{
  rows=[];
  const key=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'풀린 작품',kind:'main',season:1});
  const response=await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:'re_flat',provider:'anissia',bundleKey:key}));
  assert.equal(response.status,200);
  for(const ep of [1,2,3]) {
    const result=await play('re_flat','다른 번역명',ep);
    assert.equal(result.count,2);assert.equal(result.needs_manual_subtitle_choice,true);
    assert.ok(result.subtitles.every(s=>s.content.includes(` ${ep}`)));
  }
  const folderChoices=await storage.searchLocalSubtitleFolders('풀린');
  assert.ok(folderChoices.some(f=>f.folderKey===key));
  assert.equal((await play('re_wrong_flat','풀린 작품',1)).count,0);
});
test('choosing 01 or 01__2 remembers that folder variant for 02 and 03',async()=>{
  const key=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'풀린 작품',kind:'main',season:1});
  const files=await storage.getAnissiaArchiveSubtitles(['풀린 작품'],1,null,null,{bundleKey:key});
  for(const text of ['flat base','flat variant two']) {
    const selected=files.find(s=>s.content.includes(text));
    assert.ok(selected);assert.equal((await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:'re_flat',provider:'anissia',bundleKey:key,fileId:selected.localFileId}))).status,200);
    assert.equal(identity.parseBundleScope(assignments.get('alice:re_flat').bundleKey).type,'folder');
    for(const ep of [2,3]) {
      const result=await play('re_flat','다른 제목',ep);assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,false);
      assert.ok(result.subtitles[0].content.includes(`${text} ${ep}`));
    }
    const next=await play('re_flat','다른 제목',4);
    if(text==='flat base')assert.ok(next.subtitles[0].content.includes('flat base 4'));
    else {assert.equal(next.assignment_missing,true);assert.equal(next.count,0);}
    assert.equal((await play('re_flat','다른 제목',5)).assignment_missing,true);
  }
});
test('folder scope separates OVA and season two, supports nested AniAll, and per-episode exceptions still win',async()=>{
  const folder=(provider,work,kind='main',season=1)=>identity.bundleScopeKey({type:'folder',provider,work,kind,season});
  for(const [id,provider,work,kind,season,text] of [
    ['re_flat_ova','anissia','풀린 작품','ova',1,'flat OVA'],
    ['re_flat_s2','anissia','풀린 작품','main',2,'flat season two'],
    ['re_aniall_folder','aniall','풀린 애니올','main',1,'aniall flat 1'],
    ['re_aniall_ova','aniall','풀린 애니올','ova',1,'aniall flat OVA'],
  ]) {
    assert.equal((await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:id,provider,bundleKey:folder(provider,work,kind,season)}))).status,200);
    const result=await play(id,'새 번역명');assert.equal(result.count,1);assert.ok(result.subtitles[0].content.includes(text));
  }
  assert.ok((await play('re_aniall_folder','새 번역명',2)).subtitles[0].content.includes('aniall flat 2'));
  const files=await storage.getAnissiaArchiveSubtitles(['풀린 작품'],1,null,null,{bundleKey:folder('anissia','풀린 작품','ova')});
  const chosen=files[0];
  await exceptionRoute.PUT(request('subtitle-exceptions','PUT',{animeId:'re_flat',episodeNumber:2,provider:'anissia',fileId:chosen.localFileId}));
  assert.ok((await play('re_flat','새 제목',2)).subtitles[0].content.includes('flat OVA'));
  await exceptionRoute.DELETE(request('subtitle-exceptions?animeId=re_flat&ep=2','DELETE'));
  assert.ok((await play('re_flat','새 제목',2)).subtitles[0].content.includes('flat variant two 2'));
});
test('folder API rejects path escape, foreign provider, missing folder and a file from another folder',async()=>{
  for(const work of ['../풀린 작품','/풀린 작품','없는 폴더']) {
    const response=await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:'re_bad_folder',provider:'anissia',bundleKey:identity.bundleScopeKey({type:'folder',provider:'anissia',work,kind:'main',season:1})}));
    assert.ok([400,409].includes(response.status));
  }
  const key=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'풀린 작품',kind:'main',season:1});
  const other=(await storage.getAnissiaArchiveSubtitles(['작품 B'],1,102))[0];
  assert.equal((await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:'re_bad_folder',provider:'anissia',bundleKey:key,fileId:other.localFileId}))).status,409);
});

test('flat season-two folder uses its declared season without requiring S02 on every file',async()=>{
  for(const provider of ['anissia','aniall']) {
    const key=identity.bundleScopeKey({type:'folder',provider,work:'평면 작품 S02',kind:'main',season:2});
    const saved=await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:`flat-season-${provider}`,provider,bundleKey:key}));
    assert.equal(saved.status,200);
    const result=await play(`flat-season-${provider}`,'다른 이름',1);
    assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,false);
    assert.ok(result.subtitles[0].content.includes(`${provider} flat season two`));
  }
});

test('folder variant preference also follows __2 members inside an AniAll ZIP',async()=>{
  const key=identity.bundleScopeKey({type:'folder',provider:'aniall',work:'복수 ZIP',kind:'main',season:1});
  const files=await storage.getAniAllArchiveSubtitles('복수 ZIP',1,null,null,'',{bundleKey:key});
  assert.equal(files.length,2);
  assert.equal(identity.bundleSelectionMatches(key,files[0].sourceBundleKey),false);
  for(const variant of ['zip base','zip variant two']) {
    const chosen=files.find(file=>file.content.includes(variant));assert.ok(chosen);
    assert.equal((await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:'re_zip_folder',provider:'aniall',bundleKey:key,fileId:chosen.localFileId}))).status,200);
    assert.equal(identity.bundleSelectionMatches(assignments.get('alice:re_zip_folder').bundleKey,chosen.sourceBundleKey),true);
    for(const ep of [2,3]) {
      const result=await play('re_zip_folder','다른 이름',ep);assert.equal(result.count,1);
      assert.ok(result.subtitles[0].content.includes(`${variant} ${ep}`));
    }
  }
});

test('current-episode recommendations contain only the requested folder episode after choosing a variant',async()=>{
  const local=require('../src/app/api/anime/subtitles/local/route.ts');
  for(const provider of ['anissia','aniall']) {
    const key=identity.bundleScopeKey({type:'folder',provider,work:'연속 작품',kind:'main',season:1});
    const files=provider==='anissia'
      ? await storage.getAnissiaArchiveSubtitles(['연속 작품'],1,null,null,{bundleKey:key})
      : await storage.getAniAllArchiveSubtitles('연속 작품',1,null,null,'',{bundleKey:key});
    const chosen=files.find(file=>file.content.includes('series__2'));assert.ok(chosen);
    await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:`re_recs_${provider}`,provider,bundleKey:key,fileId:chosen.localFileId}));
    const data=await (await local.GET(request(`subtitles/local?animeId=re_recs_${provider}&title=${encodeURIComponent('다른 이름')}&ep=2`,'GET'))).json();
    assert.equal(data.success,true);assert.equal(data.count,1);
    assert.ok(data.subtitles[0].content.includes('series__2 episode 2'));
    assert.equal(data.subtitles[0].episodeConfirmed,true);
  }
});

test('one first-episode choice follows 1 through 12 without asking again for either folder variant',async()=>{
  for(const provider of ['anissia','aniall']) for(const suffix of ['','__2']) {
    const key=identity.bundleScopeKey({type:'folder',provider,work:'연속 작품',kind:'main',season:1});
    const first=provider==='anissia'
      ? await storage.getAnissiaArchiveSubtitles(['연속 작품'],1,null,null,{bundleKey:key})
      : await storage.getAniAllArchiveSubtitles('연속 작품',1,null,null,'',{bundleKey:key});
    const file=first.find(s=>s.content.includes(`series${suffix} episode 1`));assert.ok(file);
    const animeId=`re_continue_${provider}`;
    const saved=await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId,provider,bundleKey:key,fileId:file.localFileId}));
    assert.equal(saved.status,200);
    for(let ep=1;ep<=12;ep++) {
      const data=await play(animeId,'다른 번역명',ep);
      assert.equal(data.count,1);assert.equal(data.needs_manual_subtitle_choice,false);
      assert.ok(data.subtitles[0].content.includes(`series${suffix} episode ${ep}\n`));
    }
    assert.equal((await play(animeId,'다른 번역명',13)).assignment_missing,true);
  }
});
test('recommendations exclude other episodes while explicit search still permits episode exceptions',async()=>{
  const local=require('../src/app/api/anime/subtitles/local/route.ts');
  username='recommend-unassigned';
  try {
    const endpoint=`subtitles/local?animeId=re_unassigned_series&title=${encodeURIComponent('연속 작품')}&ep=2`;
    const normal=await (await local.GET(request(endpoint,'GET'))).json();
    assert.equal(normal.success,true);assert.equal(normal.count,4);
    assert.ok(normal.subtitles.every(s=>s.episodeConfirmed && s.content.includes('episode 2\n')));
    const search=await (await local.GET(request(endpoint+'&mode=search','GET'))).json();
    assert.equal(search.success,true);
    assert.ok(search.subtitles.some(s=>!s.episodeConfirmed && s.content.includes('episode 1\n')));
  }finally{username='alice';}
});
