const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {test} = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/dbSearchPosterFallback.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const api = {};
new Function("exports", compiled)(api);
const {shouldFetchVerifiedPoster} = api;

test("Anissia home recent cards with legacy placeholder fetch verified Pi artwork", () => {
  const placeholder = "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&auto=format&fit=crop&q=80";
  assert.equal(shouldFetchVerifiedPoster("ani_3340", placeholder), true);
  assert.equal(shouldFetchVerifiedPoster("ani_3340", ""), true);
});

test("real posters are kept without duplicate calls", () => {
  const real = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx172192-W7P5xEUaxF3y.jpg";
  assert.equal(shouldFetchVerifiedPoster("ani_3340", real), false);
  assert.equal(shouldFetchVerifiedPoster("db_AniList_172192", real), false);
});

test("other feeds and malformed IDs are not redirected to Anissia artwork lookup", () => {
  const placeholder = "https://images.unsplash.com/photo-1578632767115-351597cf2477";
  assert.equal(shouldFetchVerifiedPoster("re_example", placeholder), false);
  assert.equal(shouldFetchVerifiedPoster("ani_al_172192", placeholder), false);
  assert.equal(shouldFetchVerifiedPoster("ani_../../33", ""), false);
  assert.equal(shouldFetchVerifiedPoster("db_Onnada_10", ""), true);
});
