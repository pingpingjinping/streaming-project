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
const hellTitle='헬 모드 ~파고들기 좋아하는 게이머는 폐급 설정 이세계에서 무쌍한다~ 2nd Season';
const hellRe='re_hell-mode-the-hardcore-gamer-dominates-in-another-world-with-garbage-balancing-season-2-f383t6';
for(const ep of [1,2])put(`anissia_subtitles/${hellTitle}/HELL MODE The Hardcore Gamer Dominates in Another World with Garbage Balancing - s02e${String(ep).padStart(2,'0')}.ko.ass`,ass(`hell season two episode ${ep}`));
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
for(const ep of [1,2,3,4,5,6]){
  const filename=`You're Under Arrest! SP1E${String(ep).padStart(2,'0')}.smi`;
  put(`anissia_subtitles/체포하겠어 Mini Specials/${filename}`,
    Buffer.from(`<SAMI><BODY><SYNC Start=1000><P Class=KRCC>mini special ${ep}<SYNC Start=3000><P Class=KRCC>&nbsp;</BODY></SAMI>`));
}

put('anissia_subtitles/특별편 울려라! 유포니엄 앙상블 콘테스트/Hibike! Euphonium - Ensemble Contest-hen (1080P).smi',
  Buffer.from('<SAMI><BODY><SYNC Start=1000><P Class=KRCC>ensemble special<SYNC Start=3000><P Class=KRCC>&nbsp;</BODY></SAMI>'));
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
// Real-world Psycho-Pass loose subtitles: one stable release across 22 episodes.
for (let ep = 1; ep <= 22; ep++) {
  const suffix = String(ep).padStart(2,'0') + (ep === 22 ? ' END' : '');
  const filename = `[Moozzi2] Psycho-Pass S1 - ${suffix} (BD 1920x1080 x.264-10Bit DTS-HDMA).smi`;
  const bytes = Buffer.from(`<SAMI><BODY><SYNC Start=1000><P Class=KRCC>psycho pass episode ${ep}<SYNC Start=3000><P Class=KRCC>&nbsp;</BODY></SAMI>`);
  put(`anissia_subtitles/PSYCHO-PASS/${filename}`,bytes);
}
// Numeric-suffix sequel title without an explicit S2 label.
for (let ep=1;ep<=11;ep++) {
  const filename=`[ReinForce] PSYCHO-PASS 2 - ${String(ep).padStart(2,'0')} (BDRip 1920x1080 x264 FLAC).smi`;
  const bytes=Buffer.from(`<SAMI><BODY><SYNC Start=1000><P Class=KRCC>psycho pass two episode ${ep}<SYNC Start=3000><P Class=KRCC>&nbsp;</BODY></SAMI>`);
  put(`anissia_subtitles/PSYCHO-PASS 2/${filename}`,bytes);
}
// Sibling-only inference: neither the episode number nor the suffix is in
// the old strict parser's supported filename positions.
for(const ep of [1,2,3,4]) for(const variant of ['',' NS']) {
  const name=`[Studio] Mystic Signal ${String(ep).padStart(3,'0')} encode x264 1080p${variant}.smi`;
  put(`anissia_subtitles/미스틱 시그널/${name}`,Buffer.from(
    `<SAMI><BODY><SYNC Start=1000><P Class=KRCC>sibling ${ep}${variant}<SYNC Start=3000><P Class=KRCC>&nbsp;</BODY></SAMI>`));
}
zipFile('aniall_subtitles/ZIP 형제 파일/collection.zip',
  Object.fromEntries([1,2,3,4].map(ep=>[
    `Subfolder/Mystic Signal ${String(ep).padStart(3,'0')} encode x265 1080p.srt`,srt(`zip sibling ${ep}`),
  ])));
const db=require('../src/lib/db.ts'),auth=require('../src/lib/auth.ts'),storage=require('../src/lib/subtitleStorage.ts');
const reviewed=require('../src/lib/reviewedSubtitleStorage.ts'),titles=require('../src/lib/subtitles.ts'),matches=require('../src/lib/reanimeMatches.ts');
const identity=require('../src/lib/subtitleLocalIdentity.ts');
const episodeEvidence=require('../src/lib/subtitleEpisodes.ts');
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

