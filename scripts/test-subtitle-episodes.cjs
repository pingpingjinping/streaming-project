// Run the real TypeScript modules with the project's installed compiler.
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-regression-'));
process.env.SUBTITLE_STORAGE_DIR = root;
delete process.env.DATABASE_URL;
const AdmZip = require('adm-zip');
// Synthetic attachment tests must not launch a real browser when all mocked
// attachments are rejected. WinPNG extraction has its own regression suite.
const winPng = require('../src/lib/tistoryWinPng.ts');
const realWinPngExtractor = winPng.extractTistoryWinPngFiles;
winPng.extractTistoryWinPngFiles = async () => [];
const { extractSubtitleFromBuffer, fetchCreatorSubtitle, extractSubtitleFromBlogPage, decodeSubtitleFile } = require('../src/lib/subtitles.ts');
const { readEpisodeEvidence } = require('../src/lib/subtitleEpisodes.ts');
const { inspectSubtitleArchive, automaticArchiveAssignments } = require('../src/lib/subtitleUpload.ts');
const realFetch = global.fetch;
after(() => { global.fetch = realFetch; winPng.extractTistoryWinPngFiles = realWinPngExtractor; fs.rmSync(root, { recursive: true, force: true }); });
function srt(text) { return Buffer.from(`1\n00:00:01,000 --> 00:00:04,000\n${text}\n\n2\n00:00:05,000 --> 00:00:07,000\nsubtitle regression\n`); }
function zip(files) { const z = new AdmZip(); for (const [name, text] of Object.entries(files)) z.addFile(name, srt(text)); return z.toBuffer(); }
function network(page, html, files) {
  global.fetch = async (url) => {
    url = String(url);
    if (url === page) return new Response(html);
    if (files[url]) return new Response(Buffer.isBuffer(files[url]) ? files[url] : files[url].buffer, { headers: files[url].headers || {} });
    return new Response('<html><body></body></html>'); // No search results, never a real network call.
  };
}
test('a combined 1-24 ZIP cannot be split into equal seasons', () => {
  const files = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`Show - ${i + 1}.srt`, `episode ${i + 1}`]));
  assert.equal(extractSubtitleFromBuffer(zip(files), 1, 'Show 1-24.zip', false, 2), null);
});
test('season directories select S02/01 and never S01/01', () => {
  const result = extractSubtitleFromBuffer(zip({ 'Season 1/01.srt': 'wrong season', 'Season 2/01.srt': 'right season' }), 1, 'all.zip', false, 2);
  assert.ok(result?.content.includes('right season'));
});
test('a raw subtitle filename for episode 12 is not episode 1', () => {
  assert.equal(extractSubtitleFromBuffer(srt('wrong episode'), 1, 'Show - 12.srt'), null);
});
test('strict extraction accepts a raw file with a matching filename', () => {
  assert.ok(extractSubtitleFromBuffer(srt('episode one'), 1, 'Show - 01.srt', true));
});
test('Tistory latest-episode post cannot authorize a conflicting ZIP entry', async () => {
  const page = 'https://sumomomo.tistory.com/370';
  const file = 'https://blog.kakaocdn.net/attachment/subtitle.zip';
  network(page, `<title>쿠지마 노래하면 집이 파다닥 12화</title><div class="tt_article_useless_p_margin"><a href="${file}">자막.zip</a></div>`, { [file]: zip({ '01.srt': 'wrong bundle' }) });
  assert.equal(await fetchCreatorSubtitle('스모모', page, '쿠지마 노래하면 집이 파다닥', 1), null);
});
test('a rejected Drive anchor cannot reappear through raw HTML fallback', async () => {
  const page = 'https://kairan03.blogspot.com/2026/04/1.html';
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  network(page, `<title>책벌레의 하극상 1화</title><div class="post-body"><a href="https://drive.google.com/file/d/${id}/view">12화 자막</a></div>`, {
    [`https://drive.usercontent.google.com/download?id=${id}&export=download`]: srt('wrong episode'),
  });
  assert.equal(await fetchCreatorSubtitle('카이란', page, '책벌레의 하극상', 1), null);
});

