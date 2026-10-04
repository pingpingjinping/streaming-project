const ts = require('typescript');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, ...args) {
  return resolve.call(this, id.startsWith('@/') ? path.join(__dirname, '../src', id.slice(2)) : id, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-subtitle-search-'));
process.env.SUBTITLE_STORAGE_DIR = root;
delete process.env.DATABASE_URL;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const AdmZip = require('adm-zip');
const storage = require('../src/lib/localSubtitleSearch.ts');
const srt = text => Buffer.from(`1\n00:00:01,000 --> 00:00:04,000\n${text}\n\n2\n00:00:05,000 --> 00:00:07,000\nsubtitle test\n`);
function pack(relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const zip = new AdmZip(); zip.addFile('01.srt', srt(text)); zip.writeZip(file);
}
test('Anissia folders precede ZIPs; root double-extension and nested ZIP names are searched', async () => {
  fs.mkdirSync(path.join(root, 'anissia_subtitles/Hidamari 스케치'), { recursive: true });
  pack('naver_subtitles/222298023924 (253)__Hidamari Sketch-S1-BD.zip.zip', 'naver one');
  pack('aniall_subtitles/123__다른 폴더/Hidamari S2.zip', 'aniall two');
  pack('anissia_subtitles/Hidamari 스케치/자막.zip', 'anissia one');
  fs.writeFileSync(path.join(root, 'anissia_subtitles/Hidamari 스케치/Hidamari 01.srt'), srt('loose'));
  const rows = await storage.searchLocalSubtitleEntries('HIDAMARI');
  assert.equal(rows[0].provider, 'anissia'); assert.equal(rows[0].entryType, 'folder');
  assert.ok(rows[0].folderKey);
  assert.ok(rows.some(r => r.provider === 'naver' && r.folderName.endsWith('.zip.zip')));
  assert.ok(rows.some(r => r.archivePath === 'aniall_subtitles/123__다른 폴더/Hidamari S2.zip'));
  assert.ok(rows.every(r => !r.folderName.endsWith('.srt')));
  assert.deepEqual(await storage.searchLocalSubtitleEntries('h'), []);
});
test('manual ZIP selection opens the exact path even when filenames repeat', async () => {
  pack('naver_subtitles/first/Same.zip', 'first archive');
  pack('naver_subtitles/second/Same.zip', 'second archive');
  const rows = await storage.searchLocalZipSubtitles('Same.zip', 1, 1, 1, 'naver_subtitles/second/Same.zip');
  assert.equal(rows.length, 1); assert.ok(rows[0].content.includes('second archive'));
  assert.equal(rows[0].verifiedMatch, false); assert.equal(rows[0].episodeConfirmed, false);
  assert.equal(rows[0].sourceProvider, 'naver');
});
test('ZIP path traversal and symlinks outside storage cannot be read or listed', async () => {
  for (const relative of ['../outside.zip', 'naver_subtitles/../outside.zip', '/tmp/outside.zip', 'naver_subtitles\\outside.zip']) {
    assert.deepEqual(await storage.searchLocalZipSubtitles('outside', 1, 1, 1, relative), []);
  }
  fs.symlinkSync('/tmp', path.join(root, 'naver_subtitles/escape'));
  assert.ok(!(await storage.searchLocalSubtitleEntries('escape')).length);
  assert.deepEqual(await storage.searchLocalZipSubtitles('outside', 1, 1, 1, 'naver_subtitles/escape/outside.zip'), []);
});
test('folders API lists physical ZIPs without a reviewed database', async () => {
  const auth = require('../src/lib/auth.ts'); const original = auth.getSessionUser;
  auth.getSessionUser = async () => ({ username: 'test' });
  try {
    const { GET } = require('../src/app/api/anime/subtitles/local/route.ts');
    const { NextRequest } = require('next/server');
    const response = await GET(new NextRequest('http://localhost/api/anime/subtitles/local?mode=folders&title=hidamari'));
    const result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.folders[0].entryType, 'folder');
    assert.ok(result.folders.some(f => f.provider === 'naver' && f.entryType === 'zip'));
  } finally { auth.getSessionUser = original; }
});

test('manual API opens a root AniAll ZIP without treating it as a directory', async () => {
  pack('aniall_subtitles/RootSearch.zip.zip', 'root archive');
  const legacy = require('../src/lib/subtitleStorage.ts');
  assert.deepEqual(await legacy.getAniAllArchiveSubtitles('RootSearch.zip.zip', 1), []);
  const auth = require('../src/lib/auth.ts'); const original = auth.getSessionUser;
  auth.getSessionUser = async () => ({ username: 'test' });
  try {
    const { GET } = require('../src/app/api/anime/subtitles/local/route.ts');
    const { NextRequest } = require('next/server');
    const response = await GET(new NextRequest('http://localhost/api/anime/subtitles/local?mode=search&title=RootSearch.zip.zip&archivePath=aniall_subtitles%2FRootSearch.zip.zip'));
    const result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.subtitles.length, 1);
    assert.ok(result.subtitles[0].content.includes('root archive'));
    const autoResponse = await GET(new NextRequest('http://localhost/api/anime/subtitles/local?title=RootSearch.zip.zip'));
    assert.equal((await autoResponse.json()).subtitles.length, 0);
  } finally { auth.getSessionUser = original; }
});

