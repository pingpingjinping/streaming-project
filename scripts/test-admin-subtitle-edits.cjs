const fs=require("node:fs");
const fsp=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const assert=require("node:assert/strict");
const {test}=require("node:test");
const ts=require("typescript");
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,"../src/lib/adminSubtitleLinker.ts"),"utf8"),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const writes=[];
let existing=true,failWrite=false;
let migrated=null,refreshes=0;
const catalog=[{source:"ReAnime",source_record_id:"test",payload:{title_english:"English Season 2"}}];
const sql=async(strings,...values)=>{
  const query=strings.join("?");
  if(query.startsWith("CREATE"))return [];
  if(query.includes("FROM anime_catalog_entries"))return query.includes("cross_source_ids_json")?[]:catalog;
  if(query.includes("FROM anime_admin_subtitle_links") && query.includes("LIMIT 1"))
    return existing?[{relative_path:values[0]}]:[];
  if(query.startsWith("SELECT"))return [];
  if(failWrite)throw new Error("database write failed");
  writes.push({query,values});return [];
};
sql.begin=async fn=>fn(sql);
const group={animeId:"re_test",title:"English Season 2",year:"2026",members:[
  {animeId:"re_test",source:"ReAnime",id:"test",title:"English Season 2",year:"2026"}],multiAnikotoIds:[]};
const output={};
new Function("require","exports",code)(id=>{
  if(id==="@/lib/db")return {getDb:()=>sql,initDb:async()=>{}};
  if(id==="@/lib/adminSubtitleWorkGroups")return {buildReviewedWorkGroups:()=>[group]};
  if(id==="@/lib/adminWorkTitles")return {
    ensureAdminWorkTitlesTable:async()=>sql,getAdminWorkTitles:async()=>new Map(),
    normalizeAdminKoreanTitle:value=>value||"",
    persistAdminWorkTitle:async()=>{},
  };
  if(id==="@/lib/adminSubtitlePathMigration")return {
    migrateSavedSubtitlePaths:async(_tx,from,to)=>{migrated={from,to};},
    migrateSubtitleSourcePaths:async()=>null,assertMergeHasNoSavedPaths:async()=>{},
  };
  if(id==="@/lib/localSubtitleNameIndex")return {refreshLocalSubtitleNameIndex:async()=>{refreshes++;}};
  if(id.startsWith("@/"))return {};
  return id==="node:path"?{...path,default:path}:require(id);
},output);

test("Existing connection edits update DB fields while preserving physical folder and files",async()=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),"subtitle-db-edit-"));
  const oldRoot=process.env.SUBTITLE_STORAGE_DIR;
  process.env.SUBTITLE_STORAGE_DIR=root;
  const folder=path.join(root,"anissia_subtitles","Original Folder");
  try {
    await fsp.mkdir(folder,{recursive:true});
    await fsp.writeFile(path.join(folder,"01.srt"),"original bytes");
    writes.length=0;
    const result=await output.saveAdminSubtitleLink({relativePath:"anissia_subtitles/Original Folder",
      type:"folder",animeId:"re_test",kind:"special",season:2,admin:"tester",koreanTitle:"새 한글명 2기"});
    assert.equal(result.keptPath,true);
    assert.equal(refreshes,0);
    assert.equal(result.title,"새 한글명 2기");
    assert.equal(result.relativePath,"anissia_subtitles/Original Folder");
    assert.equal(await fsp.readFile(path.join(folder,"01.srt"),"utf8"),"original bytes");
    assert.deepEqual(await fsp.readdir(path.dirname(folder)),["Original Folder"]);
    const update=writes.find(row=>row.query.includes("INSERT INTO anime_admin_subtitle_links"));
    assert.deepEqual(update.values.slice(0,6),["anissia_subtitles/Original Folder","folder","re_test","새 한글명 2기","special",2]);
    failWrite=true;
    await assert.rejects(()=>output.saveAdminSubtitleLink({relativePath:result.relativePath,type:"folder",
      animeId:"re_test",kind:"main",season:1,admin:"tester"}),/database write failed/);
    assert.equal(await fsp.readFile(path.join(folder,"01.srt"),"utf8"),"original bytes");
    await assert.rejects(()=>output.saveAdminSubtitleLink({relativePath:result.relativePath,type:"folder",
      animeId:"re_test",kind:"main",season:1,admin:"tester",koreanTitle:"바뀔 이름",keepPath:false}),/database write failed/);
    assert.deepEqual(await fsp.readdir(path.dirname(folder)),["Original Folder"]);
    failWrite=false;
    const renamed=await output.saveAdminSubtitleLink({relativePath:result.relativePath,type:"folder",
      animeId:"re_test",kind:"special",season:2,admin:"tester",koreanTitle:"새 한글명 2기",keepPath:false});
    assert.equal(renamed.relativePath,"anissia_subtitles/새 한글명 2기");
    assert.deepEqual(migrated,{from:"anissia_subtitles/Original Folder",to:renamed.relativePath});
    assert.equal(await fsp.readFile(path.join(root,...renamed.relativePath.split("/"),"01.srt"),"utf8"),"original bytes");
    assert.equal(refreshes,1);
  } finally {
    failWrite=false;
    if(oldRoot===undefined)delete process.env.SUBTITLE_STORAGE_DIR;else process.env.SUBTITLE_STORAGE_DIR=oldRoot;
    await fsp.rm(root,{recursive:true,force:true});
  }
});
