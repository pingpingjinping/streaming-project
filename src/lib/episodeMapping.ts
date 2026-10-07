/** UI/history numbers are local to a season; subtitle source numbers may be cumulative. */
export function toSourceEpisode(localEpisode: number, startEpisode?: number | null): number {
  return localEpisode + (Number.isInteger(startEpisode) && startEpisode! > 0 ? startEpisode! - 1 : 0);
}

export function toLocalEpisode(sourceEpisode: number, startEpisode?: number | null): number | null {
  const local = sourceEpisode - toSourceEpisode(1, startEpisode) + 1;
  return Number.isInteger(local) && local > 0 ? local : null;
}

/** Metadata counts are already season-local. Never subtract the offset from a count. */
export function localEpisodeCount(sourceEpisodes: Iterable<number>, startEpisode?: number | null, fallbackCount = 12): number {
  const local = [...sourceEpisodes].map(ep => toLocalEpisode(ep, startEpisode)).filter((ep): ep is number => ep !== null);
  // Earlier-season captions must not manufacture episodes for this season.
  if (local.length) return Math.max(...local);
  return Math.max(1, fallbackCount);
}

/**
 * Subtitle offsets are hints, not unconditional video offsets. A season-labelled
 * page with episode 1 uses local numbering. A page with no season label needs
 * an explicit start to distinguish a combined source from season 1. Explicit
 * reviewed provider ranges are resolved before this helper.
 */
export function videoEpisodeStart(
  sourceEpisodes: number[], startEpisode: number | null | undefined,
  targetSeason: number | null, sourceSeason: number | null, seasonEpisodeCount?: number,
): number | null {
  const start = toSourceEpisode(1, startEpisode);
  if (targetSeason && sourceSeason && targetSeason !== sourceSeason) return null;
  if (start === 1) {
    // A sequel must not silently fall back to an unlabelled first-season page.
    return targetSeason && targetSeason > 1 && !sourceSeason ? null : 1;
  }
  if (sourceSeason && sourceEpisodes.includes(1)) return 1;
  if (sourceSeason || !sourceEpisodes.includes(1)) {
    return sourceEpisodes.length && sourceEpisodes.every(ep => ep >= start) ? start : null;
  }
  // The boundary must be present and numbering must extend beyond this
  // season's local span. A partially uploaded combined source is still usable;
  // do not require its season finale to be uploaded before playing episode 1.
  const last = Math.max(...sourceEpisodes);
  const requiredEnd = seasonEpisodeCount ? Math.max(start, seasonEpisodeCount + 1) : start + 1;
  return sourceEpisodes.includes(start) && last >= requiredEnd ? start : null;
}

export function mapVideoEpisode(
  localEpisode: number, sourceEpisodes: number[], startEpisode?: number | null,
  targetSeason: number | null = null, sourceSeason: number | null = null, seasonEpisodeCount?: number,
): number | null {
  if (!Number.isInteger(localEpisode) || localEpisode < 1 || (seasonEpisodeCount && localEpisode > seasonEpisodeCount)) return null;
  const start = videoEpisodeStart(sourceEpisodes, startEpisode, targetSeason, sourceSeason, seasonEpisodeCount);
  if (start === null) return null;
  const source = toSourceEpisode(localEpisode, start);
  return sourceEpisodes.includes(source) ? source : null;
}
