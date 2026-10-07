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

test("web WinPNG path opens original Kakao PNG and never exports raw JMK", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/tistoryWinPng.ts"), "utf8");
  assert.match(source, /node\.getAttribute\?\.\("data-url"\)/);
  assert.match(source, /node\.getAttribute\?\.\("data-phocus"\)/);
  assert.match(source, /blog\.kakaocdn\.net/);
  assert.match(source, /const response = await fetch\(url,/);
  assert.match(source, /"Referer": referer/);
  assert.match(source, /candidateOpenExpression\(png\.toString\("base64"\)\)/);
  assert.match(source, /inputUrl\.value = URL\.reset\(blob\)/);
  assert.match(source, /files = files\.filter\(\(file\) => \/\\\.\(\?:ass\|ssa\|smi\|srt\|vtt\|zip\)\$\/i\.test\(file\.path\)\)/);
  assert.doesNotMatch(
    source,
    /if \(!assUrl && !smiUrl\) await add\(originalName, anchor\.getAttribute\("data-href"\), false\)/,
  );
});

test("manual online creator confirmation still uses the shared blog extractor", () => {
  const route = fs.readFileSync(path.join(__dirname, "../src/app/api/anime/subtitles/route.ts"), "utf8");
  assert.match(route, /fetchCreatorSubtitle\(creatorName, website, targetTitle, sourceEpisode, 5000, ep\)/);
});

test("web WinPNG waits long enough for Raspberry Pi Jamaker conversion", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/tistoryWinPng.ts"), "utf8");
  const subtitlesSource = fs.readFileSync(path.join(__dirname, "../src/lib/subtitles.ts"), "utf8");
  assert.match(source, /Math\.min\(60000, Math\.max\(1000, deadline - Date\.now\(\)\)\)/);
  assert.match(source, /Math\.max\(45000, Math\.min\(options\.timeoutMs \?\? 75000, 90000\)\)/);
  assert.match(subtitlesSource, /Math\.max\(60000, Math\.min\(90000, timeoutMs \+ 70000\)\)/);
  assert.match(source, /\[Tistory WinPNG\] conversion did not finish/);
});

test("web WinPNG candidate scan matches downloader-style article attributes", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/tistoryWinPng.ts"), "utf8");
  assert.match(source, /root\.querySelectorAll\("\*"\)/);
  assert.match(source, /node\.getAttribute\?\.\("data-url"\)/);
  assert.match(source, /node\.getAttribute\?\.\("data-phocus"\)/);
  assert.match(source, /node\.getAttribute\?\.\("src"\)/);
  assert.match(source, /waitFor<Array<\{ src: string \}>>/);
});

test("failed WinPNG extraction is not warm-cached", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/tistoryWinPng.ts"), "utf8");
  assert.match(source, /if \(files\.length\) \{/);
  assert.match(source, /resultCache\.delete\(cacheKey\)/);
});

test("web WinPNG exposes Chromium startup stderr and allows slow Pi launch", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/lib/tistoryWinPng.ts"), "utf8");
  assert.match(source, /stdio: \["ignore", "ignore", "pipe"\]/);
  assert.match(source, /Math\.min\(20000, timeoutMs\)/);
  assert.match(source, /\[Tistory WinPNG\] Chromium startup failed/);
  assert.match(source, /stderr: detail \|\| "\(no Chromium stderr\)"/);
});

test("web WinPNG logs converted paths and episode-selection rejections", () => {
  const winpng = fs.readFileSync(path.join(__dirname, "../src/lib/tistoryWinPng.ts"), "utf8");
  const subtitles = fs.readFileSync(path.join(__dirname, "../src/lib/subtitles.ts"), "utf8");
  assert.match(winpng, /conversion rows collected/);
  assert.match(winpng, /playable files collected/);
  assert.match(winpng, /converted row rejected/);
  assert.match(subtitles, /subtitle candidate rejected by episode evidence/);
  assert.match(subtitles, /converted candidate not selected/);
});
