const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const ts = require('typescript');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-audit-test-'));
const subtitleRoot = path.join(root, 'subtitles');
const auditRoot = path.join(root, 'audit');
fs.mkdirSync(path.join(subtitleRoot, 'anissia_subtitles', '헬 모드 2기'), {recursive: true});
fs.mkdirSync(path.join(subtitleRoot, 'uploads', 'someone'), {recursive: true});
fs.mkdirSync(auditRoot, {recursive: true});
fs.writeFileSync(path.join(subtitleRoot, 'anissia_subtitles', '헬 모드 2기', '01.srt'), '1\n00:00:01,000 --> 00:00:02,000\nhello');
fs.writeFileSync(path.join(subtitleRoot, 'uploads', 'someone', 'private.srt'), 'private');
fs.writeFileSync(path.join(auditRoot, 'manifest.json'), '{"schema_version":1,"files":{}}');
fs.writeFileSync(path.join(root, 'outside.srt'), 'private outside');
fs.symlinkSync(path.join(root, 'outside.srt'), path.join(subtitleRoot, 'anissia_subtitles', '헬 모드 2기', 'link.srt'));
fs.symlinkSync(path.join(root, 'outside.srt'), path.join(auditRoot, 'catalog_snapshot.sqlite'));
after(() => fs.rmSync(root, {recursive: true, force: true}));

const code = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../src/lib/workAuditAccess.ts'), 'utf8'),
  {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}},
).outputText;
const x = {exports: {}, require, process: {env: {SUBTITLE_STORAGE_DIR: subtitleRoot, WORK_AUDIT_DIR: auditRoot}},
  console, Buffer};
vm.runInNewContext(code, x);
const api = x.exports;

test('only specific provider paths and subtitle/archive extensions can be downloaded', () => {
  for (const value of [
    '../secrets.env', 'uploads/someone/private.srt', 'naver_subtitles/../../private.srt',
    'anissia_subtitles/.secrets/.env.zip', 'anissia_subtitles/folder/../01.srt',
    '/anissia_subtitles/01.srt', 'anissia_subtitles\\01.srt', 'anissia_subtitles/dir/file.png',
    'anissia_subtitles/dir/file.srt\nx', 'anissia_subtitles/dir/file.srt\0',
  ]) assert.equal(api.parseAuditFilePath(value), null, value);
  assert.ok(api.parseAuditFilePath('anissia_subtitles/헬 모드 2기/01.srt'));
  assert.ok(api.parseAuditFilePath('naver_subtitles/sub/01.zip'));
});

test('resolves real subtitle within provider but rejects private files and symlink escapes', async () => {
  const ok = await api.resolveAuditSubtitleFile('anissia_subtitles/헬 모드 2기/01.srt');
  assert.equal(ok.size > 0, true);
  assert.equal(await api.resolveAuditSubtitleFile('anissia_subtitles/헬 모드 2기/link.srt'), null);
  assert.equal(await api.resolveAuditSubtitleFile('uploads/someone/private.srt'), null);
});

test('only fixed, nonsymlink snapshot names can be downloaded', async () => {
  const good = await api.resolveAuditSnapshotFile('manifest.json');
  assert.equal(good.name, 'manifest.json');
  assert.equal(await api.resolveAuditSnapshotFile('../.env'), null);
  assert.equal(await api.resolveAuditSnapshotFile('catalog_snapshot.sqlite'), null);
});
