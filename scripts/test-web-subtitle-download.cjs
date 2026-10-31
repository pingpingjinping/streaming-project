const ts = require('typescript'), Module = require('node:module');
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { test, after, afterEach } = require('node:test');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, ...args) {
  return resolve.call(this, id.startsWith('@/') ? path.join(__dirname, '../src', id.slice(2)) : id, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
delete process.env.DATABASE_URL;
const { extractSubtitleFromBlogPage, fetchCreatorSubtitle } = require('../src/lib/subtitles.ts');
const { downloadSubtitleFile } = require('../src/lib/subtitleDownload.ts');
const { naverScriptAttachments } = require('../src/lib/subtitleBlogPage.ts');
const AdmZip = require('adm-zip');
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
after(() => { Module._resolveFilename = resolve; });
const srt = Buffer.from('1\n00:00:01,000 --> 00:00:03,000\ncorrect subtitle\n');
const file = 'https://download.blog.naver.com/open/token/signature/03.srt';
const naver = 'https://blog.naver.com/PostView.naver?blogId=author&logNo=12345';
const driveId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const drive = 'https://drive.google.com/file/d/' + driveId + '/view';
const direct = 'https://drive.usercontent.google.com/download?id=' + driveId + '&export=download';
const share = 'https://app.box.com/s/publicshare';
const zip = () => { const z = new AdmZip(); z.addFile('03.srt', srt); z.addFile('04.srt', Buffer.from('wrong')); return z.toBuffer(); };
function network(handler) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const result = await handler(String(url), options);
    assert.ok(result, 'Unexpected network request: ' + url);
    return result;
  };
  return calls;
}
function attachment(filename = '03.srt', bytes = srt) {
  const disposition = /[^\u0000-\u00ff]/.test(filename)
    ? "attachment; filename*=UTF-8''" + encodeURIComponent(filename) : 'attachment; filename="' + filename + '"';
  return new Response(bytes, { headers: { 'content-disposition': disposition } });
}
function boxPage({ type = 'file', filename = '작품 03.zip', allowed = true } = {}) {
  return '<script>Box.prefetchedData = ' + JSON.stringify({ preview_metadata: {
    type, id: '123456789', name: filename, permissions: { can_download: allowed },
  } }) + '; Box.postStreamData = ' + JSON.stringify({ '/app-api/enduserapp/shared-item': {
    sharedName: 'publicshare', itemID: 123456789, itemType: type,
  } }) + ';</script>';
}

test('Naver desktop navigation tables cannot hide an actual SmartEditor attachment', async () => {
  const calls = network(url => url === file ? attachment() : null);
  const html = `<title>테스트 작품 3화</title><table class="post-body"><a href="#">전체보기</a></table>
    <aside><a href="https://example.com/03.srt">unrelated</a></aside>
    <table class="post-body"><div class="se-main-container"><a href="${file}">파일 다운로드</a></div></table>`;
  const result = await extractSubtitleFromBlogPage(html, naver, '하루하루', 3, null);
  assert.match(result?.content || '', /correct subtitle/);
  assert.deepEqual(calls.map(c => c.url), [file]);
});

test('a blocked desktop Naver post falls back to its matching mobile post', async () => {
  const calls = network(url => {
    if (url === naver) return new Response('Forbidden', { status: 403 });
    if (url === naver.replace('://blog.', '://m.blog.')) return new Response(
      `<title>테스트 작품 3화</title><div class="se-main-container"><a href="${file}">파일 다운로드</a></div>`);
    if (url === file) return attachment();
  });
  const result = await fetchCreatorSubtitle('하루하루', 'https://blog.naver.com/author/12345', '테스트 작품', 3);
  assert.ok(result?.content.includes('correct subtitle'));
  assert.deepEqual(calls.map(c => c.url), [naver, naver.replace('://blog.', '://m.blog.'), file]);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
});

