const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const ts=require('typescript');
function load(file,imports){
  const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/'+file),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const output={};new Function('require','exports',code)(imports,output);return output;
}
const identity=load('subtitleLocalIdentity.ts',()=>({}));
const helpers=load('adminSubtitlePathMigration.ts',id=>id==='@/lib/subtitleLocalIdentity'?identity:
  id==='node:path'?{...path,default:path}:require(id));
const from='anissia_subtitles/Old Work',to='anissia_subtitles/새 작품';
test('Folder rename migrates exact bundle and episode keys without changing content identity',()=>{
  const bundle=identity.bundleScopeKey({type:'local',provider:'anissia',work:'Old Work',kind:'main',season:2,track:'creator|ep|release'});
  const renamed=identity.parseBundleScope(helpers.renamedSubtitleReference(bundle,from,to));
  assert.equal(renamed.work,'새 작품');assert.equal(renamed.track,'creator|ep|release');assert.equal(renamed.season,2);
  const file=identity.localFileKey(from+'/S2/01.zip','01.srt','a'.repeat(64));
  const reference=identity.parseLocalFileKey(helpers.renamedSubtitleReference(file,from,to));
  assert.equal(reference.relative,to+'/S2/01.zip');assert.equal(reference.member,'01.srt');assert.equal(reference.sha256,'a'.repeat(64));
  const other=identity.localFileKey(from+' Extra/01.srt','','b'.repeat(64));
  assert.equal(helpers.renamedSubtitleReference(other,from,to),other);
  assert.throws(()=>helpers.renamedSubtitleReference('legacy:'+from+'/01.srt',from,to),/옛 자막/);
  const longTrack=identity.bundleScopeKey({type:'local',provider:'anissia',work:'Old Work',kind:'main',season:1,track:'a'.repeat(950)});
  assert.ok(identity.parseBundleScope(longTrack));
  assert.throws(()=>helpers.renamedSubtitleReference(longTrack,from,'anissia_subtitles/'+'긴'.repeat(110)),/너무 깁니다/);
});
test('Weekly provenance moves with the folder and can be restored if DB saving fails',async()=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'subtitle-provenance-rename-'));
  const filename=path.join(root,'.weekly-subtitle-sources.json');
  const original=JSON.stringify({version:1,files:{[from+'/01.srt']:{sha256:'a'.repeat(64),sources:[{source:'anissia',id:'1'}]}}});
  try {
    await fsp.writeFile(filename,original);
    const rollback=await helpers.migrateSubtitleSourcePaths(root,from,to);
    const moved=JSON.parse(await fsp.readFile(filename,'utf8'));
    assert.ok(moved.files[to+'/01.srt']);assert.equal(moved.files[from+'/01.srt'],undefined);
    await rollback();assert.equal(await fsp.readFile(filename,'utf8'),original);
  } finally {await fsp.rm(root,{recursive:true,force:true});}
});
test('Stored bundles, per-episode overrides and nested ZIP links are updated together',async()=>{
  const bundle=identity.bundleScopeKey({type:'folder',provider:'anissia',work:'Old Work',kind:'main',season:1});
  const file=identity.localFileKey(from+'/01.srt','','a'.repeat(64));
  const updates=[];
  const sql=async(strings,...values)=>{
    const query=strings.join('?');
    if(query.startsWith('UPDATE')){updates.push({query,values});return [];}
    if(query.includes('FROM subtitle_bundle_assignments'))return [{user_id:'u',anime_id:'re_a',bundle_key:bundle}];
    if(query.includes('FROM subtitle_episode_overrides'))return [{user_id:'u',anime_id:'re_a',episode_number:1,file_id:file}];
    return [];
  };
  await helpers.migrateSavedSubtitlePaths(sql,from,to);
  assert.ok(updates.some(row=>row.query.includes('UPDATE subtitle_bundle_assignments') && identity.parseBundleScope(row.values[0]).work==='새 작품'));
  assert.ok(updates.some(row=>row.query.includes('UPDATE subtitle_episode_overrides') && identity.parseLocalFileKey(row.values[0]).relative===to+'/01.srt'));
  assert.ok(updates.some(row=>row.query.includes('UPDATE anime_admin_subtitle_links')));
});