for (const [episode, source] of [[1, 13], [3, 15], [12, 24]]) {
  test(`start=13 maps S2 episode ${episode} to source ${source} exactly once`, () => {
    const files = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`Show - ${i + 1}.srt`, `source ${i + 1}`]));
    const result = extractSubtitleFromBuffer(zip(files), source, 'Show 1-24.zip', true, 2, { localEpisode: episode });
    assert.ok(result?.content.includes(`source ${source}\n`));
  });
}
test('configured source 13 cannot fall back to an unseasoned 01', () => {
  assert.equal(extractSubtitleFromBuffer(zip({ '01.srt': 'wrong' }), 13, 'all.zip', true, 2, { localEpisode: 1 }), null);
});
test('S02E01 is explicitly season-relative even when source numbering is 13', () => {
  const result = extractSubtitleFromBuffer(zip({ 'S01E01.srt': 'wrong', 'S02E01.srt': 'right' }), 13, 'all.zip', true, 2, { localEpisode: 1 });
  assert.ok(result?.content.includes('right'));
});
test('a subtitle file named 1-12 is not twelve episode files', () => {
  assert.equal(extractSubtitleFromBuffer(zip({ 'Show 1-12.srt': 'merged unknown' }), 1, 'all.zip'), null);
});
test('a year/month URL never authorizes a different post episode', async () => {
  const page = 'https://kairan03.blogspot.com/2026/09/1.html';
  const file = 'https://files.example.com/01.srt';
  network(page, `<title>책벌레의 하극상 영주의 양녀 23화</title><div class="post-body"><a href="${file}">01.srt</a></div>`, { [file]: srt('wrong') });
  assert.equal(await fetchCreatorSubtitle('카이란', page, '책벌레의 하극상 영주의 양녀', 1), null);
});
test('Sumomomo 376 layout: label 13.zip + size, source13 and local1 agree', async () => {
  const page = 'https://sumomomo.tistory.com/376';
  const file = 'https://blog.kakaocdn.net/attachment/opaque';
  const html = `<title>정반대의 너와 나 13화</title><div class="tt_article_useless_p_margin"><a href="${file}">Seihantai - 13.zip 0.01MB</a></div>`;
  network(page, html, { [file]: zip({ 'Seihantai - 13.smi': 'source thirteen' }) });
  const result = await fetchCreatorSubtitle('스모모', page, '정반대의 너와 나 2기', 13, 5000, 1);
  assert.ok(result?.content.includes('source thirteen'));
});
test('post13 and link12 conflict even if ZIP contains13', async () => {
  const page = 'https://sumomomo.tistory.com/376', file = 'https://files.example.com/sub.zip';
  const html = `<title>작품 13화</title><div class="entry-content"><a href="${file}">12화</a></div>`;
  network(page, html, { [file]: zip({ '13.srt': 'wrong attachment label' }) });
  assert.equal(await extractSubtitleFromBlogPage(html, page, 'test', 13, 2, 5000, 1), null);
});
test('Content-Disposition filename contradicting title and label is rejected', async () => {
  const page = 'https://blog.example.com/1', id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const url = `https://drive.usercontent.google.com/download?id=${id}&export=download`;
  const html = `<title>작품 1화</title><div class="post-body"><a href="https://drive.google.com/file/d/${id}/view">1화</a></div>`;
  network(page, html, { [url]: { buffer: srt('wrong filename'), headers: { 'Content-Disposition': 'attachment; filename="Show - 12.srt"' } } });
  assert.equal(await extractSubtitleFromBlogPage(html, page, 'test', 1, null), null);
});
test('the same Drive ID labelled both 1 and 12 is ambiguous', async () => {
  const page = 'https://blog.example.com/1', id = 'ccccccccccccccccccccccccccccc';
  const href = `https://drive.google.com/file/d/${id}/view`;
  const html = `<title>작품 1화</title><div class="post-body"><a href="${href}">12화</a><a href="${href}">1화</a></div>`;
  network(page, html, { [`https://drive.usercontent.google.com/download?id=${id}&export=download`]: srt('ambiguous') });
  assert.equal(await extractSubtitleFromBlogPage(html, page, 'test', 1, null), null);
});
test('an image linking to Drive is accepted when post and filename agree', async () => {
  const page = 'https://blog.example.com/1', id = 'ddddddddddddddddddddddddddddd';
  const html = `<title>작품 1화</title><div class="post-body"><a href="https://drive.google.com/file/d/${id}/view"><img alt="1화 자막" src="button.png"></a></div>`;
  network(page, html, { [`https://drive.usercontent.google.com/download?id=${id}&export=download`]: zip({ '01.srt': 'correct' }) });
  assert.ok((await extractSubtitleFromBlogPage(html, page, 'test', 1, null))?.content.includes('correct'));
});
test('sidebar Drive files never take precedence over the post attachment', async () => {
  const page = 'https://blog.example.com/1';
  const wrong = 'https://files.example.com/wrong.srt', right = 'https://files.example.com/01.srt';
  const html = `<title>작품 1화</title><aside><a href="${wrong}">1화</a></aside><div class="post-body"><a href="${right}">1화</a></div>`;
  network(page, html, { [wrong]: srt('wrong'), [right]: srt('correct') });
  assert.ok((await extractSubtitleFromBlogPage(html, page, 'test', 1, null))?.content.includes('correct'));
});
test('a bundle page with no episode title can use a numbered ZIP entry', async () => {
  const page = 'https://blog.example.com/1', file = 'https://files.example.com/all.zip';
  const html = `<title>작품 완결 자막</title><div class="post-body"><a href="${file}">1-12화</a></div>`;
  network(page, html, { [file]: zip({ '01.srt': 'one', '02.srt': 'two' }) });
  assert.ok((await extractSubtitleFromBlogPage(html, page, 'test', 1, null))?.content.includes('one'));
});
test('a range alone cannot identify an unnumbered single file', async () => {
  const page = 'https://blog.example.com/1', file = 'https://files.example.com/all.zip';
  const html = `<title>작품 1-12화</title><div class="post-body"><a href="${file}">자막</a></div>`;
  network(page, html, { [file]: zip({ 'subtitle.srt': 'unknown' }) });
  assert.equal(await extractSubtitleFromBlogPage(html, page, 'test', 1, null), null);
});
test('release metadata and the numeric work title are not extra episodes', () => {
  assert.deepEqual(readEpisodeEvidence('[Moozzi2] 86 - 01v2 [1080p][ABCDEF12].ass', true).episodes, [1]);
  assert.deepEqual(readEpisodeEvidence('작품 2기 13화 (2026)').episodes, [13]);
  assert.deepEqual(readEpisodeEvidence('2026/09/23').episodes, []);
});
test('trailing parenthesized subtitle numbers identify episodes without consuming the season', () => {
  for (const [name, episode] of [
    ['Hidamari Sketch S1 (1).smi', 1], ['Hidamari Sketch S1 (10).smi', 10],
    ['Hidamari Sketch S1 SP (2).smi', 2], ['원본_40be322a2b/자막/Hidamari Sketch S1 (12).smi', 12],
    ['히다마리 스케치 S1 （０１）.smi', 1], ['Show(3).ass', 3],
  ]) {
    const evidence = readEpisodeEvidence(name, true);
    assert.deepEqual(evidence.episodes, [episode], name);
    assert.equal(evidence.conflict, false, name);
    if (name.includes('S1')) assert.equal(evidence.season, 1, name);
  }
});
test('existing episode tokens beat parenthesized download-copy suffixes', () => {
  for (const name of ['Show - 12 (1).srt', 'Show EP12 (1).smi', '작품 12화 (2).ass', 'Show [12] (1).srt']) {
    assert.deepEqual(readEpisodeEvidence(name, true).episodes, [12], name);
  }
  for (const name of ['Show (2026).smi', 'Show (1080p).srt', 'Show (v2).ass', 'Show S1.smi', 'Show (0).srt']) {
    assert.deepEqual(readEpisodeEvidence(name, true).episodes, [], name);
  }
  assert.deepEqual(readEpisodeEvidence('Show (1)').episodes, []);
  assert.deepEqual(readEpisodeEvidence('Show (1).zip', true).episodes, []);
});
test('parenthesized ZIP members select the requested episode and keep season conflicts separate', () => {
  const buffer = zip({ 'Hidamari Sketch S1 (1).srt': 'parenthesized one',
    'Hidamari Sketch S1 (2).srt': 'parenthesized two', 'Hidamari Sketch S1 (10).srt': 'parenthesized ten' });
  for (const [episode, text] of [[1, 'parenthesized one'], [2, 'parenthesized two'], [10, 'parenthesized ten']]) {
    const result = extractSubtitleFromBuffer(buffer, episode, '히다마리 스케치.zip', true, 1);
    assert.ok(result?.content.includes(text));
  }
  assert.equal(extractSubtitleFromBuffer(buffer, 1, 'all.zip', true, 2), null);
  const { entries } = inspectSubtitleArchive(buffer);
  assert.deepEqual(automaticArchiveAssignments(entries, '히다마리 스케치.zip', 1, null).map(a => a.episode).sort((a,b)=>a-b), [1, 2, 10]);
});
test('upload routes 13-24 to local1-12, retaining same-episode release variants', () => {
  const { entries } = inspectSubtitleArchive(zip({ '13.srt': 'a', '13ns.srt': 'b', '24.srt': 'c' }));
  assert.deepEqual(automaticArchiveAssignments(entries, '13-24.zip', 2, 13).map(a => a.episode), [1, 1, 12]);
});
test('upload with season folders includes only target season', () => {
  const { entries } = inspectSubtitleArchive(zip({ 'Season 1/01.srt': 'wrong', 'Season 2/01.srt': 'right', 'Season 2/02.srt': 'right2' }));
  const assigned = automaticArchiveAssignments(entries, 'all.zip', 2, null);
  assert.deepEqual(assigned.map(a => entries.find(e => e.index === a.index).filename), ['Season 2/01.srt', 'Season 2/02.srt']);
});
test('upload does not assign unnumbered files alphabetically from archive range', () => {
  const { entries } = inspectSubtitleArchive(zip({ 'a.srt': 'unknown', 'b.srt': 'unknown' }));
  assert.deepEqual(automaticArchiveAssignments(entries, '01-02.zip', null, null), []);
});
test('an explicit manual assignment can decode a differently numbered file', () => {
  assert.ok(decodeSubtitleFile(srt('manually chosen'), '13.srt')?.content.includes('manually chosen'));
});
test('UTF-16 SAMI with a HEAD element remains a valid subtitle', () => {
  const smi = Buffer.from('\ufeff<SAMI><HEAD><STYLE>p {color:white}</STYLE></HEAD><BODY><SYNC Start=1000><P>정상 자막<SYNC Start=5000><P>&nbsp;</BODY></SAMI>', 'utf16le');
  assert.ok(decodeSubtitleFile(smi, '13.smi')?.content.includes('정상 자막'));
});
test('Korean CP949 and EUC-KR subtitle bytes do not pass the UTF-8 ASCII-marker check', () => {
  const iconv = require('iconv-lite');
  const korean = '안녕, 오늘도 즐거운 하루!';
  const samples = [
    ['smi', `<SAMI><HEAD><STYLE>p {color:white}</STYLE></HEAD><BODY><SYNC Start=1000><P>${korean}<SYNC Start=5000><P>&nbsp;</BODY></SAMI>`],
    ['srt', srt(korean).toString('utf8')],
    ['vtt', `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n${korean}\n`],
    ['ass', `[Script Info]\nTitle: encoding test\n[Events]\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,${korean}\n`],
  ];
  for (const encoding of ['cp949', 'euc-kr']) {
    for (const [extension, text] of samples) {
      const result = decodeSubtitleFile(iconv.encode(text, encoding), `01.${extension}`);
      assert.ok(result?.content.includes(korean), `${encoding} ${extension}`);
      assert.ok(!result.content.includes('\uFFFD'), `${encoding} ${extension}`);
    }
  }
});
test('strict UTF-8 validation preserves UTF-8 and both UTF-16 byte orders', () => {
  const iconv = require('iconv-lite');
  const korean = '정상 한글 자막, 日本語와 emoji 🐱';
  const text = `<SAMI><HEAD></HEAD><BODY><SYNC Start=1000><P>${korean}<SYNC Start=5000><P>&nbsp;</BODY></SAMI>`;
  for (const encoding of ['utf8', 'utf16-le', 'utf16-be']) {
    for (const addBOM of [false, true]) {
      const result = decodeSubtitleFile(iconv.encode(text, encoding, { addBOM }), '01.smi');
      assert.ok(result?.content.includes(korean), `${encoding} BOM=${addBOM}`);
    }
  }
});
test('several declared seasons do not turn season numbers into episode numbers', () => {
  const info = readEpisodeEvidence('로그 호라이즌 1 2 3기');
  assert.equal(info.multipleSeasons, true);
  assert.deepEqual(info.episodes, []);
  assert.equal(info.season, null);
  assert.equal(readEpisodeEvidence('방패용사 시즌1에서 시즌4까지').multipleSeasons, true);
  assert.deepEqual(readEpisodeEvidence('Show Season1-4.zip', true).episodes, []);
});
test('a mixed-season bundle selects explicit S02E01, not an unseasoned 01', () => {
  const result = extractSubtitleFromBuffer(zip({ 'S01E01.srt': 'wrong', 'S02E01.srt': 'right', '01.srt': 'unknown season' }),
    1, '작품 1 2 3기.zip', true, 2);
  assert.ok(result?.content.includes('right'));
});
test('a first-season request cannot consume a season2-only subtitle', () => {
  assert.equal(extractSubtitleFromBuffer(zip({ 'S02E01.srt': 'wrong season' }), 1, 'all.zip', true), null);
});
test('both Season2/01 and Season2/13 with start13 require manual choice', () => {
  assert.equal(extractSubtitleFromBuffer(zip({ 'Season 2/01.srt': 'relative', 'Season 2/13.srt': 'absolute' }),
    13, 'all.zip', true, 2, { localEpisode: 1 }), null);
});
test('a season folder can contain absolute13 with an explicit start13', () => {
  assert.ok(extractSubtitleFromBuffer(zip({ 'Season 2/13.srt': 'correct' }),
    13, 'all.zip', true, 2, { localEpisode: 1 })?.content.includes('correct'));
});
test('conflicting episode statements in the same label are rejected', () => {
  assert.equal(readEpisodeEvidence('1화 / 12화').conflict, true);
  assert.equal(readEpisodeEvidence('1-12화 (24화)').conflict, true);
});
test('TV and non-sponsored filename variants retain their episode', () => {
  assert.deepEqual(readEpisodeEvidence('Seihantai - 13_tv.smi', true).episodes, [13]);
  assert.deepEqual(readEpisodeEvidence('Show - 01ns.srt', true).episodes, [1]);
});
test('spaced sponsor markers identify the episode without using arbitrary trailing words', () => {
  for (const [name, episode] of [
    ['하느님의 메모장 page 01 NS.smi', 1], ['하느님의 메모장 page 11 NS.smi', 11],
    ['Show - 12 S.srt', 12], ['Show - 13 TV.smi', 13],
    ['Show - 11_NS.smi', 11], ['Show - 11 NS [1080p].smi', 11],
  ]) assert.deepEqual(readEpisodeEvidence(name, true).episodes, [episode], name);
  for (const name of ['Show 86 movie.smi', 'Show 11 abc.smi', 'Show S1 NS.smi'])
    assert.deepEqual(readEpisodeEvidence(name, true).episodes, [], name);
  const { entries } = inspectSubtitleArchive(zip({
    '하느님의 메모장 page 01 NS.srt': 'NS one',
    '하느님의 메모장 page 11 NS.srt': 'NS eleven',
  }));
  assert.deepEqual(automaticArchiveAssignments(entries, '하느님의 메모장.zip', 1, null).map(a => a.episode), [1, 11]);
  const result = extractSubtitleFromBuffer(zip({
    '하느님의 메모장 page 01 NS.srt': 'wrong NS one',
    '하느님의 메모장 page 11 NS.srt': 'correct NS eleven',
  }), 11, '하느님의 메모장.zip', true, 1);
  assert.ok(result?.content.includes('correct NS eleven'));
});
test('a slash in an anchor label does not hide the first conflicting episode', async () => {
  const page = 'https://blog.example.com/12', file = 'https://files.example.com/12.srt';
  const html = `<title>작품 12화</title><div class="post-body"><a href="${file}">1화 / 12화</a></div>`;
  network(page, html, { [file]: srt('conflicting label') });
  assert.equal(await extractSubtitleFromBlogPage(html, page, 'test', 12, null), null);
});
test('raw fallback excludes sidebar Drive links even without a known content wrapper', async () => {
  const page = 'https://blog.example.com/1', id = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const html = `<title>작품 1화</title><aside><a href="https://drive.google.com/file/d/${id}/view">1화</a></aside>`;
  network(page, html, { [`https://drive.usercontent.google.com/download?id=${id}&export=download`]: srt('sidebar') });
  assert.equal(await extractSubtitleFromBlogPage(html, page, 'test', 1, null), null);
});
test('upload applies start13 to bare13 inside a season folder', () => {
  const { entries } = inspectSubtitleArchive(zip({ 'Season 2/13.srt': 'one', 'Season 2/24.srt': 'twelve' }));
  assert.deepEqual(automaticArchiveAssignments(entries, 'all.zip', 2, 13).map(a => a.episode), [1, 12]);
});
test('local AniAll and Anissia apply the same offset and conflict rules', async () => {
  const put = (relative, data) => { const p = path.join(root, relative); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  put('aniall_subtitles/작품 시즌2/all.zip', zip({ '13.srt': 'source13', '15.srt': 'source15', '24.srt': 'source24' }));
  put('aniall_subtitles/여러 시즌/all.zip', zip(Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`${i + 1}.srt`, `ep${i + 1}`]))));
  put('anissia_subtitles/작품 2기/13/제작자/finish.txt', JSON.stringify({ subject: '작품 2기', episode: '13', animeNo: 999 }));
  put('anissia_subtitles/작품 2기/13/제작자/subtitle.zip', zip({ 'S02E01.srt': 'correct local' }));
  put('anissia_subtitles/충돌 작품/1/제작자/finish.txt', JSON.stringify({ subject: '충돌 작품', episode: '1', animeNo: 998 }));
  put('anissia_subtitles/충돌 작품/1/제작자/subtitle.zip', zip({ '12.srt': 'wrong local' }));
  const { getAniAllArchiveSubtitle, getAnissiaArchiveSubtitles } = require('../src/lib/subtitleStorage.ts');
  assert.ok((await getAniAllArchiveSubtitle('작품 시즌2', 3, 2, 13))?.content.includes('source15'));
  assert.equal(await getAniAllArchiveSubtitle('여러 시즌', 1, 2), null);
  const local = await getAnissiaArchiveSubtitles(['작품 2기'], 13, 999, 2, { localEpisode: 1 });
  assert.equal(local.length, 1);
  assert.ok(local[0].content.includes('correct local'));
  assert.equal((await getAnissiaArchiveSubtitles(['충돌 작품'], 1, 998)).length, 0);
});
test('upload HTTP route reads the work setting and persists13 as page episode1', async () => {
  const auth = require('../src/lib/auth.ts');
  const db = require('../src/lib/db.ts');
  const oldUser = auth.getSessionUser, oldStart = db.getSubtitleEpisodeStart;
  auth.getSessionUser = async () => ({ username: 'regression-user' });
  db.getSubtitleEpisodeStart = async (user, work) => {
    assert.equal(user, 'regression-user'); assert.equal(work, 're_regression'); return 13;
  };
  try {
    const { POST } = require('../src/app/api/anime/uploaded-subtitle/route.ts');
    const { NextRequest } = require('next/server');
    const form = new FormData();
    form.set('animeId', 're_regression'); form.set('ep', '1'); form.set('title', '작품 2기'); form.set('mode', 'open');
    form.set('file', new File([zip({ '13.srt': 'episode one', '24.srt': 'episode twelve' })], '13-24.zip'));
    const response = await POST(new NextRequest('http://localhost/api/anime/uploaded-subtitle', { method: 'POST', body: form }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.saved, [1, 12]);
    assert.ok(body.subtitle.content.includes('episode one'));
    assert.equal(fs.existsSync(path.join(root, 'uploads/regression-user/re_regression/candidates/0013')), false);
  } finally { auth.getSessionUser = oldUser; db.getSubtitleEpisodeStart = oldStart; }
});
test('upload HTTP route refuses unnamed ZIP positional guesses', async () => {
  const auth = require('../src/lib/auth.ts');
  const oldUser = auth.getSessionUser;
  auth.getSessionUser = async () => ({ username: 'regression-user' });
  try {
    const { POST } = require('../src/app/api/anime/uploaded-subtitle/route.ts');
    const { NextRequest } = require('next/server');
    const form = new FormData();
    form.set('animeId', 're_ambiguous'); form.set('ep', '1'); form.set('mode', 'open');
    form.set('file', new File([zip({ 'a.srt': 'unknown', 'b.srt': 'unknown' })], '01-02.zip'));
    const response = await POST(new NextRequest('http://localhost/api/anime/uploaded-subtitle', { method: 'POST', body: form }));
    assert.equal(response.status, 422);
    assert.equal(fs.existsSync(path.join(root, 'uploads/regression-user/re_ambiguous')), false);
  } finally { auth.getSessionUser = oldUser; }
});


test('compact S101, S102 and S201 carry explicit season/episode evidence without parsing longer numbers',()=>{
  const {readEpisodeEvidence}=require('../src/lib/subtitleEpisodes.ts');
  for(const[name,season,ep]of [['s101.srt',1,1],['s102.srt',1,2],['s201.srt',2,1]]) {
    const evidence=readEpisodeEvidence(name,true);assert.deepEqual(evidence.episodes,[ep]);assert.equal(evidence.season,season);
    assert.equal(evidence.seasonEpisodePair,true);
  }
  assert.deepEqual(readEpisodeEvidence('s2026.srt',true).episodes,[]);
  assert.equal(extractSubtitleFromBuffer(zip({'s101.srt':'wrong season','s201.srt':'right season'}),13,'all.zip',true,2,{localEpisode:1})?.content.includes('right season'),true);
});