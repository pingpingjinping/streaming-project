const ts=require('typescript'),Module=require('node:module'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto'),assert=require('node:assert/strict'),{test,after}=require('node:test');
const originalResolve=Module._resolveFilename;
Module._resolveFilename=function(id,...args){return originalResolve.call(this,id.startsWith('@/')?path.join(__dirname,'../src',id.slice(2)):id,...args);};
const compilerOptions={module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions}).outputText,file);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'subtitle-overrides-'));process.env.SUBTITLE_STORAGE_DIR=root;delete process.env.DATABASE_URL;
const AdmZip=require('adm-zip'),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const srt=text=>Buffer.from(`1\n00:00:01,000 --> 00:00:03,000\n${text}\n`);
const ass=text=>Buffer.from(`[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,${text}\n`);
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
for(const provider of ['anissia','aniall']) for(const layout of ['folder','zip']) {
  const title=`번호 표기 ${provider} ${layout}`;
  const files=Object.fromEntries([1,2,10].flatMap(ep=>[
    [`${String(ep).padStart(2,'0')}.srt`,srt(`bare release ${ep}`)],
    [`s1${String(ep).padStart(2,'0')}.srt`,srt(`compact release ${ep}`)],
    [`${ep}화.srt`,srt(`Korean release ${ep}`)],
  ]));
  if(layout==='zip')zipFile(`${provider}_subtitles/${title}/all.zip`,files);
  else for(const[name,bytes]of Object.entries(files))put(`${provider}_subtitles/${title}/${name}`,bytes);
}
const migrationSources={version:1,files:{}};
function weeklyFile(relative,provider,id,creator,episode,bytes) {
  put(relative,bytes);
  migrationSources.files[relative]={sha256:digest(bytes),sources:[{source:provider,id:String(id),title:relative.split('/')[1],
    creator,episode:String(episode),source_url:''}]};
}
for(const provider of ['anissia','aniall']) {
  for(const layout of ['혼합 경로','혼합 ZIP']) {
    const title=`${layout} ${provider}`,extension=layout==='혼합 ZIP'?'zip':'ass';
    const bytes=(ep,text)=>{const content=ass(text);if(extension==='ass')return content;
      const zip=new AdmZip();zip.addFile(`혼즈키4 ${ep}화.ass`,content);return zip.toBuffer();};
    put(`${provider}_subtitles/${title}/혼즈키4 9화.${extension}`,bytes(9,`${provider} legacy nine`));
    for(const ep of [24,25]) weeklyFile(`${provider}_subtitles/${title}/${ep}화/카이란/혼즈키4 ${ep}화.${extension}`,
      provider,700,'카이란',ep,bytes(ep,`${provider} weekly ${ep}`));
    weeklyFile(`${provider}_subtitles/${title}/26화/다른제작자/혼즈키4 26화.${extension}`,provider,700,'다른제작자',26,bytes(26,`${provider} other creator`));
    weeklyFile(`${provider}_subtitles/${title}/27화/카이란/혼즈키4 27화.${extension}`,provider,701,'카이란',27,bytes(27,`${provider} other source`));
  }
  const duplicate=`새 출처 중복 ${provider}`;
  put(`${provider}_subtitles/${duplicate}/혼즈키4 9화.ass`,ass(`${provider} duplicate legacy`));
  for(const creator of ['카이란','다른제작자']) weeklyFile(`${provider}_subtitles/${duplicate}/24화/${creator}/혼즈키4 24화.ass`,
    provider,creator==='카이란'?710:711,creator,24,ass(`${provider} duplicate ${creator}`));
}
put('anissia_subtitles/파일별 제작자/finish.txt',JSON.stringify({subject:'파일별 제작자',name:'마지막 다운로드 제작자'}));
for(const ep of [9,24])weeklyFile(`anissia_subtitles/파일별 제작자/혼즈키4 ${ep}화.ass`,'anissia',720,ep===9?'카이란':'다른제작자',ep,ass(`registered creator ${ep}`));
put('anissia_subtitles/동일 내용 복수 출처/혼즈키4 9화.ass',ass('identical provenance legacy'));
for(const creator of ['카이란','다른제작자'])weeklyFile(`anissia_subtitles/동일 내용 복수 출처/24화/${creator}/혼즈키4 24화.ass`,
  'anissia',creator==='카이란'?730:731,creator,24,ass('identical duplicated content'));