// Render the real modal with inert effects; clicks still call the real persistence API.
function renderSubtitleModal(candidate,{animeId,episode=1,tab='creators',searchEp=99,fetchOverride,savingKey='',folderRow}={}) {
  // The local API adds these display/provider fields to raw storage results.
  candidate={name:candidate.orig_filename,localArchive:true,sourceProvider:'anissia',...candidate};
  const vm=require('node:vm'),module={exports:{}},stateWrites=[],calls=[],selected=[],events=[],order=[];
  let hook=0,closes=0;
  // Four selected-folder state slots precede the existing bundle saving state.
  const overrides=new Map([[0,true],[1,tab],[2,[candidate]],[5,searchEp],[6,[candidate]],[28,savingKey]]);
  if(folderRow){overrides.set(10,folderRow.choice);overrides.set(35,[folderRow.file]);overrides.set(36,1);}
  const react={useEffect(){},useRef:value=>({current:value}),useState:initial=>{
    const index=hook++,value=overrides.has(index)?overrides.get(index):typeof initial==='function'?initial():initial;
    return[value,next=>stateWrites.push({index,next})];
  }};
  const jsx=(type,props)=>({type,props});
  const dependencies={react,'react/jsx-runtime':{jsx,jsxs:jsx},'react-dom':{createPortal:tree=>tree},
    'lucide-react':new Proxy({},{get:(_,name)=>name}),'@/lib/subtitleLocalIdentity':identity,
    '@/lib/subtitleEpisodes':episodeEvidence,
    './SubtitleFolderAssignments':()=>null,'./SubtitleEpisodeExceptions':()=>null,'./ErulaboDownloadButton':()=>null};
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/components/SubtitleSelectModal.tsx'),'utf8'),
    {compilerOptions:{...compilerOptions,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require:id=>{
    assert.ok(id in dependencies,`unexpected modal dependency: ${id}`);return dependencies[id];
  },Error,URLSearchParams,document:{body:{}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
    window:{dispatchEvent:event=>{events.push(event);order.push('refresh');}},fetch:async(endpoint,options)=>{
      const body=options?.body ? JSON.parse(options.body) : null;
      calls.push({endpoint,method:options?.method || 'GET',body});
      if(fetchOverride)return fetchOverride(endpoint,options);
      if(endpoint.startsWith('/api/anime/subtitles/local?'))
        return require('../src/app/api/anime/subtitles/local/route.ts').GET(new NextRequest('http://localhost'+endpoint));
      return (endpoint.endsWith('subtitle-exceptions')?exceptionRoute:bundleRoute).PUT(request(endpoint.split('/').at(-1),options.method,body));
    }});
  const tree=module.exports.default({isOpen:true,animeId,animeTitle:'작품',episodeNumber:episode,creators:[],
    onSelectSubtitle:subtitle=>{selected.push(subtitle);order.push('select');},onClose:()=>{closes++;order.push('close');}});
  const nodes=[];function walk(node){if(Array.isArray(node))return node.forEach(walk);if(node&&typeof node==='object'){
    nodes.push(node);walk(node.props?.children);
  }}walk(tree);
  function label(node){if(Array.isArray(node))return node.map(label).join('');if(node&&typeof node==='object')return label(node.props?.children);
    return typeof node==='string'||typeof node==='number'?String(node):'';}
  return{button:text=>nodes.find(node=>node.type==='button'&&label(node).includes(text)),calls,selected,events,order,stateWrites,get closes(){return closes;}};
}

test('Psycho-Pass S1 loose files share a track and the first choice resumes all 22 episodes',async()=>{
  const title='PSYCHO-PASS',id='re_psycho_pass',key=identity.bundleScopeKey({
    type:'folder',provider:'anissia',work:title,kind:'main',season:1,
  });
  let initial;
  for(let ep=1;ep<=22;ep++){
    const filename=`[Moozzi2] Psycho-Pass S1 - ${String(ep).padStart(2,'0')}${ep===22?' END':''} (BD 1920x1080 x.264-10Bit DTS-HDMA).smi`;
    const evidence=episodeEvidence.readEpisodeEvidence(filename,true);
    assert.deepEqual(evidence.episodes,[ep]);
    const options=await storage.getAnissiaArchiveSubtitles([title],ep,null,1,{bundleKey:key});
    assert.equal(options.length,1,`episode ${ep} should have an exact local candidate`);
    const subtitle=options[0];
    assert.equal(subtitle.episodeConfirmed,true,`episode ${ep} must be confirmed`);
    // decodeSubtitleFile shortens display names over 60 characters; identity
    // must still come from the actual loose-file path, not the display label.
    assert.ok(subtitle.localFileId && subtitle.sourceBundleKey);
    if(!initial) initial=subtitle;
    else assert.equal(subtitle.sourceBundleKey,initial.sourceBundleKey,`episode ${ep} changed release track`);
  }
  const saved=await bundleRoute.PUT(request('subtitle-bundle','PUT',{
    animeId:id,provider:'anissia',bundleKey:key,fileId:initial.localFileId,
  }));
  assert.equal(saved.status,200);
  for(const ep of [1,2,3,11,21,22]){
    const result=await play(id,title,ep);
    assert.equal(result.count,1,`episode ${ep} not automatically selected`);
    assert.equal(result.needs_manual_subtitle_choice,false);
    assert.ok(result.subtitles[0].content.includes(`psycho pass episode ${ep}`));
    assert.equal(result.subtitles[0].sourceBundleKey,initial.sourceBundleKey);
  }
});
test('shared sequel parser avoids ordinary numbered titles and preserves season-qualified release identities',()=>{
  const sequel=require('../src/lib/subtitleTitleSeason.ts');
  const positive=['PSYCHO-PASS 2','모브 사이코 3','My Series 4'];
  for(const title of positive){
    const number=Number(title.slice(-1));
    assert.equal(sequel.implicitSequelSeason(title),number);
    assert.equal(titles.parseSeason(title),number);
    assert.equal(episodeEvidence.readWorkTitleEvidence(title).season,number);
    assert.deepEqual(episodeEvidence.readWorkTitleEvidence(title).episodes,[]);
  }
  for(const title of ['86','86 - Eighty Six','PSYCHO-PASS 3 FIRST INSPECTOR','PSYCHO-PASS 2020','PSYCHO-PASS Sinners of the System','Steins;Gate 0']){
    assert.equal(sequel.implicitSequelSeason(title),null,`unexpected sequel inference: ${title}`);
  }
  assert.equal(titles.parseSeason('PSYCHO-PASS 3 FIRST INSPECTOR'),null);
  const first='[ReinForce] PSYCHO-PASS 2 - 01 (BDRip 1920x1080 x264 FLAC).smi';
  const second=first.replace(' - 01 ', ' - 02 ');
  const parsed=sequel.numberedSequelEpisode(first.slice(0,-4));
  assert.equal(parsed.season,2);
  assert.equal(parsed.episode,1);
  assert.equal(first.slice(0,-4).slice(parsed.episodeStart,parsed.episodeEnd),'01');
  assert.deepEqual(episodeEvidence.readEpisodeEvidence(first,true).episodes,[1]);
  assert.equal(episodeEvidence.readEpisodeEvidence(first,true).season,2);
  assert.equal(identity.normalizeSubtitleTrackFilename(first,1),identity.normalizeSubtitleTrackFilename(second,2));
  assert.equal(sequel.numberedSequelEpisode('86 - Eighty Six'),null);
  assert.equal(sequel.numberedSequelEpisode('PSYCHO-PASS 3 FIRST INSPECTOR'),null);
  assert.equal(sequel.numberedSequelEpisode('1080 - 720 (HD)'),null);
  assert.equal(identity.subtitleScope(first,'PSYCHO-PASS 2').season,2);
  assert.equal(identity.subtitleScope('[Moozzi2] Psycho-Pass S1 - 01 (BD...).smi','PSYCHO-PASS').season,1);
});

test('Psycho-Pass 2 ReinForce loose subtitles keep sequel season and one release track across 11 episodes',async()=>{
  const title='PSYCHO-PASS 2',id='re_psycho_pass_two',folder=identity.bundleScopeKey({
    type:'folder',provider:'anissia',work:title,kind:'main',season:2,
  });
  const oldWrongScope=identity.bundleScopeKey({
    type:'folder',provider:'anissia',work:title,kind:'main',season:1,
  });
  assert.equal(titles.parseSeason(title),2);
  assert.equal(identity.subtitleScope('',title).season,2);
  assert.deepEqual(episodeEvidence.readWorkTitleEvidence(title).episodes,[]);
  assert.equal(episodeEvidence.readWorkTitleEvidence(title).season,2);
  let first;
  for(let ep=1;ep<=11;ep++){
    const filename=`[ReinForce] PSYCHO-PASS 2 - ${String(ep).padStart(2,'0')} (BDRip 1920x1080 x264 FLAC).smi`;
    const evidence=episodeEvidence.readEpisodeEvidence(filename,true);
    assert.equal(evidence.season,2);
    assert.deepEqual(evidence.episodes,[ep]);
    assert.equal(evidence.range,false,`episode ${ep} was mistaken for a numeric range`);
    assert.equal(evidence.multipleSeasons,false);
    assert.equal(evidence.conflict,false);
    const files=await storage.getAnissiaArchiveSubtitles([title],ep,null,2,{bundleKey:folder});
    assert.equal(files.length,1,`Psycho-Pass 2 episode ${ep} missing`);
    assert.equal(files[0].episodeConfirmed,true);
    assert.equal(identity.parseBundleScope(files[0].sourceBundleKey).season,2);
    if(!first)first=files[0];
    else assert.equal(files[0].sourceBundleKey,first.sourceBundleKey,`Psycho-Pass 2 episode ${ep} changed track`);
  }
  // A stale assignment at the wrong season must never silently borrow season 2 files.
  assert.deepEqual(await storage.getAnissiaArchiveSubtitles([title],1,null,1,{bundleKey:oldWrongScope}),[]);
  const manual=await storage.getAnissiaArchiveSubtitles([title],1,null,2,{
    folderNameQuery:title,manualSearch:true,
  });
  assert.ok(manual.some(s=>s.episodeConfirmed), 'manual search still finds the real episode one');
  const saved=await bundleRoute.PUT(request('subtitle-bundle','PUT',{
    animeId:id,provider:'anissia',bundleKey:folder,fileId:first.localFileId,
  }));
  assert.equal(saved.status,200);
  for(const ep of [1,2,3,10,11]){
    const result=await play(id,title,ep);
    assert.equal(result.count,1,`episode ${ep} failed automatic bundle selection`);
    assert.equal(result.needs_manual_subtitle_choice,false);
    assert.ok(result.subtitles[0].content.includes(`psycho pass two episode ${ep}`));
    assert.equal(result.subtitles[0].sourceBundleKey,first.sourceBundleKey);
  }
  assert.equal(titles.parseSeason('PSYCHO-PASS Sinners of the System'),null);
  assert.equal(titles.parseSeason('PSYCHO-PASS 3 FIRST INSPECTOR'),null);
});

test('physical sibling comparison infers episodes, separates NS tracks and falls back for ambiguous names',async()=>{
  const infer=require('../src/lib/subtitleSiblingInference.ts').inferSiblingEpisodes;
  const names=[1,2,3,4].flatMap(ep=>['',' NS'].map(variant=>
    `[Studio] Mystic Signal ${String(ep).padStart(3,'0')} encode x264 1080p${variant}.smi`));
  const siblings=infer(names);
  assert.equal(siblings.size,8);
  assert.equal(siblings.get(names[0]).episode,1);
  assert.ok(siblings.get(names[0]).template.includes('{ep}'));
  assert.notEqual(siblings.get(names[0]).template,siblings.get(names[1]).template,'NS release crossed normal release');
  const ambiguous=['Twin 01 01.srt','Twin 01 02.srt','Twin 02 01.srt','Twin 02 02.srt'];
  assert.equal(infer(ambiguous).size,0,'two simultaneously changing numeric positions are ambiguous');
  assert.equal(infer(['onlyone.srt']).size,0);
  const split=infer(['S01/E01.srt','S01/E02.srt','S02/E01.srt']);
  assert.equal(split.get('S02/E01.srt'),undefined,'do not borrow siblings in another subfolder');
  const work='미스틱 시그널',id='re_mystic_sibling';
  const folder=identity.bundleScopeKey({type:'folder',provider:'anissia',work,kind:'main',season:1});
  let first;
  for(const ep of [1,2,3,4]){
    const subtitles=await storage.getAnissiaArchiveSubtitles([work],ep,null,1,{bundleKey:folder});
    assert.equal(subtitles.length,2,`folder sibling episode ${ep} not selected`);
    for(const subtitle of subtitles) assert.equal(subtitle.episodeConfirmed,true);
    const defaultOne=subtitles.find(x=>x.archiveFilename.includes('1080p.smi'));
    if(!first)first=defaultOne;
    else assert.equal(defaultOne.sourceBundleKey,first.sourceBundleKey,`folder release changed at ${ep}`);
    assert.notEqual(subtitles[0].sourceBundleKey,subtitles[1].sourceBundleKey,'NS and base variants were merged');
  }
  assert.equal((await bundleRoute.PUT(request('subtitle-bundle','PUT',{
    animeId:id,provider:'anissia',bundleKey:folder,fileId:first.localFileId,
  }))).status,200);
  for(const ep of [1,2,4]){
    const result=await play(id,work,ep);
    assert.equal(result.count,1);
    assert.equal(result.needs_manual_subtitle_choice,false);
    assert.ok(result.subtitles[0].content.includes(`sibling ${ep}`));
    assert.equal(result.subtitles[0].sourceBundleKey,first.sourceBundleKey);
  }
  const zipTitle='ZIP 형제 파일',zipId='re_zip_sibling',zipFolder=identity.bundleScopeKey({
    type:'folder',provider:'aniall',work:zipTitle,kind:'main',season:1,
  });
  let zipFirst;
  for(const ep of [1,2,3,4]){
    const subtitles=await storage.getAniAllArchiveSubtitles(zipTitle,ep,1,null,'',{bundleKey:zipFolder});
    assert.equal(subtitles.length,1,`ZIP sibling episode ${ep} not selected`);
    assert.equal(subtitles[0].episodeConfirmed,true);
    if(!zipFirst)zipFirst=subtitles[0];
    else assert.equal(subtitles[0].sourceBundleKey,zipFirst.sourceBundleKey);
  }
  assert.equal((await bundleRoute.PUT(request('subtitle-bundle','PUT',{
    animeId:zipId,provider:'aniall',bundleKey:zipFolder,fileId:zipFirst.localFileId,
  }))).status,200);
  const zipNext=await play(zipId,zipTitle,3);
  assert.equal(zipNext.count,1);
  assert.ok(zipNext.subtitles[0].content.includes('zip sibling 3'));
});

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
test('a Pi local SRT with SAMI markers plays through the saved episode exception and VTT API', async () => {
  const work='예외 지정 영화',filename='Movie.srt',animeId='re_srt_exception_movie';
  const source=Buffer.from(
    '\uFEFF1\n00:00:05,001 --> 00:00:07,123\n<P Class=KRCC>\n<font color=lightgreen>정상 재생</font>\n\n' +
    '2\n00:00:08,000 --> 00:00:09,000\n<P Class=KRCC>\n&nbsp;\n',
    'utf8'
  );
  put('anissia_subtitles/'+work+'/'+filename,source);
  const folderKey=identity.bundleScopeKey({type:'folder',provider:'anissia',work,kind:'main',season:1});
  const local=await storage.getLocalSubtitleFolderFile(folderKey,filename);
  assert.ok(local?.localFileId);
  assert.equal(local.format,'VTT');
  assert.match(local.content,/00:00:05,001 --> 00:00:07,123\n<P Class=KRCC>/);
  assert.ok(!local.content.startsWith('WEBVTT')); // Pi SRT remains original
  assert.equal((local.content.match(/-->/g)||[]).length,2);
  const saved=await exceptionRoute.PUT(request('subtitle-exceptions','PUT',{
    animeId,episodeNumber:1,provider:'anissia',fileId:local.localFileId,
  }));
  assert.equal(saved.status,200);
  const selected=await play(animeId,work,1);
  assert.equal(selected.subtitles[0]?.episodeException,true);
  assert.equal(selected.subtitles[0].content,local.content);
  const stream=await native.GET(request(
    'subtitles/vtt?animeId='+animeId+'&ep=1&localFileId='+encodeURIComponent(local.localFileId),'GET'));
  assert.equal(stream.status,200);
  const vtt=await stream.text();
  assert.match(vtt,/WEBVTT\n\n00:00:05\.001 --> 00:00:07\.123\n정상 재생/);
  assert.doesNotMatch(vtt,/-->[^\n]*\n\n[^\n]/);
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
  vm.runInNewContext(code,{exports,require:id=>id==='postgres'?()=>sql:id==='./subtitleLocalIdentity'?identity:id==='./episodeMapping'?require('../src/lib/episodeMapping.ts'):id==='./linkaniSettings'?require('../src/lib/linkaniSettings.ts'):require(id),
    process:{env:{DATABASE_URL:'postgres://test'}},console,Buffer,setTimeout,clearTimeout});
  return exports;
}

function ownershipDb(manual=[], imported=[]) {
  return loadSettingsDb(async(parts,...values)=>{
    const query=parts.join('?');
    if(query.includes('FROM anime_work_match_overrides'))return manual;
    if(query.includes('FROM anime_reanime_matches'))return imported.filter(row=>
      ['검토된 사항','자동확정'].includes(row.review_status) && row.anissia_no &&
      (values.length===1 ? row.anissia_no===values[0]
        : row.reanime_id===values[0] || String(row.anissia_no)===values[1]));
    return [];
  });
}
test('bundle ownership shares only explicit or unique reviewed IDs, in both directions',async()=>{
  const manual=[{reanime_id:hellRe.slice(3),anissia_no:3485}];
  const imported=[{reanime_id:'old-season',anissia_no:3485,review_status:'자동확정'},
    {reanime_id:hellRe.slice(3),anissia_no:3298,review_status:'검토된 사항'}];
  const api=ownershipDb(manual,imported);
  for(const id of [hellRe,'ani_3485','3485'])assert.deepEqual([...(await api.getSubtitleBundleWorkIds(id))],['ani_3485',hellRe]);
  for(const id of ['ani_3298','re_old-season'])assert.deepEqual([...(await api.getSubtitleBundleWorkIds(id))],[id]);
  const reviewed=ownershipDb([], [{reanime_id:'reviewed',anissia_no:12,review_status:'자동확정'}]);
  for(const id of ['ani_12','re_reviewed'])assert.deepEqual([...(await reviewed.getSubtitleBundleWorkIds(id))],['ani_12','re_reviewed']);
});
test('candidate and ambiguous imported pairs cannot bypass another work ownership',async()=>{
  const api=ownershipDb([], [{reanime_id:'candidate',anissia_no:12,review_status:'후보'},
    {reanime_id:'one',anissia_no:13,review_status:'검토된 사항'},
    {reanime_id:'two',anissia_no:13,review_status:'자동확정'}]);
  for(const id of ['re_candidate','ani_12','re_one','re_two','ani_13','ak_combined'])
    assert.deepEqual([...(await api.getSubtitleBundleWorkIds(id))],[id]);
});
test('missing match tables retain exact ownership and unexpected DB errors are surfaced',async()=>{
  const missing=loadSettingsDb(async()=>{throw {code:'42P01'};});
  assert.deepEqual([...(await missing.getSubtitleBundleWorkIds(hellRe))],[hellRe]);
  const broken=loadSettingsDb(async()=>{throw new Error('connection failed');});
  await assert.rejects(broken.getSubtitleBundleWorkIds(hellRe),/connection failed/);
});

test('Hell Mode legacy Anissia folder plays through its manually linked ReAnime ID without stealing another season',
  {skip:!process.env.REVIEWED_TEST_DATABASE_URL},async()=>{
  const postgres=require('postgres'),schema=`bundle_alias_${process.pid}_${Date.now()}`;
  const admin=postgres(process.env.REVIEWED_TEST_DATABASE_URL,{max:1});let sql;
  const restored=[];
  const replace=(obj,key,value)=>{restored.push([obj,key,obj[key]]);obj[key]=value;};
  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql=postgres(process.env.REVIEWED_TEST_DATABASE_URL,{max:5,connection:{search_path:schema}});
    const api=loadSettingsDb(sql);await api.initDb();
    await sql.unsafe('CREATE TABLE anime_reanime_matches(reanime_id text,korean_title text,anissia_no integer,review_status text)');
    await sql`INSERT INTO anime_work_match_overrides(reanime_id,anissia_no,updated_by) VALUES(${hellRe.slice(3)},3485,'test')`;
    const folder=identity.bundleScopeKey({type:'folder',provider:'anissia',work:hellTitle,kind:'main',season:2});
    const seasonOne=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'헬 모드 1기',kind:'main',season:1});
    await sql`INSERT INTO subtitle_bundle_assignments(user_id,anime_id,provider,bundle_key,label) VALUES
      ('alice','ani_3485','anissia',${folder},${hellTitle}),
      ('alice','ani_3298','anissia',${seasonOne},'헬 모드 1기'),
      ('bob','ani_3485','anissia',${folder},'Bob choice')`;
    assert.equal((await api.getSubtitleBundleAssignment('alice',hellRe)).bundleKey,folder);
    const context=await api.getSubtitleBundleAssignments('alice',hellRe);
    assert.equal(context.find(row=>row.bundleKey===folder).animeId,hellRe);
    assert.equal(context.find(row=>row.bundleKey===seasonOne).animeId,'ani_3298');
    for(const key of ['getSubtitleBundleAssignment','getSubtitleBundleAssignments','saveSubtitleBundleAssignment'])replace(db,key,api[key]);
    replace(db,'getDb',()=>sql);
    replace(matches,'getReanimeMatch',async id=>id===hellRe?{koreanTitle:hellTitle,anissiaNo:3485}:null);
    for(const ep of [1,2]) {
      const response=await play(hellRe,hellTitle,ep);
      assert.equal(response.count,1);assert.equal(response.needs_manual_subtitle_choice,false);
      assert.ok(response.subtitles[0].content.includes(`hell season two episode ${ep}`));
    }
    assert.equal((await play('ani_3485',hellTitle,1)).count,1);
    assert.equal((await api.getSubtitleBundleAssignment('alice','ani_3298')).bundleKey,seasonOne);
    const selected=await api.getSubtitleBundleAssignment('alice',hellRe);
    assert.equal(await api.saveSubtitleBundleAssignment('alice','re_unrelated','anissia',selected.bundleKey,'steal','',true),false);
    assert.equal(await api.saveSubtitleBundleAssignment('alice',hellRe,'anissia',folder,'stale','',true),false);
    assert.equal((await api.getSubtitleBundleAssignment('bob',hellRe)).bundleKey,folder);
    // Read a historical ReAnime-only choice from the Anissia page, then
    // consolidate a deliberate edit and delete through either alias.
    await api.deleteSubtitleBundleAssignment('alice',hellRe);
    await sql`INSERT INTO subtitle_bundle_assignments(user_id,anime_id,provider,bundle_key,label)
      VALUES('alice',${hellRe},'anissia',${folder},'Legacy ReAnime')`;
    assert.equal((await api.getSubtitleBundleAssignment('alice','ani_3485')).bundleKey,folder);
    assert.equal(await api.saveSubtitleBundleAssignment('alice',hellRe,'anissia',folder,'Updated'),true);
    assert.equal((await sql`SELECT anime_id FROM subtitle_bundle_assignments WHERE user_id='alice' AND anime_id=ANY(${['ani_3485',hellRe]}::text[])`)[0].anime_id,'ani_3485');
    await api.deleteSubtitleBundleAssignment('alice',hellRe);
    assert.equal(await api.getSubtitleBundleAssignment('alice','ani_3485'),null);
    assert.equal((await api.getSubtitleBundleAssignment('bob',hellRe)).bundleKey,folder);
  } finally {
    for(const[obj,key,value]of restored.reverse())obj[key]=value;
    if(sql)await sql.end();await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});

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
    vm.runInNewContext(code,{exports,require:id=>id==='postgres'?()=>sql:id==='./subtitleLocalIdentity'?identity:id==='./episodeMapping'?require('../src/lib/episodeMapping.ts'):id==='./linkaniSettings'?require('../src/lib/linkaniSettings.ts'):require(id),process:{env:{DATABASE_URL:url}},console,Buffer,setTimeout,clearTimeout});
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