test('Naver multi-post layouts select the requested post rather than the first editor', async () => {
  const calls = network(url => url === file ? attachment() : null);
  const html = `<title>테스트 작품 3화</title><div id="post-view99999"><div class="se-main-container">
    <a href="https://example.com/03.srt">다른 게시물</a></div></div>
    <div id="post-view12345"><div class="se-main-container"><a href="${file}">3화</a></div></div>`;
  assert.ok((await extractSubtitleFromBlogPage(html, naver, '제작자', 3, null))?.content.includes('correct subtitle'));
  assert.deepEqual(calls.map(c => c.url), [file]);
});

test('Naver script-only attachments stay in the current post and keep their filenames', async () => {
  const rows = (index, logNo, filename, url) => `aPostFiles[${index}] = JSON.parse('${JSON.stringify([
    { encodedAttachFileName: filename, encodedAttachFileUrl: url },
  ])}'.replace(/\\'/g, '')); aPostBaseInfo[${index}] = "${logNo}|0|1";`;
  const html = `<title>테스트 작품 3화</title><div id="postViewArea">본문</div><script>`
    + rows(1, '99999', '04.srt', 'https://example.com/04.srt')
    + rows(2, '12345', '03.srt', file) + '</script>';
  const calls = network(url => url === file ? attachment() : null);
  const result = await extractSubtitleFromBlogPage(html, naver, '제작자', 3, null);
  assert.ok(result?.content.includes('correct subtitle'));
  assert.deepEqual(calls.map(c => c.url), [file]);
  assert.deepEqual(naverScriptAttachments(html, 'https://example.com/post'), []);
});

test('Naver script fallback cannot resurrect conflicting labels with a fresh signed URL', async () => {
  const scriptFile = file.replace('/open/token/', '/open/new-token/');
  const html = `<title>테스트 작품 3화</title><div id="postViewArea"><a href="${file}">4화 자막</a></div>
    <script>aPostFiles[1] = JSON.parse('${JSON.stringify([
      { encodedAttachFileName: '03.srt', encodedAttachFileUrl: scriptFile },
    ])}'.replace(/\\'/g, ''));</script>`;
  const calls = network(() => { throw new Error('Conflicting candidate must not download'); });
  assert.equal(await extractSubtitleFromBlogPage(html, naver, '제작자', 3, null), null);
  assert.equal(calls.length, 0);
});

function warning(action = 'https://drive.usercontent.google.com/download', id = driveId) {
  return `<html><form method="get" action="${action}">
    <input type="hidden" name="id" value="${id}"><input type="hidden" name="export" value="download">
    <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="public-confirmation">
    </form></html>`;
}
test('HTTP 200 Drive confirmation forms lead to the subtitle, preserving UUID and one deadline', async () => {
  const calls = network(url => url === direct ? new Response(warning()) : attachment());
  const result = await downloadSubtitleFile(drive, {}, 12000);
  assert.deepEqual(result?.buffer, srt);
  assert.equal(result.filename, '03.srt');
  assert.equal(new URL(calls[1].url).searchParams.get('uuid'), 'public-confirmation');
  assert.equal(calls[0].options.signal, calls[1].options.signal);
});

test('Drive confirmation does not retain the external blog Referer that repeats the warning', async () => {
  const calls = network((url, options) => {
    if (url === direct || options.headers.Referer) return new Response(warning());
    return attachment();
  });
  const result = await downloadSubtitleFile(drive, { Referer: 'https://subtitle.blogspot.com/post',
    'Accept-Language': 'ko-KR', Accept: 'text/html' }, 12000);
  assert.deepEqual(result?.buffer, srt);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Accept, '*/*');
  assert.equal(calls[1].options.headers.Referer, undefined);
});

test('legacy Drive confirmation links and non-OK direct-download fallbacks remain supported', async () => {
  const calls = network(url => {
    if (url === direct) return new Response('', { status: 403 });
    if (url.startsWith('https://docs.google.com/uc?')) return new Response(
      `<html><a id="uc-download-link" href="https://drive.google.com/uc?id=${driveId}&amp;export=download&amp;confirm=next">download</a></html>`);
    return attachment();
  });
  assert.deepEqual((await downloadSubtitleFile(drive, {}, 12000))?.buffer, srt);
  assert.equal(calls.length, 3);
});

