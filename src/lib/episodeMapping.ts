import type { EpisodeItem } from "./providers/types";

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

/** Reviewed split: Final Stage is BEATLESS episodes 21-24.
 * https://beatless-anime.jp/news/detail_0912_1.php
 * Exact source IDs avoid inferring a split from titles or episode counts.
 */
export function defaultSubtitleEpisodeStart(animeId: string): number | null {
  return ["ani_1346", "re_beatless-final-stage-tmwejf"].includes(animeId) ? 21 : null;
}

export function reviewedVideoStart(animeId: string, videoId: string): number | null {
  if (["ani_1346", "re_beatless-final-stage-tmwejf"].includes(animeId) &&
      ["re_beatless-final-stage-tmwejf", "ak_beatless-final-stage-6exh5"].includes(videoId)) return 1;
  return null;
}

export function reviewedReanimeProjection(animeId: string) {
  return animeId.replace(/^re_/, "") === "beatless-final-stage-tmwejf"
    ? { sourceId: "beatless-yd63yf", start: 21, end: 24, title: "비트레스 Final Stage" } : null;
}

export function reviewedAnikotoRanges(animeId: string) {
  if (["ani_1205", "re_beatless-yd63yf"].includes(animeId)) return [
    { anikoto_id: "beatless-hy0tv", mapping_kind: "range", anikoto_episode_start: 1, anikoto_episode_end: 20, target_episode_start: 1, target_episode_end: 20 },
    { anikoto_id: "beatless-final-stage-6exh5", mapping_kind: "range", anikoto_episode_start: 1, anikoto_episode_end: 4, target_episode_start: 21, target_episode_end: 24 },
  ];
  if (["ani_1346", "re_beatless-final-stage-tmwejf"].includes(animeId)) return [
    { anikoto_id: "beatless-final-stage-6exh5", mapping_kind: "range", anikoto_episode_start: 1, anikoto_episode_end: 4, target_episode_start: 1, target_episode_end: 4 },
  ];
  return [];
}

/** Preserve actual video numbers/titles and apply only a verified season offset. */
export function videoEpisodeList<T extends { number: number; title: string }>(
  episodes: T[], startEpisode: number | null | undefined,
  targetSeason: number | null, sourceSeason: number | null, seasonEpisodeCount?: number,
): T[] {
  const start = videoEpisodeStart(episodes.map(e => e.number), startEpisode, targetSeason, sourceSeason, seasonEpisodeCount);
  if (start === null) return [];
  return episodes.flatMap(episode => {
    const local = toLocalEpisode(episode.number, start);
    if (local === null || (start > 1 && seasonEpisodeCount && local > seasonEpisodeCount)) return [];
    return [{ ...episode, number: local, title: episode.title?.replace(/^\d+화(?=\s|$)/, `${local}화`) || `${local}화` }];
  }).sort((a, b) => a.number - b.number);
}

/** Provider rows define navigation; caption rows only supply subtitle metadata. */
export function attachEpisodeCaptions(videoEpisodes: EpisodeItem[], captions: EpisodeItem[]): EpisodeItem[] {
  const byNumber = new Map(captions.map(e => [e.number, e]));
  return videoEpisodes.map(episode => {
    const caption = byNumber.get(episode.number);
    return { ...episode, caption_url: caption?.caption_url, creator_name: caption?.creator_name };
  });
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