test('direct folder-file pick on a separate OVA player does not steal a shared TV folder assignment',async()=>{
  rows=[];
  const work='풀린 작품',folderKey=identity.bundleScopeKey({
    type:'folder',provider:'anissia',work,kind:'ova',season:1,
  });
  const oldOwner={animeId:'re_shared_tv',provider:'anissia',bundleKey:folderKey,label:work,exclusive:true};
  assignments.set('alice:re_shared_tv',oldOwner);
  const ovaId='re_shared_ova';
  const ui=renderSubtitleModal({name:'OVA/01.srt'},{
    animeId:ovaId,episode:1,tab:'search',searchEp:1,
    folderRow:{choice:{folderName:work,folderKey,provider:'anissia',entryType:'folder'},
      file:{path:'OVA/01.srt',member:'',label:'OVA/01.srt'}},
  });
  assert.ok(ui.button('현재 화 적용'));
  ui.button('현재 화 적용').props.onClick();
  for(let i=0;i<250 && !ui.closes;i++)await new Promise(done=>setTimeout(done,4));
  assert.equal(ui.closes,1,'the current-episode subtitle choice should close after persistence: '+JSON.stringify({calls:ui.calls,stateWrites:ui.stateWrites}));
  assert.equal(ui.selected.length,1);
  assert.equal(ui.selected[0].episodeException,true);
  assert.deepEqual(ui.calls.map(call=>call.endpoint.split('?')[0]),
    ['/api/anime/subtitles/local','/api/anime/subtitle-exceptions']);
  assert.equal(ui.calls[1].body.animeId,ovaId);
  assert.equal(ui.calls[1].body.episodeNumber,1);
  assert.equal(assignments.get('alice:re_shared_tv'),oldOwner,'another player lost its folder');
  assert.equal(assignments.has('alice:'+ovaId),false,'individual file pick created a work-wide assignment');
  const result=await play(ovaId,'OVA 별도 플레이어',1);
  assert.equal(result.needs_manual_subtitle_choice,false);
  assert.match(result.subtitles[0].content,/flat OVA/);
  assert.equal(result.subtitles[0].name,'01.srt',
    'episode-only selection must show original filename instead of sub.vtt after reload');
});

