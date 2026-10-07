const ts = require("typescript");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test, after } = require("node:test");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(id, ...args) {
  return originalResolve.call(
    this,
    id.startsWith("@/") ? path.join(__dirname, "../src", id.slice(2)) : id,
    ...args,
  );
};

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
};
require.extensions[".ts"] = (module, file) => {
  module._compile(
    ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions }).outputText,
    file,
  );
};

const winPng = require("../src/lib/tistoryWinPng.ts");
const originalExtractor = winPng.extractTistoryWinPngFiles;
winPng.extractTistoryWinPngFiles = async () => [{
  path: "03화.ass",
  data: Buffer.from(
    "[Script Info]\nTitle: WinPNG web test\n[Events]\n"
    + "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    + "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,WinPNG web subtitle\n",
  ),
  generated: true,
}];

const subtitles = require("../src/lib/subtitles.ts");

after(() => {
  winPng.extractTistoryWinPngFiles = originalExtractor;
  Module._resolveFilename = originalResolve;
});

test("WinPNG extractor ignores non-Tistory URLs without launching Chromium", async () => {
  winPng.extractTistoryWinPngFiles = originalExtractor;
  assert.deepEqual(await winPng.extractTistoryWinPngFiles("https://example.com/post"), []);
  winPng.extractTistoryWinPngFiles = async () => [{
    path: "03화.ass",
    data: Buffer.from("[Script Info]\nTitle: WinPNG web test\n"),
    generated: true,
  }];
});

test("Tistory blog extraction falls back to generated WinPNG ASS", async () => {
  winPng.extractTistoryWinPngFiles = async () => [{
    path: "03화.ass",
    data: Buffer.from(
      "[Script Info]\nTitle: WinPNG web test\n[Events]\n"
      + "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
      + "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,WinPNG web subtitle\n",
    ),
    generated: true,
  }];

  const html = `
    <html><body>
      <h1 class="post-title">테스트 작품 3화</h1>
      <div class="tt_article_useless_p_margin contents_style">
        <img src="https://blog.kakaocdn.net/example/subtitle.png" />
      </div>
    </body></html>
  `;
  const result = await subtitles.extractSubtitleFromBlogPage(
    html,
    "https://sample.tistory.com/3",
    "테스트 제작자",
    3,
    null,
    1000,
    3,
  );

  assert.ok(result);
  assert.equal(result.format, "ASS");
  assert.equal(result.is_ass, true);
  assert.match(result.content, /WinPNG web subtitle/);
  assert.equal(result.sourceCreatorWebsite, "https://sample.tistory.com/3");
});

test("blog WinPNG extraction marks JMK dialogue previews as temporary VTT", async () => {
  winPng.extractTistoryWinPngFiles = async () => [{path: "03화.smi", generated: true, temporary: true,
    data: Buffer.from('<SAMI><BODY><SYNC Start=1000><P>preview dialogue<SYNC Start=2000><P>&nbsp;</BODY></SAMI>')}];
  const result = await subtitles.extractSubtitleFromBlogPage('<h1 class="post-title">테스트 3화</h1>',
    'https://sample.tistory.com/3','테스트 제작자',3,null);
  assert.equal(result.format,'VTT');assert.equal(result.temporary,true);
  assert.match(result.name,/임시/);assert.match(result.content,/preview dialogue/);
});

test("blog WinPNG chooses original SMI before ASS and complete files before JMK previews", async () => {
  const smi = Buffer.from('<SAMI><BODY><SYNC Start=1000><P>original SMI<SYNC Start=2000><P>&nbsp;</BODY></SAMI>');
  const ass = Buffer.from('[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,original ASS');
  winPng.extractTistoryWinPngFiles = async () => [
    {path:'03.ass',data:ass,generated:false},{path:'03.smi',data:smi,generated:false}];
  const extract=()=>subtitles.extractSubtitleFromBlogPage('<h1 class="post-title">테스트 3화</h1>',
    'https://sample.tistory.com/3','테스트 제작자',3,null);
  assert.match((await extract()).content,/original SMI/);
  winPng.extractTistoryWinPngFiles = async () => [
    {path:'03.smi',data:smi,generated:true,temporary:true},{path:'03.ass',data:ass,generated:false}];
  const complete=await extract();assert.equal(complete.format,'ASS');assert.equal(complete.temporary,false);
});

test("blog WinPNG has no Chromium launch or viewer fallback", () => {
  const source = fs.readFileSync(path.join(__dirname,'../src/lib/tistoryWinPng.ts'),'utf8');
  assert.doesNotMatch(source,/runChromiumQueued|CHROMIUM_BIN|decodeWithTistoryViewer|Runtime\.evaluate/);
  assert.match(source,/decodeLocalWinPng/);
});

