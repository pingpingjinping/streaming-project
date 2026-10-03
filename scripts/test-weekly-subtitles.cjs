const ts = require('typescript');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (id, ...args) {
  return resolve.call(this, id.startsWith('@/') ? path.join(__dirname, '../src', id.slice(2)) : id, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-subtitles-'));
process.env.SUBTITLE_STORAGE_DIR = root;
delete process.env.DATABASE_URL;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const zip = require('adm-zip');
function put(relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function archive(text, filename = '01.srt') {
  const z = new zip();
  z.addFile(filename, Buffer.from(`1\n00:00:01,000 --> 00:00:04,000\n${text}\n`));
  return z.toBuffer();
}
// Create every Anissia fixture before the cached production index loads.
put('anissia_subtitles/1234__원래 제목/1화/제작자/subtitle.zip', archive('number linked'));
put('anissia_subtitles/1235__원래 제목/1화/제작자/subtitle.zip', archive('other work'));
put('anissia_subtitles/1236__충돌 제목/1화/제작자/subtitle.zip', archive('conflict'));
put('anissia_subtitles/1236__충돌 제목/1화/제작자/finish.txt', JSON.stringify({ animeNo: 1237 }));
put('anissia_subtitles/1238__회차 충돌/1화/제작자/subtitle.zip', archive('wrong episode', '12.srt'));
put('anissia_subtitles/기존 작품명/1화/제작자/subtitle.zip', archive('plain folder'));
const flatWork = '카미츠바키시 건설 중';
put(`anissia_subtitles/${flatWork}/finish.txt`, JSON.stringify({ subject: flatWork, episode: 12, name: '제작자' }));
for (const episode of [1, 12]) put(`anissia_subtitles/${flatWork}/${flatWork} ${episode}화 (ver.가라오케) [SubsPlease, Erai, ASW, ToonsHub].ass`,
  `[Script Info]\nTitle: episode ${episode}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,flat episode ${episode}\n`);
put(`anissia_subtitles/${flatWork}/카미츠바키 페스 24 THE DAY THE EARTH STOOD STILL.ass`, '[Script Info]\nTitle: festival');
put('anissia_subtitles/깨진 완료 마커/finish.txt', 'download finished');
put('anissia_subtitles/깨진 완료 마커/01.srt', '1\n00:00:01,000 --> 00:00:04,000\nmarker fallback\n');
fs.mkdirSync(path.join(root, 'anissia_subtitles/zz_scan_noise'), {recursive:true});
const storage = require('../src/lib/subtitleStorage.ts');
test('Anissia index does not lose works after 30000 unrelated directory entries', async () => {
  const promises = require('node:fs/promises'), original = promises.readdir;
  promises.readdir = async (directory, options) => {
    if (directory === path.join(root, 'anissia_subtitles/zz_scan_noise')) return Array.from({length:30010}, (_,i) => ({
      name:`noise-${i}.txt`, isFile:()=>true, isDirectory:()=>false,
    }));
    const entries = await original(directory, options);
    if (directory === path.join(root, 'anissia_subtitles')) entries.sort((a,b) => Number(a.name === 'zz_scan_noise') - Number(b.name === 'zz_scan_noise'));
    return entries;
  };
  try { assert.equal((await storage.getAnissiaArchiveSubtitles(['기존 작품명'], 1)).length, 1); }
  finally {promises.readdir = original;}
});
test('flat work folders use each subtitle episode instead of the last download marker', async () => {
  for(const episode of [1,12]) {
    const subtitles = await storage.getAnissiaArchiveSubtitles([flatWork], episode);
    assert.equal(subtitles.length, 1);
    assert.ok(subtitles[0].content.includes(`flat episode ${episode}`));
  }
  assert.equal((await storage.getAnissiaArchiveSubtitles([flatWork], 2)).length, 0);
});
test('invalid finish metadata does not hide explicitly numbered local subtitles', async () => {
  const subtitles = await storage.getAnissiaArchiveSubtitles(['깨진 완료 마커'], 1);
  assert.equal(subtitles.length, 1);assert.ok(subtitles[0].content.includes('marker fallback'));
});
test('weekly Anissia ID works without finish metadata or identical title', async () => {
  const subtitles = await storage.getAnissiaArchiveSubtitles(['번역명'], 1, 1234);
  assert.equal(subtitles.length, 1);
  assert.equal(subtitles[0].animeNo, 1234);
  assert.equal(subtitles[0].matchedTitle, '원래 제목');
  assert.ok(subtitles[0].content.includes('number linked'));
});
test('known Anissia ID cannot fall through to an identical but different work title', async () => {
  assert.equal((await storage.getAnissiaArchiveSubtitles(['원래 제목'], 1, 9999)).length, 0);
});
test('conflicting metadata IDs and episode evidence remain unselected', async () => {
  assert.equal((await storage.getAnissiaArchiveSubtitles(['충돌 제목'], 1, 1236)).length, 0);
  assert.equal((await storage.getAnissiaArchiveSubtitles(['충돌 제목'], 1, 1237)).length, 0);
  assert.equal((await storage.getAnissiaArchiveSubtitles(['회차 충돌'], 1, 1238)).length, 0);
});
test('plain migrated Anissia folders remain readable', async () => {
  assert.ok((await storage.getAnissiaArchiveSubtitles(['기존 작품명'], 1))[0].content.includes('plain folder'));
});
test('AniAll same-title posts use their own stable post ID and do not bypass matching', async () => {
  put('aniall_subtitles/7654__같은 게시글명/all.zip', archive('post one'));
  put('aniall_subtitles/7655__같은 게시글명/all.zip', archive('post two'));
  assert.equal(await storage.getAniAllArchiveSubtitle('같은 게시글명', 1), null);
  assert.ok((await storage.getAniAllArchiveSubtitle('수정된 제목', 1, null, null, 'https://aniall.tistory.com/7654')).content.includes('post one'));
  assert.ok((await storage.getAniAllArchiveSubtitle('같은 게시글명', 1, null, null, 'https://aniall.tistory.com/7655')).content.includes('post two'));
  assert.equal(await storage.getAniAllArchiveSubtitle('같은 게시글명', 1, null, null, 'https://aniall.tistory.com/9999'), null);
});
test('AniAll post ID is not interpreted as episode evidence; legacy layout still works', async () => {
  put('aniall_subtitles/13__작품 2기/all.zip', archive('source thirteen', '13.srt'));
  assert.ok((await storage.getAniAllArchiveSubtitle('작품 2기', 1, 2, 13, 'https://aniall.tistory.com/13')).content.includes('source thirteen'));
  put('aniall_subtitles/기존 게시글/all.zip', archive('old layout'));
  assert.ok((await storage.getAniAllArchiveSubtitle('기존 게시글', 1)).content.includes('old layout'));
});
test('manual lookup retains same-title posts and permits explicit unresolved folder choice', async () => {
  const auth = require('../src/lib/auth.ts'), db = require('../src/lib/db.ts');
  const titles = require('../src/lib/subtitles.ts'), reviewed = require('../src/lib/reviewedSubtitleStorage.ts');
  const patches = [];
  const patch = (object, key, value) => { patches.push([object, key, object[key]]); object[key] = value; };
  patch(auth, 'getSessionUser', async () => ({ username: 'test' }));
  patch(db, 'getSubtitleEpisodeStart', async () => null);
  patch(db, 'getSubtitleRejections', async () => []);
  patch(db, 'getSubtitleSourcePriority', async () => 'aniall');
  patch(db, 'searchAniAllMatchesByTitleFragment', async () => []);
  patch(db, 'getAniAllMatches', async () => [7654, 7655].map(postId => ({ postId: String(postId),
    blogTitle: '같은 게시글명', canonicalTitle: '매칭 작품', postUrl: `https://aniall.tistory.com/${postId}`, confidence: 100 })));
  patch(titles, 'resolveKoreanTitle', async title => title);
  patch(reviewed, 'getReviewedSubtitles', async () => ({ subtitles: [] }));
  try {
    const { GET } = require('../src/app/api/anime/subtitles/local/route.ts');
    const { NextRequest } = require('next/server');
    const response = await GET(new NextRequest('http://localhost/api/anime/subtitles/local?title=매칭작품&ep=1'));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.subtitles.length, 2);
    assert.equal(new Set(body.subtitles.map(s => s.sourceCreatorWebsite)).size, 2);
    patch(db, 'getAniAllMatches', async () => []);
    const explicit = await GET(new NextRequest(`http://localhost/api/anime/subtitles/local?title=${encodeURIComponent('7654__같은 게시글명')}&ep=1`));
    assert.ok((await explicit.json()).subtitles[0].content.includes('post one'));
  } finally { for (const [object, key, value] of patches.reverse()) object[key] = value; }
});
