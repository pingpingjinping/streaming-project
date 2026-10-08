const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/providers/anissia.ts"), "utf8");
const start = source.indexOf("  private async getCaptionedAnimeCatalog(");
const end = source.indexOf("  /** 전체 작품 카탈로그", start);
assert.ok(start !== -1 && end > start, "filtered catalog method is present");
const snippet = source.slice(start, end).replace("private async ", "async ");
const compiled = ts.transpileModule("class Provider {\n" + snippet + "\n}\nthis.instance = new Provider();", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function row(id, captionCount) {
  return { animeNo: id, subject: "Work " + id, captionCount, status: "ON", genres: "액션" };
}
function setup(pages, fail = false) {
  const calls = [], artworkCalls = [];
  const context = vm.createContext({
    console, AbortSignal, ANISSIA_BASE_URL: "https://api.example",
    HEADERS: {}, DEFAULT_POSTER: "fallback",
    CAPTION_CATALOG_TTL_MS: 300_000, captionCatalogIndexes: new Map(),
    toAnissiaId: (id) => "ani_" + id,
    metaKey: (id, title) => id + ":" + title,
    enrichWithArtwork: async (targets) => {
      artworkCalls.push(targets.map((x) => x.animeNo));
      return new Map();
    },
    fetch: async (url) => {
      calls.push(url);
      if (fail) return { ok: false, status: 503 };
      const number = Number(url.match(/\/anime\/list\/(\d+)/)[1]);
      return { ok: true, json: async () => ({ data: {
        content: pages[number] || [],
        totalPages: pages.length,
        last: number === pages.length - 1,
      } }) };
    },
  });
  vm.runInContext(compiled, context);
  return { provider: context.instance, calls, artworkCalls };
}

test("ON filter compacts across source pages and shows valid next pagination", async () => {
  const { provider, calls, artworkCalls } = setup([
    [row(1, 0), row(2, 3), row(3, 1), row(4, 0)],
    [row(5, 1), row(6, 0), row(7, 4), row(8, 1)],
    [row(9, 2), row(10, 0), row(11, 0)],
  ]);
  const first = await provider.getCaptionedAnimeCatalog(1);
  assert.deepEqual(Array.from(first.items, (item) => item.id), ["ani_2", "ani_3", "ani_5", "ani_7"]);
  assert.equal(first.has_next, true);
  assert.ok(first.items.every((item) => item.caption_count > 0));
  const second = await provider.getCaptionedAnimeCatalog(2);
  assert.deepEqual(Array.from(second.items, (item) => item.id), ["ani_8", "ani_9"]);
  assert.equal(second.has_next, false);
  assert.equal(second.total_pages, 2);
  assert.equal(calls.length, 3, "raw source pages should be reused from cache");
  assert.deepEqual(artworkCalls.map((x) => Array.from(x)), [[2, 3, 5, 7], [8, 9]]);
});
test("works without captions do not create empty middle pages", async () => {
  const { provider, calls } = setup([[row(1, 0), row(2, 0)], [row(3, 0)]]);
  const result = await provider.getCaptionedAnimeCatalog(1);
  assert.equal(result.items.length, 0);
  assert.equal(result.has_next, false);
  assert.equal(result.total_pages, 1);
  assert.equal(calls.length, 2);
});
test("genre request retains the keyword and only shows captioned entries", async () => {
  const { provider, calls } = setup([[row(1, 0), row(2, 2)]]);
  const result = await provider.getCaptionedAnimeCatalog(1, "이세계");
  assert.deepEqual(Array.from(result.items, (x) => x.id), ["ani_2"]);
  assert.ok(calls[0].includes("?q=" + encodeURIComponent("이세계")));
});
test("upstream errors are surfaced rather than pretending there are no subtitles", async () => {
  const { provider } = setup([], true);
  const result = await provider.getCaptionedAnimeCatalog(1);
  assert.equal(result.items.length, 0);
  assert.match(result.error, /불러오지 못했습니다/);
});