test('SP1E01-SP1E06 share one set, and the manually selected original filename survives reload',async()=>{
  rows=[];
  const folder='체포하겠어 Mini Specials',key=identity.bundleScopeKey({
    type:'folder',provider:'anissia',work:folder,kind:'special',season:1,
  }),fileName="You're Under Arrest! SP1E02.smi";
  const animeId='re_mini_specials_set';
  const first=await storage.getLocalSubtitleFolderFile(key,fileName);
  assert.ok(first?.localFileId);
  assert.equal(first.name,fileName,'manual local file must display the source .smi name, not sub.vtt');
  assert.deepEqual(identity.parseBundleScope(first.sourceBundleKey).kind,'special');
  assert.equal(identity.parseBundleScope(first.sourceBundleKey).season,1);
  for(const ep of [1,3,6]){
    const next=await storage.getLocalSubtitleFolderFile(key,`You're Under Arrest! SP1E${String(ep).padStart(2,'0')}.smi`);
    assert.ok(next?.sourceBundleKey);
    assert.equal(identity.parseBundleScope(next.sourceBundleKey).track,
      identity.parseBundleScope(first.sourceBundleKey).track,'special filenames split into separate release tracks');
  }
  const ui=renderSubtitleModal(first,{animeId,episode:2,tab:'search',searchEp:2,
    folderRow:{choice:{folderName:folder,folderKey:key,provider:'anissia',entryType:'folder'},
      file:{path:fileName,member:'',label:fileName}},
  });
  assert.ok(ui.button('현재 화 적용'));
  assert.ok(ui.button('이 세트 적용'));
  ui.button('이 세트 적용').props.onClick();
  for(let i=0;i<250 && !ui.closes;i++)await new Promise(done=>setTimeout(done,4));
  assert.equal(ui.closes,1,'set button did not persist: '+JSON.stringify({calls:ui.calls,stateWrites:ui.stateWrites}));
  assert.deepEqual(ui.calls.map(call=>call.endpoint.split('?')[0]),[
    '/api/anime/subtitles/local','/api/anime/subtitle-bundle',
  ]);
  const set=assignments.get('alice:'+animeId);
  assert.ok(set?.bundleKey);
  assert.equal(identity.parseBundleScope(set.bundleKey).track,
    identity.parseBundleScope(first.sourceBundleKey).track,'the set button did not retain the selected release');
  assert.equal(ui.selected[0].name,fileName);
  for(const ep of [1,2,3,6]){
    const result=await play(animeId,folder,ep);
    assert.equal(result.count,1,'missing auto subtitle for episode '+ep);
    assert.equal(result.needs_manual_subtitle_choice,false);
    assert.match(result.subtitles[0].content,new RegExp('mini special '+ep));
    assert.match(result.subtitles[0].name,/You're Under Arrest! SP1E\d{2}\.smi/,
      'the player lost the original source filename');
  }
});