test("web WinPNG logs local paths and episode-selection rejections", () => {
  const winpng = fs.readFileSync(path.join(__dirname, "../src/lib/tistoryWinPng.ts"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/subtitles.ts"), "utf8");
  assert.match(winpng, /local rows collected/);
  assert.match(winpng, /playable files collected/);
  assert.match(winpng, /local rows rejected/);
  assert.match(source, /subtitle candidate rejected by episode evidence/);
  assert.match(source, /converted candidate not selected/);
});

test("WinPNG episode selection prefers filename and falls back to nearest parent folder", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/subtitles.ts"), "utf8");
  assert.match(source, /pathParts\.slice\(0, -1\)\.reverse\(\)/);
  assert.match(source, /!fileEvidence\.episodes\.length && nearestFolderEvidence/);
  assert.match(source, /const outer = \[postEvidence, \.\.\.folderEvidence, fileEvidence\]/);
});

const movieWork = {titles: ['파리에 피는 에투알', 'パリに咲くエトワール', 'Paris ni Saku Étoile'], format: 'MOVIE'};
const movieSmi = Buffer.from('<SAMI><BODY><SYNC Start=1000><P>movie dialogue<SYNC Start=2000><P>&nbsp;</BODY></SAMI>');
function movieExtract(work = movieWork, title = '파리에 피는 에투알', sourceEpisode = 1, localEpisode = 1) {
  return subtitles.extractSubtitleFromBlogPage('<h1 class="post-title">' + title + '</h1>',
    'https://sample.tistory.com/763', '제작자', sourceEpisode, null, 1000, localEpisode, work);
}
test('confirmed movie selects one root preview without episode or parent folder', async () => {
  winPng.extractTistoryWinPngFiles = async () => [{
    path:'[Doomdos] - Paris ni Saku Etoile - [1080p U-NEXT WEB-DL].smi',
    data:movieSmi,generated:true,temporary:true,
  }];
  const result = await movieExtract();
  assert.equal(result.format,'VTT');assert.equal(result.temporary,true);
  assert.match(result.content,/movie dialogue/);
  assert.equal(await movieExtract(null),null);
  assert.equal(await movieExtract({...movieWork,format:'TV'}),null);
  assert.equal(await movieExtract(movieWork,'다른 영화'),null);
  assert.equal(await movieExtract(movieWork,'파리에 피는 에투알',13,1),null);
  assert.equal(await movieExtract(movieWork,'파리에 피는 에투알',2,2),null);
});
test('movie exception cannot override filename, nearest folder, range or multiple-file ambiguity', async () => {
  for (const paths of [['02.smi'],['2화/main.smi'],['1-2화/main.smi'],['first.smi','second.smi']]) {
    winPng.extractTistoryWinPngFiles = async () => paths.map(path => ({path,data:movieSmi,generated:false}));
    assert.equal(await movieExtract(),null, paths.join(','));
  }
  winPng.extractTistoryWinPngFiles = async () => [{path:'1화/main.smi',data:movieSmi,generated:false}];
  assert.ok(await movieExtract(null));
});
test('filename remains stronger than folder and nearest numbered parent supplies missing episode', async () => {
  winPng.extractTistoryWinPngFiles = async () => [{path:'1화/02.smi',data:movieSmi,generated:false}];
  assert.equal(await movieExtract(null),null);
  assert.ok(await movieExtract(null,'테스트 작품 2화',2,2));
  winPng.extractTistoryWinPngFiles = async () => [{path:'9화/1화/main.smi',data:movieSmi,generated:false}];
  assert.ok(await movieExtract(null));
});
test('movie exception supports a sole ordinary attachment and single-file ZIP but not multi-file ZIP', async () => {
  const originalFetch = global.fetch;
  const Zip = require('adm-zip');
  const html = '<h1 class="post-title">파리에 피는 에투알</h1><div class="entry-content"><a href="/movie.zip">movie.zip</a></div>';
  const extract = () => subtitles.extractSubtitleFromBlogPage(html,'https://sample.tistory.com/763','제작자',1,null,1000,1,movieWork);
  winPng.extractTistoryWinPngFiles = async () => [];
  try {
    global.fetch = async () => new Response(movieSmi, {headers:{'content-disposition':'attachment; filename="movie.smi"'}});
    assert.match((await extract()).content,/movie dialogue/);
    const zip = new Zip();zip.addFile('movie.smi',movieSmi);
    global.fetch = async () => new Response(zip.toBuffer());
    assert.match((await extract()).content,/movie dialogue/);
    zip.addFile('another.smi',movieSmi);
    assert.equal(await extract(),null);
  } finally { global.fetch = originalFetch; }
});
