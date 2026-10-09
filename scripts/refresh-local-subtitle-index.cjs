// Production-safe CLI for the Pi weekly sync. Uses the same index builder
// as the admin refresh button and keeps the web search data consistent.
const {refreshLocalSubtitleNameIndex} = require('./localSubtitleNameIndex.cjs');
const path = require('node:path');

(async () => {
  const root = process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), 'data', 'subtitles');
  const started = Date.now();
  const total = await refreshLocalSubtitleNameIndex(root);
  console.log('[Local subtitle name index] refreshed', {
    entries: total,
    elapsed_ms: Date.now() - started,
    root,
  });
})().catch(error => {
  console.error('[Local subtitle name index] refresh failed:', error);
  process.exitCode = 1;
});
