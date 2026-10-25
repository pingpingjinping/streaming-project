const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const content = fs.readFileSync(path.join(__dirname,"../src/lib/catalogDirectPlayback.ts"),"utf8");
const code=ts.transpileModule(content,{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const moduleExports={};
new Function("exports",code)(moduleExports);
const {directCatalogPlaybackHref,directManualSearchHref}=moduleExports;

test("Toradora from AniList/Onnada catalog directly opens uniquely reviewed Anikoto work",()=>{
  const destination=directCatalogPlaybackHref(
    ["db_Onnada_10","db_AniList_20"],
    [{anikoto_id:"toradora-tiwtx",link_status:"reviewed"}],
  );
  assert.equal(destination,"/anime/ak_toradora-tiwtx");
});

test("Anikoto 2-season multi_reviewed record does not redirect automatically",()=>{
  assert.equal(directCatalogPlaybackHref(
    ["db_Onnada_10","db_AniList_20"],
    [{anikoto_id:"season-combined",link_status:"multi_reviewed"}],
  ),null);
});

test("Multiple Anikoto playback works cannot be arbitrarily selected",()=>{
  assert.equal(directCatalogPlaybackHref([],[
    {anikoto_id:"season-1",link_status:"reviewed"},
    {anikoto_id:"season-2",link_status:"reviewed"},
  ]),null);
});

test("Ambiguous different ReAnime seasons never redirect",()=>{
  assert.equal(directCatalogPlaybackHref(["re_first","re_second"],[]),null);
});

test("Unverified Anikoto statuses are not trusted",()=>{
  assert.equal(directCatalogPlaybackHref([],[
    {anikoto_id:"hold-only",link_status:"hold"},
  ]),null);
});

test("Catalog entry with one confirmed Anissia/ReAnime video opens that work",()=>{
  assert.equal(directCatalogPlaybackHref(["ani_123","db_Onnada_5"],[]),"/anime/ani_123");
  assert.equal(directCatalogPlaybackHref(["re_tora","db_AniList_7"],[]),"/anime/re_tora");
});

test("Never allow a made-up or external href on a matched Cloudflare card",()=>{
  assert.equal(directManualSearchHref("db_Onnada_123","/anime/ak_tora"),"/anime/ak_tora");
  assert.equal(directManualSearchHref("db_AniList_123","/catalog/AniList/123"),null);
  assert.equal(directManualSearchHref("db_AniList_123","https://evil.example"),null);
  assert.equal(directManualSearchHref("db_AniList_123","/anime/db_Another_50"),null);
  assert.equal(directManualSearchHref("db_AniList_123","/anime/ak_aaa?next=evil"),null);
});

test("Metadata-only ReAnime permits one reviewed Anikoto player even with multi_reviewed status",()=>{
  assert.equal(directCatalogPlaybackHref(
    ["db_AniList_1372","re_you-re-under-arrest-tv-m29pp3"],
    [{anikoto_id:"you-re-under-arrest-1996-4cefz",link_status:"multi_reviewed"}],
    {reanimeConfirmedUnavailable:true},
  ),"/anime/ak_you-re-under-arrest-1996-4cefz");
  assert.equal(directCatalogPlaybackHref([], [
    {anikoto_id:"combined",link_status:"multi_reviewed"},
  ]),null,"unknown ReAnime availability must keep the catalog page");
});

test("No-video fallback never guesses between Anikoto targets",()=>{
  assert.equal(directCatalogPlaybackHref([], [
    {anikoto_id:"one",link_status:"multi_reviewed"},
    {anikoto_id:"two",link_status:"automatic"},
  ],{reanimeConfirmedUnavailable:true}),null);
  assert.equal(directCatalogPlaybackHref([], [
    {anikoto_id:"one",link_status:"multi_reviewed"},
    {anikoto_id:"one",link_status:"reviewed"},
  ],{reanimeConfirmedUnavailable:true}),"/anime/ak_one");
  assert.equal(directCatalogPlaybackHref(["re_title_a","re_title_b"],[],{reanimeConfirmedUnavailable:true}),null);
});

const availabilityCode=ts.transpileModule(
  fs.readFileSync(path.join(__dirname,"../src/lib/catalogVideoAvailability.ts"),"utf8"),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}},
).outputText;
function availabilityFixture(rows, failed=false) {
  const lookups=[];
  const module={};
  const sql=async (parts,...params)=>{
    lookups.push({query:parts.join("?"),params});
    if (failed) throw new Error("DB offline");
    return rows;
  };
  new Function("exports","require","console",availabilityCode)(module,
    name=>name==="./db"?{getDb:()=>sql}:require(name),{warn(){}});
  return {...module,lookups};
}
const unwatchable=id=>({reanime_id:id,payload:{source_metadata_json:{can_watch:false}}});

test("Only exact ReAnime video-unavailable flags unlock a catalog redirect",async()=>{
  const valid=availabilityFixture([
    unwatchable("you-re-under-arrest-tv-m29pp3"),
    unwatchable("you-re-under-arrest-wb62ra"),
  ]);
  assert.equal(await valid.catalogHasConfirmedNoReanimeVideo("AniList","1372"),true);
  assert.ok(valid.lookups[0].query.includes("f.work_confirmed"));
  assert.ok(valid.lookups[0].query.includes("w.automatic_eligible"));
  assert.ok(valid.lookups[0].query.includes("k.payload->>'status'"));
  assert.equal(valid.lookups[0].params.includes("1372"),true);
  const stringMeta=availabilityFixture([{reanime_id:"a",payload:JSON.stringify({
    source_metadata_json:JSON.stringify({can_watch:false}),
  })}]);
  assert.equal(await stringMeta.catalogHasConfirmedNoReanimeVideo("ReAnime","a"),true);
  for(const rows of [
    [],
    [unwatchable("a"),{reanime_id:"b",payload:{source_metadata_json:{can_watch:true}}}],
    [unwatchable("a"),{reanime_id:"b",payload:null}],
    [{reanime_id:"a",payload:{source_metadata_json:{}}}],
    [{reanime_id:"a",payload:{source_metadata_json:{can_watch:"false"}}}],
  ]) {
    assert.equal(await availabilityFixture(rows).catalogHasConfirmedNoReanimeVideo("AniList","1372"),false);
  }
  assert.equal(await availabilityFixture([],true).catalogHasConfirmedNoReanimeVideo("AniList","1372"),false);
  assert.equal(await availabilityFixture([unwatchable("a")]).catalogHasConfirmedNoReanimeVideo("AniList","1372;DELETE"),false);
});

test("Catalog page checks unavailable ReAnime only for ambiguous multi-reviewed links",()=>{
  const page=fs.readFileSync(path.join(__dirname,"../src/app/catalog/[source]/[id]/page.tsx"),"utf8");
  assert.match(page,/streams\.some\(row => row\.link_status === 'multi_reviewed'\)/);
  assert.match(page,/catalogHasConfirmedNoReanimeVideo\(source, id\)/);
  assert.match(page,/\{ reanimeConfirmedUnavailable \}/);
  assert.match(page,/view !== 'catalog'/);
});