test('default manual-file buttons save current episode, leaving future-folder ownership explicit',async()=>{
  rows=[];
  const candidate=await storage.getLocalSubtitleFolderFile(identity.bundleScopeKey({
    type:'folder',provider:'anissia',work:'풀린 작품',kind:'ova',season:1,
  }),'OVA/01.srt');
  assert.ok(candidate?.localFileId);
  for(const tab of ['creators','search']){
    const animeId='re_default_local_'+tab,ui=renderSubtitleModal(candidate,{animeId,episode:2,tab});
    const label=tab==='creators'?'현재 화 적용':'현재 화 선택';
    assert.ok(ui.button(label),tab+' manual selection is missing');
    ui.button(label).props.onClick();
    for(let i=0;i<250 && !ui.closes;i++)await new Promise(done=>setTimeout(done,4));
    assert.equal(ui.calls.length,1,'wrong manual pick action: '+JSON.stringify({calls:ui.calls,stateWrites:ui.stateWrites}));
    assert.equal(ui.calls[0].endpoint,'/api/anime/subtitle-exceptions');
    assert.equal(ui.calls[0].body.episodeNumber,2);
    assert.equal(ui.closes,1);
    assert.equal(assignments.has('alice:'+animeId),false);
    const result=await play(animeId,'OVA 별도 플레이어',2);
    assert.equal(result.count,1);
    assert.match(result.subtitles[0].content,/flat OVA/);
  }
});

