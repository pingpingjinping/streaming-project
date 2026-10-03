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
  for(const[k,v]of assignments)if(k.startsWith(u+':')&&v.provider===provider&&v.bundleKey===bundleKey)assignments.delete(k);
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
    vm.runInNewContext(code,{exports,require:id=>id==='postgres'?()=>sql:require(id),process:{env:{DATABASE_URL:url}},console,Buffer,setTimeout,clearTimeout});
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
    assert.equal(await snapshot(),before);
  } finally {
    db.getDb=previous;if(sql) await sql.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