put('.weekly-subtitle-sources.json',JSON.stringify(migrationSources));
for(const provider of ['anissia','aniall']) for(const layout of ['folder','zip']) {
  const title=`하느님의 메모장 ${provider} ${layout}`;
  const files=Object.fromEntries([1,10,11,12].flatMap(ep=>[
    [`하느님의 메모장 page ${String(ep).padStart(2,'0')}${ep===10?'화':''}.srt`,srt(`page base ${ep}`)],
    [`하느님의 메모장 page ${String(ep).padStart(2,'0')} NS.srt`,srt(`page NS ${ep}`)],
  ]));
  if(layout==='zip')zipFile(`${provider}_subtitles/${title}/all.zip`,files);
  else for(const[name,bytes]of Object.entries(files))put(`${provider}_subtitles/${title}/${name}`,bytes);
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
patch(db,'saveSubtitleBundleAssignment',async(u,a,provider,bundleKey,label,expectedBundleKey,automatic=false)=>{
  if(expectedBundleKey!==undefined && (assignments.get(`${u}:${a}`)?.bundleKey || '')!==expectedBundleKey)return false;
  if(automatic && [...assignments.values()].some(v=>v.animeId!==a && v.provider===provider && identity.bundleScopesOverlap(v.bundleKey,bundleKey)))return false;
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
test('page-numbered ordinary and spaced NS tracks follow later episodes in folders and ZIPs',async()=>{
  for(const provider of ['anissia','aniall']) for(const layout of ['folder','zip']) {
    const title=`하느님의 메모장 ${provider} ${layout}`,id=`re_page_${provider}_${layout}`;
    const folder=identity.bundleScopeKey({type:'folder',provider,work:title,kind:'main',season:1});
    const first=provider==='anissia'
      ?await storage.getAnissiaArchiveSubtitles([title],1,null,1,{bundleKey:folder})
      :await storage.getAniAllArchiveSubtitles(title,1,1,null,'',{bundleKey:folder});
    assert.equal(first.length,2);
    const base=first.find(s=>s.content.includes('page base 1'));
    const ns=first.find(s=>s.content.includes('page NS 1'));
    assert.notEqual(base.sourceBundleKey,ns.sourceBundleKey);
    if(provider==='anissia')assert.equal(ns.localArchiveTrackLabel,'논스폰서판');
    for(const [selected,variant]of [[base,'base'],[ns,'NS']]) {
      assert.equal((await assign(id,provider,selected)).success,true);
      for(const ep of [10,11,12]) {
        const next=await play(id,title,ep);
        assert.equal(next.count,1);assert.equal(next.needs_manual_subtitle_choice,false);
        assert.ok(next.subtitles[0].content.includes(`page ${variant} ${ep}`));
        assert.equal(next.subtitles[0].sourceBundleKey,selected.sourceBundleKey);
      }
    }
    const current=identity.parseBundleScope(ns.sourceBundleKey);
    const legacy=identity.bundleScopeKey({...current,track:current.track.replaceAll('pageepns','page11ns')});
    assignments.set(`alice:${id}`,{animeId:id,provider,bundleKey:legacy,label:'기존 11화 NS 선택',exclusive:true});
    const resumed=await play(id,title,12);
    assert.equal(resumed.count,1);assert.ok(resumed.subtitles[0].content.includes('page NS 12'));
    assert.equal(resumed.bundle_assignment.bundleKey,ns.sourceBundleKey);
  }
});
test('saved page 11 NS and page 10화 tracks remain compatible without crossing variants or work scopes',()=>{
  const scope={type:'local',provider:'anissia',work:'하느님의 메모장',kind:'main',season:1,
    track:'로컬파일|하느님의메모장pageepns|하느님의메모장pageepns'};
  const current=identity.bundleScopeKey(scope);
  const legacy=identity.bundleScopeKey({...scope,track:'로컬파일|하느님의메모장page11ns|하느님의메모장page11ns'});
  assert.equal(identity.bundleMatchesAssignment(legacy,current),true);
  assert.equal(identity.refineLocalBundleAssignment(legacy,current),current);
  const ordinary=identity.bundleScopeKey({...scope,track:'로컬파일|하느님의메모장pageep|하느님의메모장pageep'});
  const oldOrdinary=identity.bundleScopeKey({...scope,track:'로컬파일|하느님의메모장pageep화|하느님의메모장pageep화'});
  assert.equal(identity.bundleMatchesAssignment(oldOrdinary,ordinary),true);
  for(const changed of [
    {track:'로컬파일|하느님의메모장pageep|하느님의메모장pageep'},
    {track:'로컬파일|하느님의메모장pageeps|하느님의메모장pageeps'},
    {track:'로컬파일|하느님의메모장pageepns__2|하느님의메모장pageepns__2'},
    {work:'다른 작품'}, {season:2}, {kind:'ova'}, {provider:'aniall'},
  ]) assert.equal(identity.bundleMatchesAssignment(legacy,identity.bundleScopeKey({...scope,...changed})),false);
  const recorded={...scope,track:'제작자|하느님의메모장pageepns|하느님의메모장pageepns|source:anissia:1'};
  const oldRecorded=identity.bundleScopeKey({...recorded,track:recorded.track.replaceAll('pageepns','page11ns')});
  for(const track of [recorded.track.replace('제작자','다른제작자'),recorded.track.replace('source:anissia:1','source:anissia:2')])
    assert.equal(identity.bundleMatchesAssignment(oldRecorded,identity.bundleScopeKey({...recorded,track})),false);
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
test('same-episode variants automatically choose one and manual selection replaces it',async()=>{
  const result=await play('re_versions','버전 작품');assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,false);
  assert.ok(assignments.get('alice:re_versions'));
  const files=await storage.getAniAllArchiveSubtitles('버전 작품',1);await assign('re_versions','aniall',files[0]);
  // A deliberate selection can replace the initial automatic release.
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
test('complete and incomplete versions of the same episode choose one automatically',async()=>{
  for(const provider of ['anissia','aniall']) {
    const title=`완성 중복 ${provider}`,id=`re_completion_duplicate_${provider}`;
    const files=provider==='anissia' ? await storage.getAnissiaArchiveSubtitles([title],16)
      : await storage.getAniAllArchiveSubtitles(title,16);
    assert.equal(files.length,2);assert.equal(files[0].sourceBundleKey,files[1].sourceBundleKey);
    assert.notEqual(files[0].localFileId,files[1].localFileId);
    await assign(id,provider,files[0]);
    const result=await play(id,title,16);
    assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,false);
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
    for(const changed of [{season:2},{kind:'ova'},{work:'다른 작품'}])
      assert.equal(identity.bundleMatchesAssignment(legacy,identity.bundleScopeKey({...current,...changed})),false);
  }
});
test('legacy flat ASS and ZIP selections follow registered nested episodes without reassigning the work',async()=>{
  for(const provider of ['anissia','aniall']) for(const layout of ['혼합 경로','혼합 ZIP']) for(const scopeType of ['folder','local']) {
    const title=`${layout} ${provider}`,id=`re_migration_${provider}_${layout}_${scopeType}`;
    for(const [key,value]of assignments)if(identity.parseBundleScope(value.bundleKey)?.work===title)assignments.delete(key);
    const files=provider==='anissia' ? await storage.getAnissiaArchiveSubtitles([title],9)
      : await storage.getAniAllArchiveSubtitles(title,9);
    assert.equal(files.length,1);
    const initial=files[0];
    const body={animeId:id,provider,bundleKey:scopeType==='folder'?initial.sourceFolderKey:initial.sourceBundleKey,fileId:initial.localFileId};
    assert.equal((await (await bundleRoute.PUT(request('subtitle-bundle','PUT',body))).json()).success,true);
    for(const ep of [24,25]) {
      const result=await play(id,title,ep);
      assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,false);
      assert.equal(result.subtitles[0].episodeConfirmed,true);assert.ok(result.subtitles[0].content.includes(`weekly ${ep}`));
      assert.match(result.subtitles[0].orig_filename,new RegExp(`${ep}화\\.ass$`));
    }
    const selected=(await play(id,title,24)).subtitles[0];
    const learned=identity.parseBundleScope(assignments.get(`alice:${id}`).bundleKey);
    assert.equal(learned.type,scopeType);assert.match(learned.track,/source:(?:anissia|aniall):700$/);
    if(provider==='anissia')assert.match(learned.track,/^카이란\|/);
    assert.equal((await play(id,title,27)).count,0);
    if(provider==='anissia')assert.equal((await play(id,title,26)).count,0);
    assert.equal((await assign(id,provider,selected)).success,true);
    const old=await play(id,title,9);assert.equal(old.count,1);assert.ok(old.subtitles[0].content.includes('legacy nine'));
    assert.match(identity.parseBundleScope(assignments.get(`alice:${id}`).bundleKey).track,/source:(?:anissia|aniall):700$/);
    const otherSource=await play(id,title,27);assert.equal(otherSource.count,0);assert.equal(otherSource.assignment_missing,true);
    if(provider==='anissia') {
      const otherCreator=await play(id,title,26);assert.equal(otherCreator.count,0);assert.equal(otherCreator.assignment_missing,true);
    }
  }
});
test('multiple compatible registered releases pick one and remember its creator',async()=>{
  for(const provider of ['anissia','aniall']) {
    const title=`새 출처 중복 ${provider}`,id=`re_migration_duplicates_${provider}`;
    const first=provider==='anissia'?await storage.getAnissiaArchiveSubtitles([title],9):await storage.getAniAllArchiveSubtitles(title,9);
    await assign(id,provider,first[0]);
    const savedBefore=assignments.get(`alice:${id}`).bundleKey;
    const result=await play(id,title,24);assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,false);
    assert.notEqual(assignments.get(`alice:${id}`).bundleKey,savedBefore);
    const selected=await play(id,title,24);assert.equal(selected.count,1);assert.equal(selected.needs_manual_subtitle_choice,false);
    assert.equal(selected.subtitles[0].sourceBundleKey,result.subtitles[0].sourceBundleKey);
  }
});
test('per-file source creators override a stale root marker and exact file resolution agrees',async()=>{
  const first=(await storage.getAnissiaArchiveSubtitles(['파일별 제작자'],9))[0];
  assert.equal(first.creator,'카이란');
  assert.equal((await storage.getLocalSubtitleFile(first.localFileId)).sourceBundleKey,first.sourceBundleKey);
  await assign('re_migration_file_creator','anissia',first);
  const next=await play('re_migration_file_creator','파일별 제작자',24);assert.equal(next.count,0);assert.equal(next.assignment_missing,true);
});
test('identical content from different sources does not teach an arbitrary source preference',async()=>{
  const title='동일 내용 복수 출처',id='re_migration_identical_sources';
  await assign(id,'anissia',(await storage.getAnissiaArchiveSubtitles([title],9))[0]);
  const before=assignments.get(`alice:${id}`).bundleKey;
  const result=await play(id,title,24);assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,false);
  assert.equal(assignments.get(`alice:${id}`).bundleKey,before);
});
test('a deferred metadata save does not block playback and a later unique episode can retry',async()=>{
  const title='혼합 경로 anissia',id='re_migration_deferred';
  for(const [key,value]of assignments)if(identity.parseBundleScope(value.bundleKey)?.work===title)assignments.delete(key);
  await assign(id,'anissia',(await storage.getAnissiaArchiveSubtitles([title],9))[0]);
  const before=assignments.get(`alice:${id}`).bundleKey,save=db.saveSubtitleBundleAssignment;
  try {
    db.saveSubtitleBundleAssignment=async()=>false;
    const result=await play(id,title,24);assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,false);
    assert.equal(assignments.get(`alice:${id}`).bundleKey,before);
  }finally{db.saveSubtitleBundleAssignment=save;}
  assert.equal((await play(id,title,25)).count,1);
  assert.match(identity.parseBundleScope(assignments.get(`alice:${id}`).bundleKey).track,/^카이란\|.*source:anissia:700$/);
});
test('legacy compatibility retains work, season, kind, creator, source and filename variant boundaries',()=>{
  const scope={type:'local',provider:'anissia',work:'compatibility',kind:'main',season:1,track:'카이란|작품ep화|작품ep화|source:anissia:700'};
  const known=identity.bundleScopeKey(scope),legacy=identity.bundleScopeKey({...scope,track:'로컬파일|작품ep화|작품ep화'});
  assert.equal(identity.bundleMatchesAssignment(legacy,known),true);
  assert.equal(identity.bundleMatchesAssignment(known,legacy),true);
  assert.equal(identity.bundleScopesOverlap(legacy,known),true);
  for(const changes of [{provider:'aniall'},{work:'elsewhere'},{season:2},{kind:'ova'},
    {track:'카이란|작품ep화ns|작품ep화ns|source:anissia:700'},
    {track:'카이란|작품ep화__2|작품ep화__2|source:anissia:700'}])
    assert.equal(identity.bundleMatchesAssignment(legacy,identity.bundleScopeKey({...scope,...changes})),false);
  for(const track of ['다른제작자|작품ep화|작품ep화|source:anissia:700','카이란|작품ep화|작품ep화|source:anissia:701'])
    assert.equal(identity.bundleMatchesAssignment(known,identity.bundleScopeKey({...scope,track})),false);
  assert.equal(identity.refineLocalBundleAssignment(legacy,known),known);
  assert.equal(identity.refineLocalBundleAssignment(known,legacy),null);
  assert.equal(identity.refineLocalBundleAssignment(identity.bundleScopeKey({...scope,type:'folder',track:undefined}),known),null);
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
  vm.runInNewContext(code,{exports,require:id=>id==='postgres'?()=>sql:id==='./subtitleLocalIdentity'?identity:id==='./episodeMapping'?require('../src/lib/episodeMapping.ts'):require(id),
    process:{env:{DATABASE_URL:'postgres://test'}},console,Buffer,setTimeout,clearTimeout});
  return exports;
}

test('Final Stage subtitle offset defaults to 21 without replacing a viewer override',async()=>{
  let saved=null;
  const db=loadSettingsDb(async parts=>String(parts).includes('SELECT start_episode')
    ? saved===null?[]:[{start_episode:saved}] : []);
  assert.equal(await db.getSubtitleEpisodeStart('viewer','ani_1346'),21);
  assert.equal(await db.getSubtitleEpisodeStart('viewer','re_beatless-final-stage-tmwejf'),21);
  assert.equal(await db.getSubtitleEpisodeStart('viewer','ani_42'),null);
  saved=7;
  assert.equal(await db.getSubtitleEpisodeStart('viewer','ani_1346'),7);
});

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
    vm.runInNewContext(code,{exports,require:id=>id==='postgres'?()=>sql:id==='./subtitleLocalIdentity'?identity:id==='./episodeMapping'?require('../src/lib/episodeMapping.ts'):require(id),process:{env:{DATABASE_URL:url}},console,Buffer,setTimeout,clearTimeout});
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
    const legacyScope={type:'folder',provider:'anissia',work:'동시 메타데이터 보강',kind:'main',season:1,track:'로컬파일|작품ep화|작품ep화'};
    const legacyKey=identity.bundleScopeKey(legacyScope);
    const refinedA=identity.bundleScopeKey({...legacyScope,track:'카이란|작품ep화|작품ep화|source:anissia:700'});
    const refinedB=identity.bundleScopeKey({...legacyScope,track:'다른제작자|작품ep화|작품ep화|source:anissia:701'});
    await exports.saveSubtitleBundleAssignment('alice','refining','anissia',legacyKey,'Legacy');
    const refinements=await Promise.all([
      exports.saveSubtitleBundleAssignment('alice','refining','anissia',refinedA,'A',legacyKey),
      exports.saveSubtitleBundleAssignment('alice','refining','anissia',refinedB,'B',legacyKey),
    ]);
    assert.deepEqual([...refinements].sort(),[false,true]);
    assert.equal((await exports.getSubtitleBundleAssignment('alice','refining')).bundleKey,refinements[0]?refinedA:refinedB);
    // A manual choice or deletion after the GET began takes precedence.
    await exports.saveSubtitleBundleAssignment('alice','refining','anissia',refinedB,'Manual');
    assert.equal(await exports.saveSubtitleBundleAssignment('alice','refining','anissia',refinedA,'Stale GET',legacyKey),false);
    assert.equal((await exports.getSubtitleBundleAssignment('alice','refining')).bundleKey,refinedB);
    await exports.deleteSubtitleBundleAssignment('alice','refining');
    assert.equal(await exports.saveSubtitleBundleAssignment('alice','refining','anissia',refinedA,'Deleted',legacyKey),false);
    assert.equal(await exports.getSubtitleBundleAssignment('alice','refining'),null);
    // A first automatic choice is atomic, preserves manual preferences and cannot steal ownership.
    const autoKey=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'자동 선택 경쟁',kind:'main',season:1,track:'base'});
    const autoOther=identity.bundleScopeKey({...identity.parseBundleScope(autoKey),track:'other'});
    const initial=await Promise.all([
      exports.saveSubtitleBundleAssignment('auto','initial','anissia',autoKey,'A','',true),
      exports.saveSubtitleBundleAssignment('auto','initial','anissia',autoOther,'B','',true),
    ]);
    assert.deepEqual([...initial].sort(),[false,true]);
    const chosen=(await exports.getSubtitleBundleAssignment('auto','initial')).bundleKey;
    assert.equal(await exports.saveSubtitleBundleAssignment('auto','other-work','anissia',chosen,'steal','',true),false);
    assert.equal((await exports.getSubtitleBundleAssignment('auto','initial')).bundleKey,chosen);
    await exports.saveSubtitleBundleAssignment('auto','cross-provider','aniall',tvKey,'Manual');
    assert.equal(await exports.saveSubtitleBundleAssignment('auto','cross-provider','anissia',autoKey,'stale','',true),false);
    await sql`INSERT INTO subtitle_creator_preferences(user_id,anime_id,source_provider,creator_name,website) VALUES('auto','preferred','anissia','Manual','https://example.com')`;
    assert.equal(await exports.saveSubtitleBundleAssignment('auto','preferred','anissia',autoKey,'stale','',true),false);
    assert.equal((await sql`SELECT * FROM subtitle_creator_preferences WHERE user_id='auto' AND anime_id='preferred'`).length,1);
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
    assert.equal(result.count,1);assert.equal(result.needs_manual_subtitle_choice,false);
    assert.ok(result.subtitles[0].content.includes(`flat base ${ep}`));
    assert.ok(identity.parseBundleScope(result.bundle_assignment.bundleKey).track);
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
    assert.equal(data.success,true);assert.equal(data.count,2);
    assert.ok(data.subtitles.every(s=>s.episodeConfirmed && s.content.includes('episode 2')));
    assert.equal(data.subtitles.filter(s=>s.bundleAssigned).length,1);
    assert.ok(data.subtitles.find(s=>s.bundleAssigned).content.includes('series__2 episode 2'));
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