test('current-episode button saves an unnumbered Ensemble Contest file and refresh no longer requests manual selection',async()=>{
  rows=[];
  const title='특별편 울려라! 유포니엄 앙상블 콘테스트';
  const files=await storage.getAnissiaArchiveSubtitles([title],1,null,null,{manualSearch:true});
  const candidate=files.find(s=>s.orig_filename.includes('Ensemble Contest-hen'));assert.ok(candidate);
  assert.equal(candidate.episodeConfirmed,false);
  const animeId='re_ensemble_button';await assign(animeId,'anissia',candidate);
  const before=assignments.get(`alice:${animeId}`);
  assert.equal((await play(animeId,title)).needs_manual_subtitle_choice,true);
  const ui=renderSubtitleModal(candidate,{animeId});
  assert.ok(ui.button('이번 화만 지정'));assert.ok(ui.button('이 버전 계속'));
  await ui.button('이번 화만 지정').props.onClick();
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].endpoint,'/api/anime/subtitle-exceptions');
  assert.equal(ui.calls[0].body.episodeNumber,1);assert.equal(ui.calls[0].body.fileId,candidate.localFileId);
  assert.equal(ui.selected[0].episodeException,true);assert.equal(ui.closes,1);
  assert.deepEqual(ui.order,['select','close','refresh']);assert.equal(ui.events[0].detail.animeId,animeId);
  assert.strictEqual(assignments.get(`alice:${animeId}`),before);
  for(let reload=0;reload<2;reload++) {
    const current=await play(animeId,title);assert.equal(current.needs_manual_subtitle_choice,false);
    assert.equal(current.subtitles[0].localFileId,candidate.localFileId);assert.ok(current.subtitles[0].content.includes('ensemble special'));
  }
  assert.equal((await play(animeId,title,2)).assignment_missing,true);
});

