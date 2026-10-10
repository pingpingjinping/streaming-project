const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ts = require("typescript");

const code = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "../src/lib/animeSearchMode.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const context = vm.createContext({ exports: {} });
vm.runInContext(code, context);
const { resolveAnimeSearchMode, shouldQueryCloudflare, shouldUseLocalDbFallback } = context.exports;

test("Anissia current-site defaults to Cloudflare DB search", () => {
  assert.equal(resolveAnimeSearchMode("anissia", "current"), "db");
  assert.equal(resolveAnimeSearchMode("anissia", "current", "db"), "db");
  assert.equal(resolveAnimeSearchMode("anissia", "current", "bogus"), "db");
  assert.equal(shouldQueryCloudflare("db"), true);
  assert.equal(shouldUseLocalDbFallback("db"), true);
});

test("explicit Anissia page search bypasses both Cloudflare and Pi DB fallback", () => {
  assert.equal(resolveAnimeSearchMode("anissia", "current", "page"), "page");
  assert.equal(shouldQueryCloudflare("page"), false);
  assert.equal(shouldUseLocalDbFallback("page"), false);
});

test("ReAnime, Anikoto and other sites cannot use D1 even with stale db mode URL", () => {
  for (const source of ["reanime", "anikoto", "linkkf", "ohli24"]) {
    assert.equal(resolveAnimeSearchMode(source, "current", "db"), "page");
    assert.equal(resolveAnimeSearchMode(source, "current"), "page");
  }
  assert.equal(resolveAnimeSearchMode("anissia", "all", "db"), "page");
});