test('exact ZIP selection excludes registered results belonging to a different physical ZIP', async () => {
  const auth = require('../src/lib/auth.ts'); const original = auth.getSessionUser;
  const reviewed = require('../src/lib/reviewedSubtitleStorage.ts'); const originalReviewed = reviewed.getReviewedSubtitles;
  auth.getSessionUser = async () => ({ username: 'test' });
  reviewed.getReviewedSubtitles = async () => ({ subtitles: [{ sourceProvider: 'naver', content: 'another ZIP',
    format: 'VTT', reviewedFileId: 'other', episodeConfirmed: true }] });
  try {
    const { GET } = require('../src/app/api/anime/subtitles/local/route.ts');
    const { NextRequest } = require('next/server');
    const response = await GET(new NextRequest('http://localhost/api/anime/subtitles/local?mode=search&title=Same.zip&archivePath=naver_subtitles%2Fsecond%2FSame.zip'));
    const result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.subtitles.length, 1);
    assert.ok(result.subtitles[0].content.includes('second archive'));
  } finally { auth.getSessionUser = original; reviewed.getReviewedSubtitles = originalReviewed; }
});

test('rejected registered members do not reappear through the raw ZIP fallback', async () => {
  const auth = require('../src/lib/auth.ts'); const original = auth.getSessionUser;
  const reviewed = require('../src/lib/reviewedSubtitleStorage.ts'); const originalFiles = reviewed.findReviewedFiles;
  const { createHash } = require('node:crypto');
  auth.getSessionUser = async () => ({ username: 'test' });
  reviewed.findReviewedFiles = async () => [{ source: 'naver', sha256: createHash('sha256').update(srt('second archive')).digest('hex') }];
  try {
    const { GET } = require('../src/app/api/anime/subtitles/local/route.ts');
    const { NextRequest } = require('next/server');
    const response = await GET(new NextRequest('http://localhost/api/anime/subtitles/local?mode=search&title=Same.zip&archivePath=naver_subtitles%2Fsecond%2FSame.zip'));
    const result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.subtitles.length, 0);
  } finally { auth.getSessionUser = original; reviewed.findReviewedFiles = originalFiles; }
});

test('a rejected legacy AniAll source does not return under the ZIP display name', async () => {
  const auth = require('../src/lib/auth.ts'); const original = auth.getSessionUser;
  const db = require('../src/lib/db.ts'); const originalRejections = db.getSubtitleRejections;
  auth.getSessionUser = async () => ({ username: 'test' });
  db.getSubtitleRejections = async () => [{ provider: 'aniall', sourceKey: 'https://aniall.tistory.com/123' }];
  try {
    const { GET } = require('../src/app/api/anime/subtitles/local/route.ts');
    const { NextRequest } = require('next/server');
    const response = await GET(new NextRequest('http://localhost/api/anime/subtitles/local?mode=search&title=RootSearch.zip.zip&archivePath=aniall_subtitles%2FRootSearch.zip.zip'));
    assert.equal(response.status, 200); assert.equal((await response.json()).subtitles.length, 0);
  } finally { auth.getSessionUser = original; db.getSubtitleRejections = originalRejections; }
});