test('both modal lists save numbered files to the player episode without changing the next-episode bundle',async()=>{
  rows=[];
  const files=await storage.getAnissiaArchiveSubtitles(['풀린 작품'],1,null,null,{manualSearch:true});
  const candidate=files.find(s=>s.content.includes('flat OVA')),base=files.find(s=>s.content.includes('flat base 1'));
  assert.ok(candidate&&base);
  for(const tab of ['creators','search']) {
    const animeId=`re_episode_button_${tab}`;await assign(animeId,'anissia',base);
    const before=assignments.get(`alice:${animeId}`);
    const ui=renderSubtitleModal(candidate,{animeId,episode:3,tab,searchEp:1});
    assert.ok(ui.button('예외 만들기'));await ui.button('이번 화만 지정').props.onClick();
    assert.equal(ui.calls[0].body.episodeNumber,3);assert.equal(ui.selected.length,1);assert.equal(ui.closes,1);
    assert.strictEqual(assignments.get(`alice:${animeId}`),before);
    assert.ok((await play(animeId,'풀린 작품',3)).subtitles[0].content.includes('flat OVA'));
    assert.ok((await play(animeId,'풀린 작품',2)).subtitles[0].content.includes('flat base 2'));
  }
});

test('current-episode button also persists reviewed-file IDs',async()=>{
  const row=registryRow('button-bonus','bonus.ass','버튼 특전','button-special');rows=[row];
  const candidate=await reviewed.readReviewedFile(row),animeId='re_reviewed_button';
  const ui=renderSubtitleModal(candidate,{animeId,episode:4,tab:'search'});
  assert.ok(ui.button('작품 전체 지정'));await ui.button('이번 화만 지정').props.onClick();
  assert.equal(ui.calls[0].body.fileId,candidate.reviewedFileId);
  const current=await play(animeId,'버튼 특전',4);assert.equal(current.needs_manual_subtitle_choice,false);
  assert.equal(current.subtitles[0].reviewedFileId,candidate.reviewedFileId);
  assert.equal(assignments.has(`alice:${animeId}`),false);
});

