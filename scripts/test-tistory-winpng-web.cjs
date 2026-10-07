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
