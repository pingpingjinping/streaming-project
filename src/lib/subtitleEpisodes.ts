import { implicitSequelSeason, numberedSequelEpisode } from "./subtitleTitleSeason";

/** Episode evidence is kept separate from title similarity and release priority. */
export interface EpisodeEvidence {
  episodes: number[];
  season: number | null;
  multipleSeasons: boolean;
  range: boolean;
  conflict: boolean;
  seasonRelative: boolean;
  seasonEpisodePair: boolean;
}

export interface EpisodeRequest {
  episode: number; // Episode on this work's page.
  sourceEpisode: number; // Explicit start-episode setting, applied exactly once.
  season: number | null;
}

const valid = (n: number) => Number.isInteger(n) && n > 0 && n <= 10000;
const unique = (values: number[]) => [...new Set(values)];

export function readEpisodeEvidence(value: string, filename = false, filePath = filename): EpisodeEvidence {
  const normalized = value.normalize('NFKC').replace(/__\d+(?=\.(?:zip|ass|ssa|srt|smi|vtt)$)/i,'').replace(/\b\d+(?:\.\d+)?\s*(?:KB|MB|GB)\b/gi, '').replace(/\.(?:zip|ass|ssa|srt|smi|vtt)(?=\s|$)/gi, '');
  // URL IDs, calendar dates, hashes, resolution and codec numbers are not episodes.
  const text = normalized.replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, ' ')
    .replace(/\b(?:480|576|720|1080|1440|2160)[pi]?\b|\b[Hx]26[45]\b|\b\d+bit\b/gi, ' ')
    .replace(/\[[a-f\d]{8}\]/gi, ' ');
  const parts = filePath ? text.split(/[\\/]/) : [text];
  const base = parts[parts.length - 1].replace(/\.(?:ass|ssa|srt|smi|vtt|zip)$/i, '');
  // Compact S101 means season 1, episode 01; longer ambiguous numbers stay unknown.
  const compact=[...base.matchAll(/(?:^|[^a-z\d])s([1-9])(\d{2})(?=$|[^a-z\d])/gi)];
  // Use the same title/episode interpretation as the release-track matcher.
  const sequelFile = filename && /\.(?:ass|ssa|smi|srt|vtt)$/i.test(value.trim())
    ? numberedSequelEpisode(base) : null;
  // Specials such as SP2E01 use their own season/episode numbering.
  const specialPairs = [...base.matchAll(/(?:^|[^a-z\d])sp\s*0*(\d{1,2})\s*e\s*0*(\d{1,4})(?!\d)/gi)];
  const namedSeasonPairs = sequelFile
    ? [{ 1: String(sequelFile.season), 2: String(sequelFile.episode) }]
    : [];
  const seasons = unique([
    ...compact,
    ...specialPairs,
    ...namedSeasonPairs,
    ...text.matchAll(/(?:^|[^a-z\d])(?:season|시즌|s)\s*0*(\d{1,2})(?=$|[^\d])/gi),
    ...text.matchAll(/(?:제|第)?\s*(\d{1,2})\s*(?:기|期)/g),
    ...text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/gi),
  ].map(m => Number(m[1])).filter(valid));
  // A loose subtitle named "S1 - 01" is season 1, episode 1, not a
  // season 1–1 archive. Identify this before testing season ranges.
  // Keep "Season 1-4.zip" and "S1-S2" as multi-season bundles.
  const dashedPairs = filename && /\.(?:ass|ssa|srt|smi|vtt)$/i.test(value.trim())
    ? [...base.matchAll(/(?:^|[^a-z\d])s\s*0*(\d{1,2})\s*[-–]\s*0*(\d{1,3})(?!\d)/gi)]
    : [];
  const seasonRangeText = dashedPairs.length
    ? text.replace(/(?:^|[^a-z\d])s\s*0*\d{1,2}\s*[-–]\s*0*\d{1,3}(?!\d)/gi, ' ')
    : text;
  const multipleSeasons = seasons.length > 1 || /(?:\d+\s*[-~, ]\s*)+\d+\s*기/.test(seasonRangeText)
    || /(?:^|[^a-z\d])(?:season|시즌|s)\s*\d+\s*[-~]\s*\d+/i.test(seasonRangeText);
  const paired = [...compact, ...specialPairs, ...namedSeasonPairs, ...base.matchAll(/(?:^|[^a-z\d])s\s*0*(\d{1,2})\s*e\s*0*(\d{1,4})(?!\d)/gi), ...dashedPairs];
  const episodes: number[] = paired.map(m => Number(m[2]));
  // The "2 - 02" token is a season/episode pair, NOT the range 2-2.
  // Remove its episode digits from subsequent generic range detection.
  const withoutNamedSequelEpisode = sequelFile
    ? base.slice(0,sequelFile.episodeStart) + ' ' + base.slice(sequelFile.episodeEnd) : base;
  let clean = (dashedPairs.length ? withoutNamedSequelEpisode.replace(/(?:^|[^a-z\d])s\s*0*\d{1,2}\s*[-–]\s*0*\d{1,3}(?!\d)/gi, ' ') : withoutNamedSequelEpisode)
    .replace(/(?:season|시즌|s)\s*\d+\s*[-~]\s*(?:season|시즌|s)?\s*\d+/gi, ' ').replace(/(?:\d+\s*[-~, ]\s*)+\d+\s*기/g, ' ').replace(/(?:^|[^a-z\d])(?:s|sp)\s*\d{1,2}\s*e\s*\d{1,4}(?!\d)/gi, ' ')
    .replace(/(?:season|part|cour|시즌|파트)\s*\d+|\bS\d+\b|\d+\s*(?:기|期)|\b\d+(?:st|nd|rd|th)\b/gi, ' ');
  let range = false;
  clean = clean.replace(/(?:^|[^\p{L}\d])(\d{1,4})\s*(?:-|~|～|to)\s*(\d{1,4})(?!\d)/giu, (all, a, b) => {
    const first = Number(a), last = Number(b);
    if (valid(first) && valid(last) && last >= first && last - first <= 1000) {
      range = true;
      for (let ep = first; ep <= last; ep++) episodes.push(ep);
      return ' ';
    }
    return all;
  });
  const rangeEpisodes = [...episodes];
  for (const pattern of [
    /(?:^|[^a-z\d])(?:episode|ep|e|#)\s*0*(\d{1,4})(?!\d)/gi,
    /(?:제|第\s*)?0*(\d{1,4})\s*(?:화|회|편|話)(?![가-힣])/g,
  ]) clean = clean.replace(pattern, (_all, n) => { episodes.push(Number(n)); return ' '; });
  if (!episodes.length) {
    // Bare numbers need a filename/label boundary; never take digits in Moozzi2,
    // a year, a Drive ID, or a season token as the episode.
    const bracket = filename ? [...clean.matchAll(/\[\s*0*(\d{1,3})\s*\]/g)] : [];
    episodes.push(...bracket.map(m => Number(m[1])));
    const tail = clean.match(/(?:^|[\s_\-])0*(\d{1,3})(?:v\d+|[._-]?[A-Za-z]{1,3}|[\s._-]+(?:ns|s|tv))?\s*(?:END|완결|끝)?\s*(?:\([^)]*\)|\[[^\]]*\])*\s*$/i);
    if (tail) episodes.push(Number(tail[1]));
    // Some subtitle sets number episodes as "Title S1 (1).smi". Only use
    // a trailing parenthesis when the filename has no stronger episode token;
    // in "Title - 12 (1).srt", (1) can be a downloaded-copy suffix.
    if (filename && !episodes.length && /\.(?:ass|ssa|srt|smi|vtt)$/i.test(value.trim())) {
      const parenthesized = clean.match(/\(\s*0*(\d{1,3})\s*\)\s*$/);
      if (parenthesized) episodes.push(Number(parenthesized[1]));
    }
  }
  const numbers = unique(episodes.filter(valid));
  return {
    episodes: numbers, season: seasons.length === 1 && !multipleSeasons ? seasons[0] : null,
    multipleSeasons, range, conflict: (!range && numbers.length > 1) || (range && numbers.some(n => !rangeEpisodes.includes(n))),
    seasonRelative: paired.length > 0 || (filename && seasons.length === 1),
    seasonEpisodePair: paired.length > 0,
  };
}