test('failed episode save keeps the modal open and reports the error; unsupported files have no episode button',async()=>{
  rows=[];const files=await storage.getAnissiaArchiveSubtitles(['풀린 작품'],1,null,null,{manualSearch:true});
  const candidate=files.find(s=>s.content.includes('flat base 1'));
  for(const tab of ['creators','search']) {
    const ui=renderSubtitleModal(candidate,{animeId:'re_failed_button',tab,
      fetchOverride:async()=>({ok:false,json:async()=>({success:false,message:'파일이 변경되었습니다.'})})});
    await ui.button('이번 화만 지정').props.onClick();
    assert.equal(ui.closes,0);assert.equal(ui.selected.length,0);assert.equal(ui.events.length,0);
    assert.ok(ui.stateWrites.some(write=>write.next==='파일이 변경되었습니다.'));
    const unsupported=renderSubtitleModal({...candidate,localFileId:undefined,reviewedFileId:undefined},{animeId:'re_raw_zip',tab});
    assert.equal(unsupported.button('이번 화만 지정'),undefined);
    const busy=renderSubtitleModal(candidate,{animeId:'re_busy',tab,savingKey:'other-save'});
    assert.equal(busy.button('이번 화만 지정').props.disabled,true);
    await busy.button('이번 화만 지정').props.onClick();assert.equal(busy.calls.length,0);
  }
});

test('native player episode-only selection preserves future-episode track preference while ordinary selection still changes it',()=>{
  const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../src/components/Player.tsx'),'utf8');
  const start=source.indexOf('  const handleSelectFoundSubtitle ='),end=source.indexOf('\n  const autoNextRef',start);
  assert.ok(start>=0&&end>start);
  const code=ts.transpileModule(source.slice(start,end),{compilerOptions}).outputText;
  const key='anissia-local-track:re_player_button',preferences=new Map([[key,'ordinary-track']]),applied=[];
  const context={animeId:'re_player_button',subs:[],currentSyncOffset:0,
    setNeedsManualSubtitleChoice(){},setSubtitleNotice(){},setSubs(){},setSelectedSubIndex(){},refreshSubtitleSettings(){},
    applySubtitle:subtitle=>applied.push(subtitle),window:{localStorage:{
      setItem:(k,v)=>preferences.set(k,v),removeItem:k=>preferences.delete(k),
    }}};
  function select(option){vm.runInNewContext(code+'\nhandleSelectFoundSubtitle(option);',{...context,option});}
  const local={name:'special',content:'special',localArchive:true,sourceProvider:'anissia',localArchiveTrackKey:'special-track'};
  select({...local,episodeException:true});assert.equal(preferences.get(key),'ordinary-track');
  select({name:'reviewed',reviewedFileId:'reviewed_v6_1109:bonus',episodeException:true});
  assert.equal(preferences.get(key),'ordinary-track');assert.equal(applied.length,2);
  select(local);assert.equal(preferences.get(key),'special-track');
  select({name:'uploaded'});assert.equal(preferences.has(key),false);
});