test('initial folder and ZIP defaults persist; changing compact or Korean release follows later episodes',async()=>{
  for(const provider of ['anissia','aniall']) for(const layout of ['folder','zip']) {
    const title=`번호 표기 ${provider} ${layout}`,id=`re_default_${provider}_${layout}`;
    const key=identity.bundleScopeKey({type:'folder',provider,work:title,kind:'main',season:1});
    assert.equal((await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:id,provider,bundleKey:key}))).status,200);
    const first=await play(id,'다른 이름',1);
    assert.equal(first.count,1);assert.equal(first.needs_manual_subtitle_choice,false);
    assert.ok(identity.parseBundleScope(first.bundle_assignment.bundleKey).track);
    const initial=first.subtitles[0].content.replace('release 1','release 2');
    assert.equal((await play(id,'다른 이름',2)).subtitles[0].content,initial);
    const files=provider==='anissia'?await storage.getAnissiaArchiveSubtitles([title],1,null,1,{bundleKey:key})
      :await storage.getAniAllArchiveSubtitles(title,1,1,null,'',{bundleKey:key});
    assert.equal(files.length,3);
    for(const variant of ['compact','Korean']) {
      const file=files.find(s=>s.content.includes(variant+' release 1'));assert.ok(file);
      assert.equal((await bundleRoute.PUT(request('subtitle-bundle','PUT',{animeId:id,provider,bundleKey:key,fileId:file.localFileId}))).status,200);
      for(const ep of [2,10]) {
        const next=await play(id,'다른 이름',ep);assert.equal(next.count,1);assert.equal(next.needs_manual_subtitle_choice,false);
        assert.ok(next.subtitles[0].content.includes(`${variant} release ${ep}`));
      }
    }
  }
});
test('a newer manual selection wins over an automatic request in flight',async()=>{
  const title='번호 표기 aniall folder',id='re_race_choice',save=db.saveSubtitleBundleAssignment;
  const files=await storage.getAniAllArchiveSubtitles(title,1);
  const manual=files.find(s=>s.content.includes('Korean release 1'));
  await bundleRoute.DELETE(request(`subtitle-bundle?animeId=re_default_aniall_folder`,'DELETE'));
  try {
    db.saveSubtitleBundleAssignment=async(u,a,provider,key,label,expected,automatic)=>{
      if(automatic && a===id){await save(u,a,provider,manual.sourceBundleKey,'Manual');return false;}
      return save(u,a,provider,key,label,expected,automatic);
    };
    const result=await play(id,title);assert.equal(result.count,0);assert.equal(result.needs_manual_subtitle_choice,true);
    assert.equal(assignments.get(`alice:${id}`).bundleKey,manual.sourceBundleKey);
    assert.ok((await play(id,title,2)).subtitles[0].content.includes('Korean release 2'));
  }finally{db.saveSubtitleBundleAssignment=save;}
});