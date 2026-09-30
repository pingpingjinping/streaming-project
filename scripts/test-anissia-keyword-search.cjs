const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Exercise the production lookup with deterministic provider responses.
// External title metadata and blog extraction are outside this lookup test.
const source = fs.readFileSync(path.join(__dirname, '../src/lib/subtitles.ts'), 'utf8');
const start = source.indexOf('export async function getAnissiaCreators(');
const end = source.indexOf('// 13. High-level parallel searcher', start);
let code = source.slice(start, end).replace(/^export /m, '');
try {
  const ts = require('typescript');
  code = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  code = require('node:module').stripTypeScriptTypes(code, { mode: 'transform' });
}

function lookup(fetch, monthly = []) {
  const context = vm.createContext({
    fetch, AbortSignal, console, HEADERS: {},
    getMonthlyAnissiaCandidates: async () => monthly,
    resolveKoreanTitle: async (title) => title,
    generateAnissiaSearchQueries: (title) => [title],
    normalizeWorkTitle: (title) => title.replace(/\s/g, ''),
    parseSeason: () => 0,
    scoreAnimeMatch: () => 80,
    parseEpisodes: (episode) => [Number(episode)],
    mapProviderEpisodeNumber: (_, episode) => episode,
  });
  vm.runInContext(code, context);
  return context.getAnissiaCreators;
}
const titles = Array.from({ length: 9 }, (_, i) => ({ animeNo: i + 1, subject: `슬라임 ${i + 1}기` }));
function response(data, ok = true) { return { ok, json: async () => ({ data }) }; }
function provider({ repeat = false, failedCaption = 0 } = {}) {
  const pages = [], captions = [];
  let active = 0, maxActive = 0;
  const fetch = async (url) => {
    const caption = url.match(/caption\/animeNo\/(\d+)/);
    if (caption) {
      const id = Number(caption[1]); captions.push(id);
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return response([{ name: `제작자 ${id}`, episode: '2', website: `https://example.com/${id}` }], id !== failedCaption);
    }
    const page = Number(url.match(/list\/(\d+)/)[1]); pages.push(page);
    return response({ content: repeat || page === 0 ? titles.slice(0, 5) : titles.slice(5), last: repeat || page === 0 ? false : true, totalPages: repeat ? 100 : 2 });
  };
  return { fetch, pages, captions, maxActive: () => maxActive };
}

test('manual keyword search includes more than four works across all pages', async () => {
  const p = provider();
  const result = await lookup(p.fetch)('슬라임', 2, 3500, null, '슬라임', '', true);
  assert.equal(result.length, 9);
  assert.deepEqual(p.pages, [0, 1]);
  assert.equal(new Set(result.map((item) => item.matchedTitle)).size, 9);
  assert.ok(result.every((item) => item.is_current_ep));
  assert.ok(p.maxActive() <= 6);
});
test('automatic matching still queries one page and four caption lists', async () => {
  const p = provider();
  const result = await lookup(p.fetch)('슬라임', 2, 3500, null, '슬라임', '', false);
  assert.equal(result.length, 4);
  assert.deepEqual(p.pages, [0]);
  assert.equal(p.captions.length, 4);
});
test('repeated provider pages terminate without duplicate candidates', async () => {
  const p = provider({ repeat: true });
  const result = await lookup(p.fetch)('슬라임', 2, 3500, null, '슬라임', '', true);
  assert.equal(result.length, 5);
  assert.deepEqual(p.pages, [0, 1]);
});
test('one unavailable caption list does not hide the other works', async () => {
  const p = provider({ failedCaption: 2 });
  const result = await lookup(p.fetch)('슬라임', 2, 3500, null, '슬라임', '', true);
  assert.equal(result.length, 8);
  assert.ok(result.some((item) => item.matchedTitle === '슬라임 9기'));
});
test('manual keyword search does not add unrelated monthly suggestions', async () => {
  const p = provider();
  const result = await lookup(p.fetch, [{ animeNo: 99, subject: '다른 작품', score: 100 }])('슬라임', 2, 3500, null, '슬라임', 're_1', true);
  assert.equal(result.length, 9);
  assert.ok(!p.captions.includes(99));
});
