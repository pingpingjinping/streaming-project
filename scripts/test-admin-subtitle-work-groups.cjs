const assert=require("node:assert/strict");
const {test}=require("node:test");
const fs=require("node:fs");
const path=require("node:path");
const ts=require("typescript");

const file=fs.readFileSync(path.join(__dirname,"../src/lib/adminSubtitleWorkGroups.ts"),"utf8");
const js=ts.transpileModule(file,{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
const moduleObj={exports:{}};
new Function("module","exports",js)(moduleObj,moduleObj.exports);
const {buildReviewedWorkGroups}=moduleObj.exports;

const work=(source,id,title,year="2022")=>({
  source,id,title,year,animeId:source==="Anissia"?"ani_"+id:
    source==="ReAnime"?"re_"+id:source==="Anikoto"?"ak_"+id:"db_"+source+"_"+id
});
const empty={korean:[],reanime:[],manual:[],cross:[],anikoto:[]};

test("No Anissia: reviewed Onnada, ReAnime, AniList and Anikoto form one grouped result",()=>{
  const rows=[
    work("Onnada","o1","전생했더니 슬라임"),
    work("ReAnime","r1","Slime"),
    work("AniList","a1","Tensei Slime"),
    work("Anikoto","k1","Slime dubbed"),
  ];
  const groups=buildReviewedWorkGroups({
    seeds:[{source:"ReAnime",id:"r1"}],catalog:rows,...empty,
    korean:[{source:"Onnada",id:"o1",status:"검토된 사항",
      reanimeId:"r1",anilistId:"a1"}],
    anikoto:[{anikotoId:"k1",target:{source:"Onnada",id:"o1"},
      status:"reviewed",mappingKind:"whole"}],
  });
  assert.equal(groups.length,1);
  assert.equal(groups[0].members.length,4);
  assert.deepEqual(groups[0].members.map(m=>m.source),
    ["ReAnime","AniList","Onnada","Anikoto"]);
});

test("Same-named seasons without verified links remain separate cards",()=>{
  const rows=[work("Anissia","1","Slime"),work("Anissia","2","Slime"),work("ReAnime","r3","Slime")];
  const groups=buildReviewedWorkGroups({seeds:rows,catalog:rows,...empty});
  assert.equal(groups.length,3);
});

test("A multi-reviewed Anikoto URL appears in two season groups but cannot join them",()=>{
  const rows=[work("Anissia","10","Slime 1기"),work("Anissia","20","Slime 2기"),work("Anikoto","k10","Slime all")];
  const groups=buildReviewedWorkGroups({seeds:[{source:"Anikoto",id:"k10"}],
    catalog:rows,...empty,anikoto:[
      {anikotoId:"k10",target:{source:"Anissia",id:"10"},status:"multi_reviewed",mappingKind:"range"},
      {anikotoId:"k10",target:{source:"Anissia",id:"20"},status:"multi_reviewed",mappingKind:"range"}
    ]});
  assert.equal(groups.length,2);
  for(const g of groups){
    assert.equal(g.members.length,2);
    assert.deepEqual(g.multiAnikotoIds,["ak_k10"]);
    assert.equal(g.members.filter(x=>x.source==="Anissia").length,1);
  }
});

test("Candidates or Anikoto unknown links are never used as confirmed bridges",()=>{
  const a=work("Anissia","100","K 1기"),b=work("ReAnime","r2","K 2기"),k=work("Anikoto","k2","K");
  const groups=buildReviewedWorkGroups({
    seeds:[a,b,k],catalog:[a,b,k],...empty,
    korean:[{source:"Anissia",id:"100",status:"후보 연결",reanimeId:"r2"}],
    anikoto:[{anikotoId:"k2",target:{source:"Anissia",id:"100"},
      status:"hold",mappingKind:"whole"}],
  });
  assert.equal(groups.length,3);
});

test("Manual correction excludes conflicting imported ReAnime link",()=>{
  const rows=[work("Anissia","100","first"),work("ReAnime","old","old"),work("ReAnime","new","new")];
  const groups=buildReviewedWorkGroups({seeds:rows,catalog:rows,...empty,
    korean:[{source:"Anissia",id:"100",status:"검토된 사항",reanimeId:"old"}],
    reanime:[{reanimeId:"old",anissiaNo:100,reviewStatus:"검토된 사항"}],
    manual:[{reanimeId:"new",anissiaNo:100}]
  });
  assert.equal(groups.length,2);
  const renamed=groups.find(g=>g.members.some(m=>m.animeId==="ani_100"));
  assert.deepEqual(renamed.members.map(m=>m.animeId),["ani_100","re_new"]);
  assert.equal(groups.find(g=>g.animeId==="re_old").members.length,1);
});

test("Unhydrated reviewed IDs can be gathered, then absent catalog records stay hidden",()=>{
  const row=work("Onnada","o3","Slime");
  const edges=[{source:"Onnada",id:"o3",status:"자동확정",anilistId:"a3",reanimeId:"r3"}];
  const args={seeds:[{source:"Onnada",id:"o3"}],catalog:[row],...empty,korean:edges};
  const expanded=buildReviewedWorkGroups({...args,hydrateMissing:true});
  assert.deepEqual(expanded[0].members.map(x=>x.animeId),["re_r3","db_AniList_a3","db_Onnada_o3"]);
  const real=buildReviewedWorkGroups(args);
  assert.deepEqual(real[0].members.map(x=>x.animeId),["db_Onnada_o3"]);
});
