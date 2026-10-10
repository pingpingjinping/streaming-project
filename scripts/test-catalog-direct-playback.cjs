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