test('Drive access pages, cross-file confirmations and off-domain form actions are refused', async () => {
  for (const html of ['<html>Request access</html>', warning(undefined, 'bbbbbbbbbbbbbbbbbbbbbbbbbb'),
    warning('https://example.com/download'), warning('https://drive.usercontent.google.com.evil.test/download')]) {
    const calls = network(() => new Response(html));
    assert.equal(await downloadSubtitleFile(drive, {}, 12000), null);
    assert.equal(calls.length, 1);
  }
});

test('a looping Drive warning is bounded and cannot become subtitle text', async () => {
  const calls = network(() => new Response(warning()));
  assert.equal(await downloadSubtitleFile(drive, {}, 12000), null);
  assert.equal(calls.length, 2);
});

test('Box single-file shares download once and select only the requested ZIP episode', async () => {
  const calls = network(url => url === share ? new Response(boxPage()) : attachment('작품 03.zip', zip()));
  const result = await fetchCreatorSubtitle('자막기계', share, '테스트 작품', 3);
  assert.ok(result?.content.includes('correct subtitle'));
  assert.equal(result.orig_filename, '03.srt');
  assert.equal(calls.length, 2);
  const url = new URL(calls[1].url);
  assert.equal(url.origin, 'https://app.box.com');
  assert.equal(url.searchParams.get('file_id'), 'f_123456789');
  assert.equal(url.searchParams.get('shared_name'), 'publicshare');
});

test('a blog Box link is discoverable even without a filename in its label', async () => {
  network(url => url === share ? new Response(boxPage()) : attachment('작품 03.zip', zip()));
  const result = await extractSubtitleFromBlogPage(
    `<title>테스트 작품 3화</title><div class="post-body"><a href="${share}">Box</a></div>`,
    'https://subtitle.blogspot.com/2026/10/3.html', '제작자', 3, null);
  assert.ok(result?.content.includes('correct subtitle'));
});

test('Box metadata cannot authorize a different response episode', async () => {
  network(url => url === share ? new Response(boxPage()) : attachment('04.srt'));
  assert.equal(await fetchCreatorSubtitle('자막기계', share, '테스트 작품', 3), null);
});

test('Box folders, denied downloads, mismatched file IDs and sign-in pages do not download', async () => {
  for (const html of [boxPage({ type: 'folder' }), boxPage({ allowed: false }), '<html>Sign in</html>']) {
    const calls = network(() => new Response(html));
    assert.equal(await downloadSubtitleFile(share, {}, 12000), null);
    assert.equal(calls.length, 1);
  }
  const calls = network(() => new Response(boxPage()));
  assert.equal(await downloadSubtitleFile(share + '/file/987654321', {}, 12000), null);
  assert.equal(calls.length, 1);
});

test('cloud filenames preserve Korean header bytes and RFC 5987 filenames', async () => {
  network(() => attachment(Buffer.from('작품 03.srt').toString('latin1')));
  assert.equal((await downloadSubtitleFile(direct, {}, 12000))?.filename, '작품 03.srt');
  network(() => new Response(srt, { headers: { 'content-disposition': "attachment; filename=x; filename*=UTF-8''" + encodeURIComponent('작품 03.srt') } }));
  assert.equal((await downloadSubtitleFile(direct, {}, 12000))?.filename, '작품 03.srt');
});

test('oversized cloud downloads are refused before reading the body', async () => {
  network(() => new Response(srt, { headers: { 'content-length': String(33 * 1024 * 1024) } }));
  assert.equal(await downloadSubtitleFile(drive, {}, 12000), null);
});

test('SAMI remains playable when the attachment host declares text/html', async () => {
  const smi = '<SAMI><BODY><SYNC Start=1000><P>correct subtitle<SYNC Start=3000><P>&nbsp;</BODY></SAMI>';
  network(() => new Response(smi, { headers: { 'content-type': 'text/html' } }));
  assert.equal((await downloadSubtitleFile(direct, {}, 12000))?.buffer.toString(), smi);
});
