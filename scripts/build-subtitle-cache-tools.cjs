// Compile the small shared modules for the Pi CLI; no TypeScript compiler is
// required in the production image and conversion stays identical to playback.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const out = path.join(__dirname, '../.subtitle-cache-tools');
fs.mkdirSync(out, {recursive: true});
for (const name of ['subtitleCodec', 'subtitleCache', 'subtitleEpisodes']) {
  const source = fs.readFileSync(path.join(__dirname, `../src/lib/${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText;
  fs.writeFileSync(path.join(out, `${name}.cjs`), compiled);
}
fs.copyFileSync(path.join(__dirname, 'cleanup-subtitle-cache.cjs'), path.join(out, 'cleanup.cjs'));
// Next bundles these packages into app chunks, so its standalone dependency
// tracing does not make them available to this separate Node entry point.
for (const name of ['adm-zip', 'iconv-lite', 'safer-buffer']) {
  const source = path.dirname(require.resolve(`${name}/package.json`));
  const destination = path.join(out, 'node_modules', name);
  fs.rmSync(destination, {recursive: true, force: true});
  fs.cpSync(source, destination, {recursive: true});
}
