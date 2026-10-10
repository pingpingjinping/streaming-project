const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {test}=require("node:test");
const ts=require("typescript");

const src=fs.readFileSync(path.join(__dirname,"../src/lib/preferredAnikotoSeason.ts"),"utf8");
const compiled=ts.transpileModule(src,{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
let rows=[
  {anikoto_id:"toradora-tiwtx",target_order:1,target_source:"AniList",target_id:"101",
    link_status:"reviewed",mapping_kind:"range",anikoto_episode_start:1,
    anikoto_episode_end:12,payload:{title_ko:"토라도라 1기",year:"2008"}},
  {anikoto_id:"toradora-tiwtx",target_order:2,target_source:"AniList",target_id:"102",
    link_status:"multi_reviewed",mapping_kind:"range",anikoto_episode_start:13,
    anikoto_episode_end:25,payload:{title_ko:"토라도라 2기",year:"2009"}}
];
const preferences=new Map();
const sql=(chunks,...params)=>{
  const statement=chunks.join("?");
  if(statement.includes("CREATE TABLE IF NOT EXISTS"))return Promise.resolve([]);
  if(statement.includes("FROM anime_anikoto_work_targets"))return Promise.resolve(
    rows.filter(r=>r.anikoto_id===params[0]));
  if(statement.includes("FROM anime_account_preferred_seasons p")) {
    const value=preferences.get(params[0]+"/"+params[1]);
    const stillValid=value&&rows.some(r=>r.anikoto_id===params[1]&&
      r.target_order===value.order&&r.target_source===value.source&&
      r.target_id===value.sourceId&&["reviewed","automatic","multi_reviewed"].includes(r.link_status));
    return Promise.resolve(stillValid?[{target_order:value.order}]:[]);
  }
  if(statement.includes("INSERT INTO anime_account_preferred_seasons")) {
    preferences.set(params[0]+"/"+params[1],{
      order:params[2],source:params[3],sourceId:params[4],
    });return Promise.resolve([]);
  }
  throw Error("Unexpected SQL "+statement);
};
const exportsValue={};
new Function("exports","require",compiled)(exportsValue,id=>
  id==="@/lib/db"?{getDb:()=>sql}:{});
const api=exportsValue;

test("season chooser uses confirmed target order and real metadata",async()=>{
  const seasons=await api.getAnikotoSeasons("toradora-tiwtx");
  assert.equal(seasons.length,2);
  assert.equal(seasons[0].title,"토라도라 1기");
  assert.equal(seasons[1].episodeStart,13);
  assert.equal(api.anikotoSeasonHref("toradora-tiwtx",2),"/anime/ak_toradora-tiwtx?season=2");
});

test("priority choice stays per account, not a shared database link",async()=>{
  assert.equal(await api.savePreferredAnikotoSeason("viewer1","toradora-tiwtx",2),true);
  assert.equal(await api.getPreferredAnikotoSeason("viewer1","toradora-tiwtx"),2);
  assert.equal(await api.getPreferredAnikotoSeason("viewer2","toradora-tiwtx"),null);
  assert.equal(await api.savePreferredAnikotoSeason("viewer2","toradora-tiwtx",1),true);
  assert.equal(await api.getPreferredAnikotoSeason("viewer1","toradora-tiwtx"),2);
});

test("monthly release changing target order never silently changes a saved season",async()=>{
  await api.savePreferredAnikotoSeason("viewer-old","toradora-tiwtx",2);
  const old=rows;
  rows=old.map(row=>row.target_order===2?{...row,target_id:"another-season"}:row);
  try {assert.equal(await api.getPreferredAnikotoSeason("viewer-old","toradora-tiwtx"),null);}
  finally{rows=old;}
});

test("unknown video or season cannot be prioritized",async()=>{
  assert.equal(await api.savePreferredAnikotoSeason("viewer","toradora-tiwtx",99),false);
  assert.equal(await api.savePreferredAnikotoSeason("viewer","missing-id",1),false);
  assert.equal(await api.savePreferredAnikotoSeason("viewer","../../bad",1),false);
  assert.equal(api.anikotoSeasonHref("../../bad",1),null);
  assert.equal(api.anikotoSeasonHref("toradora-tiwtx",0),null);
});

test("episode list only filters when reviewed numeric range exists and matches",()=>{
  const episodes=Array.from({length:25},(_,i)=>({number:i+1,title:"EP "+(i+1)}));
  const season={episodeStart:13,episodeEnd:25};
  const narrowed=api.filterSeasonEpisodes(episodes,season);
  assert.equal(narrowed.filtered,true);
  assert.deepEqual(narrowed.episodes.map(x=>x.number),Array.from({length:13},(_,i)=>i+13));
  assert.deepEqual(api.filterSeasonEpisodes(episodes,{episodeStart:null,episodeEnd:null}),
    {episodes,filtered:false});
  assert.deepEqual(api.filterSeasonEpisodes(episodes,{episodeStart:44,episodeEnd:50}),
    {episodes,filtered:false});
});

test("not-yet reviewed rows are never selectable",async()=>{
  const old=rows;rows=[{...old[0],link_status:"hold"}];
  try {
    assert.equal((await api.getAnikotoSeasons("toradora-tiwtx")).length,0);
    assert.equal(await api.savePreferredAnikotoSeason("viewer","toradora-tiwtx",1),false);
  }finally{rows=old;}
});
