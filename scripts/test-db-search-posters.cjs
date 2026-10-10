const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict"),{test}=require("node:test");
const ts=require("typescript");
const code=ts.transpileModule(
  fs.readFileSync(path.join(__dirname,"../src/lib/dbSearchArtwork.ts"),"utf8"),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}
).outputText;

const cached=new Map(),calls=[],artwork=[];
const sql=(parts,...params)=>{
  const query=parts.join("?");
  calls.push(query);
  if(query.includes("CREATE TABLE IF NOT EXISTS anime_search_poster_cache"))return Promise.resolve([]);
  if(query.includes("SELECT poster,source FROM anime_search_poster_cache")) {
    const item=cached.get(params[0]);return Promise.resolve(item?[item]:[]);
  }
  if(query.includes("INSERT INTO anime_search_poster_cache")) {
    cached.set(params[0],{poster:params[1],source:params[2]});return Promise.resolve([]);
  }
  if(query.includes("FROM anime_catalog_entries")) {
    if(params[0]==="Onnada"&&params[1]==="10")return Promise.resolve([{payload:{title_ko:"토라도라"}}]);
    if(params[0]==="AniList"&&params[1]==="300")return Promise.resolve([{payload:{}}]);
    return Promise.resolve([]);
  }
  if(query.includes("anime_release_reviewed_work_group_members"))return Promise.resolve([]);
  if(query.includes("anime_admin_subtitle_link_members")) {
    if(params[0]==="db_Onnada_10")return Promise.resolve([{member_id:"re_toradora-2008"},{member_id:"db_AniList_300"}]);
    return Promise.resolve([]);
  }
  if(query.includes("anime_anikoto_work_lookup"))return Promise.resolve([]);
  throw Error("Unexpected query "+query);
};
const obj={};
new Function("exports","require",code)(obj,id=>{
  if(id==="@/lib/db"||id==="./db")return {getDb:()=>sql};
  if(id==="@/lib/providers/reanime"||id==="./providers/reanime")return {getReanimeArtwork:async id=>{
    artwork.push("re:"+id);
    return id==="toradora-2008"?{poster:"https://img.example/reanime/toradora.jpg"}:null;
  }};
  if(id==="@/lib/providers/anikoto"||id==="./providers/anikoto")return {getAnimeDetail:async id=>{
    artwork.push("ak:"+id);return {poster:"https://img.example/anikoto.jpg"};
  }};
  throw Error(id);
});
const api=obj;

test("exact linked work IDs prefer ReAnime and persist in PostgreSQL cache",async()=>{
  assert.equal(api.parseSearchWorkId("db_Onnada_10").source,"Onnada");
  const image=await api.cachedDbSearchPoster("db_Onnada_10");
  assert.deepEqual(image,{poster:"https://img.example/reanime/toradora.jpg",source:"ReAnime"});
  assert.deepEqual(await api.cachedDbSearchPoster("db_Onnada_10"),image);
  assert.deepEqual(artwork,["re:toradora-2008"]);
  assert.equal(cached.get("db_Onnada_10").poster,image.poster);
});

test("AniList images use exact numeric ID, never title search",async()=>{
  const matches=[];
  const refs=await api.getVerifiedArtworkIds(sql,"db_AniList_300");
  assert.deepEqual(refs,{reanime:[],anilist:["300"],anikoto:[]});
  const start=api.resolveArtworkByIdentity;
  const oldFetch=global.fetch;
  global.fetch=async (url,opts)=>{
    matches.push(JSON.parse(opts.body).variables);
    return {ok:true,json:async()=>({data:{Media:{id:300,coverImage:{extraLarge:"https://img.example/anilist.jpg"}}}})};
  };
  try {
    assert.deepEqual(await start(refs),{poster:"https://img.example/anilist.jpg",source:"AniList"});
    assert.deepEqual(matches,[{id:300}]);
  }finally{global.fetch=oldFetch;}
});

test("ambiguous two ReAnime source IDs are never chosen by similarity",async()=>{
  const value=await api.resolveArtworkByIdentity({
    reanime:["season-one","season-two"],anilist:[],anikoto:[]
  });
  assert.equal(value,null);
});

test("Anikoto is final fallback after ReAnime and AniList, never uses unsafe URLs",async()=>{
  const value=await api.resolveArtworkByIdentity({
    reanime:[],anilist:[],anikoto:["toradora-tiwtx"]
  });
  assert.deepEqual(value,{poster:"https://img.example/anikoto.jpg",source:"Anikoto"});
  assert.equal(api.safePosterUrl("javascript:alert(1)"),"");
  assert.equal(api.safePosterUrl("http://cdn.example/img.jpg"),"");
  assert.equal(api.safePosterUrl("https://user:pass@cdn.example/img.jpg"),"");
  assert.equal(api.parseSearchWorkId("db_Onnada_../bad"),null);
});
