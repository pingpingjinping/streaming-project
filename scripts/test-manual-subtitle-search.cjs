const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/manualSubtitleSearch.ts"),"utf8");
const code = ts.transpileModule(source,{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
const rows = [
  {relative_path:"anissia_subtitles/슬라임",anime_id:"db_Onnada_777",work_title:"전생했더니 슬라임이었던 건에 대하여",
    member_ids:["db_Onnada_777","db_AniList_100","re_slime1","ak_slime1"]},
  {relative_path:"anissia_subtitles/토라도라",anime_id:"db_Onnada_888",work_title:"토라도라!",
    member_ids:["db_Onnada_888","db_AniList_101","re_tora1","ak_tora1"]},
];
let enabled=true;
const sql = (strings,...params)=>{
  const query=String(strings[0]);
  if(query.includes("anime_admin_subtitle_links"))return Promise.resolve(enabled?rows:[]);
  if(query.includes("anime_catalog_entries"))return Promise.resolve([
    {source:"Onnada",source_record_id:"777",payload:{title_ko:"전생했더니 슬라임이었던 건에 대하여"}},
    {source:"AniList",source_record_id:"100",payload:{title_english:"That Time I Got Reincarnated as a Slime"}},
    {source:"ReAnime",source_record_id:"slime1",payload:{title_english:"Tensei Shitara Slime"}},
    {source:"Onnada",source_record_id:"888",payload:{title_ko:"토라도라!"}},
    {source:"AniList",source_record_id:"101",payload:{title_english:"Toradora!"}},
    {source:"ReAnime",source_record_id:"tora1",payload:{title_english:"Toradora"}},
  ]);
  if(query.includes("anime_anikoto_catalog"))return Promise.resolve([
    {anikoto_id:"slime1",payload:{title:"Slime"}},
    {anikoto_id:"tora1",payload:{title:"Toradora"}},
  ]);
  throw Error("Unexpected SQL " + query);
};
const directCode = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "../src/lib/catalogDirectPlayback.ts"),"utf8"),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}
).outputText;
const directHelpers={};
new Function("exports",directCode)(directHelpers);
const output={};
new Function("require","exports",code)(
  id=>id==="@/lib/db"?{getDb:()=>sql}:
    id==="@/lib/catalogDirectPlayback"?directHelpers:{}, output,
);
const {searchManualSubtitleLinks,mergeManualSubtitleSearchResults}=output;

test("Pi-only manual work is found by its Korean work title without Cloudflare", async()=>{
  const hits=await searchManualSubtitleLinks("토라도라");
  assert.equal(hits.length,1);
  assert.equal(hits[0].item.id,"re_tora1");
  assert.equal(hits[0].item.source_name,"Pi 자막 연결");
  assert.equal(hits[0].memberIds.length,4);
  assert.equal(hits[0].item.detail_url,"/anime/re_tora1");
});

test("Manual link appears when searching a verified AniList English alias",async()=>{
  const hits=await searchManualSubtitleLinks("reincarnated as a slime");
  assert.equal(hits.length,1);
  assert.equal(hits[0].item.title,"전생했더니 슬라임이었던 건에 대하여");
});

test("Korean search does not return every manual folder as a false positive",async()=>{
  const hits=await searchManualSubtitleLinks("없음");
  assert.equal(hits.length,0);
});

test("A Cloudflare card matching any member ID is not duplicated",()=>{
  const remote=[{id:"db_AniList_101",title:"Toradora",poster:"",detail_url:"/catalog/AniList/101",remarks:""}];
  const linked=[{item:{id:"re_tora1",title:"토라도라!",poster:"",detail_url:"/anime/re_tora1",remarks:""},
    memberIds:["db_Onnada_888","db_AniList_101","re_tora1"]}];
  const combined=mergeManualSubtitleSearchResults(remote,linked);
  assert.equal(combined.length,1);
  assert.equal(combined[0].id,"db_AniList_101");
  assert.equal(combined[0].source_name,"Pi 자막 연결");
  assert.equal(combined[0].detail_url,"/anime/re_tora1");
});

test("Cloudflare misses are added without removing remote result pages",()=>{
  const remote=Array.from({length:20},(_,i)=>({id:"ani_"+(i+1),title:"Anime "+i,poster:"",
    detail_url:"/anime/ani_"+(i+1),remarks:""}));
  const linked=[{item:{id:"re_tora1",title:"토라도라!",poster:"",detail_url:"/anime/re_tora1",remarks:""},
    memberIds:["re_tora1"]}];
  const combined=mergeManualSubtitleSearchResults(remote,linked);
  assert.equal(combined.length,21);
  assert.equal(combined[0].id,"re_tora1");
  assert.equal(combined[20].id,"ani_20");
});

test("No manual links means no extra DB search results",async()=>{
  enabled=false;
  try {assert.deepEqual(await searchManualSubtitleLinks("토라도라"),[]);}
  finally {enabled=true;}
});
