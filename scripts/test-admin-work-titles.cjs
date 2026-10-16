const fs=require("node:fs");
const path=require("node:path");
const assert=require("node:assert/strict");
const {test}=require("node:test");
const ts=require("typescript");
const original=fs.readFileSync(path.join(__dirname,"../src/lib/adminWorkTitles.ts"),"utf8");
const compiled=ts.transpileModule(original,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let stored=[{anime_id:"re_s2",korean_title:"작품 2기"}];
const writes=[];
const sql=async (strings,...values)=>{
  const query=strings.join("?");
  if(query.startsWith("SELECT"))return stored.filter(row=>!values.length || values[0].includes(row.anime_id));
  writes.push({query,values});return [];
};
const output={};
new Function("require","exports",compiled)(id=>id==="@/lib/db"?{getDb:()=>sql,initDb:async()=>{}}:{},output);
const group={animeId:"re_s2",title:"English Season 2",year:"2026",members:[
  {animeId:"re_s2"},{animeId:"db_AniList_200"},{animeId:"ak_shared"}],multiAnikotoIds:["ak_shared"]};

test("Korean names reject non-text, control characters and excessive input",()=>{
  assert.equal(output.normalizeAdminKoreanTitle("  작품 2기  "),"작품 2기");
  assert.equal(output.normalizeAdminKoreanTitle(undefined),"");
  for(const bad of [null,{},123,"English", " ","작품\n2기","가".repeat(301)])
    assert.throws(()=>output.normalizeAdminKoreanTitle(bad));
});
test("Manual labels apply to exact reviewed IDs and exclude a shared Anikoto mirror",async()=>{
  writes.length=0;
  await output.persistAdminWorkTitle(sql,group,"수정한 작품 2기","admin");
  const inserts=writes.filter(row=>row.query.startsWith("INSERT"));
  assert.deepEqual(inserts.map(row=>row.values[0]),["re_s2","db_AniList_200"]);
  assert.ok(writes.every(row=>!row.values.flat().includes("ak_shared")));
  assert.ok(writes.some(row=>row.query.includes("UPDATE anime_admin_subtitle_links")));
});
test("Display edits preserve source identities and leave other seasons unchanged",async()=>{
  const input=[{id:"re_s1",title:"English Season 1"},
    {id:"re_s2",title:"English Season 2",identity_titles:["Original S2"]}];
  const result=await output.applyAdminWorkTitles(input);
  assert.equal(result[0].title,"English Season 1");
  assert.equal(result[1].title,"작품 2기");
  assert.equal(result[1].original_title,"English Season 2");
  assert.deepEqual(result[1].identity_titles,["Original S2","English Season 2"]);
  assert.equal(input[1].title,"English Season 2");
});