/** A work's terminal numeric sequel title is not episode 2 of the work. */
export function readWorkTitleEvidence(title: string): EpisodeEvidence {
  const evidence = readEpisodeEvidence(title);
  const season = implicitSequelSeason(title);
  if (!season) return evidence;
  if (evidence.episodes.length === 1 && evidence.episodes[0] === season
      && !evidence.multipleSeasons && !evidence.range && !evidence.conflict) {
    return {...evidence, episodes: [], season, seasonRelative: false};
  }
  return evidence;
}

export function evidenceAgrees(evidence: EpisodeEvidence, request: EpisodeRequest): boolean {
  if (evidence.conflict) return false;
  if (evidence.season && request.season && evidence.season !== request.season) return false;
  const episode = evidence.seasonRelative && evidence.season === request.season
    ? request.episode : request.sourceEpisode;
  return !evidence.episodes.length || evidence.episodes.includes(episode)
    || (evidence.seasonRelative && !evidence.seasonEpisodePair && evidence.season === request.season
      && evidence.episodes.includes(request.sourceEpisode));
}

export function selectEpisodeEntries<T extends { filename: string }>(
  entries: T[], request: EpisodeRequest, outer: EpisodeEvidence[] = [], allowUnnumbered = false,
): T[] {
  if (outer.some(e => !evidenceAgrees(e, request))) return [];
  const parsed = entries.map(entry => ({ entry, evidence: readEpisodeEvidence(entry.filename, true) }));
  const seasons = unique(parsed.flatMap(({ evidence }) => evidence.season ? [evidence.season] : []));
  if (!request.season && (seasons.length > 1 || outer.some(e => e.multipleSeasons))) return [];
  const explicitOffset = request.sourceEpisode !== request.episode;
  const scopedSeason = outer.some(e => e.season === request.season && !e.multipleSeasons);
  const combined = seasons.length > 1 || outer.some(e => e.multipleSeasons);
  const exactOuter = outer.some(e => e.episodes.length === 1 && evidenceAgrees(e, request));
  const selected = parsed.filter(({ evidence }) => {
    if (!evidenceAgrees(evidence, request) || evidence.multipleSeasons || evidence.range) return false;
    if (!evidence.season && !explicitOffset && (combined || ((request.season || 1) > 1 && !scopedSeason))) return false;
    if (evidence.episodes.length === 1) return true;
    return entries.length === 1 && !evidence.conflict && (exactOuter || allowUnnumbered);
  });
  // With an offset, Season 2/01 and Season 2/13 are competing numbering schemes,
  // not two release variants. Require a manual choice instead of choosing file order.
  if (new Set(selected.map(({ evidence }) => evidence.episodes.join(','))).size > 1) return [];
  return selected.map(({ entry }) => entry);
}

/** Read a real filename only, never a numeric post URL or an opaque download ID. */
export function subtitleFilenameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of ['filename', 'fileName', 'name']) {
      const name = url.searchParams.get(key);
      if (name && /\.(?:zip|ass|ssa|srt|smi|vtt)$/i.test(name)) return name;
    }
    const name = decodeURIComponent(url.pathname.split('/').pop() || '');
    return /\.(?:zip|ass|ssa|srt|smi|vtt)$/i.test(name) ? name : '';
  } catch { return value; }
}
