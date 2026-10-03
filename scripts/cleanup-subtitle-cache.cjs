#!/usr/bin/env node
// The weekly downloader queues exact new file paths. Only cache metadata is
// indexed; the historical subtitle corpus is never traversed or unpacked.
const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const {cacheRoot, subtitleContentHash, pruneVerifiedSubtitleCacheHashes} = require('./subtitleCache.cjs');
const {decodeSubtitleFile} = require('./subtitleCodec.cjs');
const {readEpisodeEvidence, selectEpisodeEntries} = require('./subtitleEpisodes.cjs');
const {readSubtitleSourceManifest,sourceDigestMatches}=require('./subtitleSourceManifest.cjs');
const validEpisode = value => Number.isSafeInteger(value) && value > 0 && value <= 10000;
const titleKey = value => String(value || '').normalize('NFKC').trim().toLowerCase();

async function cacheMetadata(root) {
  const rows = [], verified = path.join(root, 'verified');
  let works;
  try {
    if ((await fs.lstat(verified)).isSymbolicLink()) return [];
    works = await fs.readdir(verified, {withFileTypes: true});
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const work of works.filter(e => e.isDirectory())) {
    const base = path.join(verified, work.name);
    for (const episode of (await fs.readdir(base, {withFileTypes: true})).filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))) {
      const dir = path.join(base, episode.name);
      for (const name of (await fs.readdir(dir)).filter(n => /^[a-f\d]{64}\.json$/.test(n))) {
        try {
          const filename = path.join(dir, name), info = await fs.lstat(filename);
          if (!info.isFile() || info.size > 32768) continue;
          const metadata = JSON.parse(await fs.readFile(filename, 'utf8'));
          if (metadata.animeId && validEpisode(metadata.episodeNumber) && validEpisode(metadata.sourceEpisode)
              && encodeURIComponent(metadata.animeId).replaceAll('.', '%2E') === work.name
              && String(metadata.episodeNumber).padStart(4, '0') === episode.name) rows.push(metadata);
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      }
    }
  }
  return rows;
}

async function cleanupPending(root = cacheRoot()) {
  const pending = path.join(root, '.cache-cleanup-pending');
  let names;
  try { names = (await fs.readdir(pending)).filter(n => /^[a-f\d]{64}\.json$/.test(n)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return {jobs: 0, removed: 0, deferred: 0, filesRead: 0}; throw error; }
  const metadata = await cacheMetadata(root);
  let matching = {posts: {}};
  try { matching = JSON.parse(await fs.readFile(path.join(root, 'aniall-weekly-matching.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = {jobs: 0, removed: 0, deferred: 0, filesRead: 0};
  const realRoot = await fs.realpath(root);
  const sourceFiles=await readSubtitleSourceManifest(root);
  for (const name of names) {
    const jobPath = path.join(pending, name);
    try {
      const bytes = await fs.readFile(jobPath, 'utf8');
      const job = JSON.parse(bytes), item = job.item || {}, provider = item.source;
      if (!['aniall','anissia'].includes(provider) || !Array.isArray(job.files) || job.files.length > 500) throw new Error('Invalid cleanup job');
      const sourceId = String(provider === 'aniall' ? item.post_id || '' : item.anime_no || '');
      if (!/^[1-9]\d*$/.test(sourceId)) throw new Error('Invalid source identity');
      const match = matching.posts?.[sourceId];
      const candidates = metadata.filter(cache => cache.sourceProvider === provider && cache.sourceWorkId === sourceId
        && (provider !== 'aniall' || (match?.match_kind === 'exact' && titleKey(cache.matchedTitle) === titleKey(match.matched_title))));
      const scoped = [...new Map(candidates.map(c => [`${c.animeId}:${c.episodeNumber}:${c.sourceEpisode}:${c.season}`, c])).values()];
      const local = new Map(scoped.map(c => [c, new Set()]));
      const signatures = [];
      // No matching cached work: do not even open the newly downloaded ZIP.
      for (const relative of scoped.length ? job.files : []) {
        if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(p => ['..','.',''].includes(p))
            || !(relative.startsWith(`${provider}_subtitles/${sourceId}__`) || sourceFiles[relative]?.sources.some(s=>s.source===provider && s.id===sourceId))) throw new Error('Invalid file path');
        const filename = path.join(root, relative), resolved = await fs.realpath(filename);
        if (!resolved.startsWith(realRoot + path.sep)) throw new Error('File escaped subtitle storage');
        const info = await fs.stat(resolved);
        if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error('Unsupported file size');
        const isZip = /\.zip$/i.test(relative);
        if (!isZip && !/\.(ass|ssa|srt|smi|vtt)$/i.test(relative)) continue;
        if (!isZip && info.size > 2000000) continue;
        const data = await fs.readFile(resolved);if(!sourceDigestMatches(sourceFiles[relative],data))throw new Error('Downloaded file hash changed'); result.filesRead++;
        signatures.push({resolved, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino});
        const zip = isZip ? new AdmZip(data) : null;
        const entries = zip ? zip.getEntries().map(e => ({filename: e.entryName, entry: e}))
          .filter(e => !e.entry.isDirectory && e.entry.header.size <= 2000000 && /\.(ass|ssa|srt|smi|vtt)$/i.test(e.filename))
          : [{filename: path.basename(relative), entry: null}];
        if (zip && zip.getEntries().length > 5000) throw new Error('Too many archive members');
        const outer = [readEpisodeEvidence(item.anime_title || item.title || ''), readEpisodeEvidence(path.basename(relative), true)];
        if (provider === 'anissia') outer.push(readEpisodeEvidence(relative.split('/')[2] || ''));
        for (const cache of scoped) {
          const selected = selectEpisodeEntries(entries, {episode: cache.episodeNumber, sourceEpisode: cache.sourceEpisode, season: cache.season || 1}, outer);
          for (const entry of selected) {
            const subtitle = decodeSubtitleFile(entry.entry ? entry.entry.getData() : data, entry.filename);
            if (subtitle) local.get(cache).add(subtitleContentHash(subtitle));
          }
        }
      }
      for (const snapshot of signatures) {
        const current = await fs.stat(snapshot.resolved);
        if (['size','mtimeMs','ctimeMs','ino'].some(key => snapshot[key] !== current[key])) throw new Error('Downloaded file changed during comparison');
      }
      let removed = 0;
      for (const [cache, hashes] of local) removed += await pruneVerifiedSubtitleCacheHashes(cache.animeId, cache.episodeNumber, hashes, root, true);
      result.removed += removed;
      // Changed/requeued jobs and read errors remain pending for a later run.
      if (await fs.readFile(jobPath, 'utf8') !== bytes) throw new Error('Cleanup job changed while processing');
      await fs.appendFile(path.join(root, 'cache-cleanup-results.jsonl'), JSON.stringify({id: job.id, removed, files: job.files,
        checkedAt: new Date().toISOString()}) + '\n');
      await fs.unlink(jobPath); result.jobs++;
    } catch (error) { result.deferred++; console.warn('[Cache cleanup deferred]', name, error.message); }
  }
  return result;
}

module.exports = {cleanupPending};
if (require.main === module) cleanupPending().then(result => {
  console.log(JSON.stringify(result)); if (result.deferred) process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
