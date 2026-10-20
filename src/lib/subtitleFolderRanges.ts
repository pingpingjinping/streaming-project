import { readEpisodeEvidence } from "./subtitleEpisodes";

/** A playback episode slice mapped onto one subtitle season inside a folder. */
export interface SubtitleFolderRangeMapping {
  startEpisode: number;
  subtitleEpisode: number;
  season: number;
}

/** A later range replaces the earlier range automatically. */
export function activeSubtitleFolderRange<T extends SubtitleFolderRangeMapping>(
  ranges: readonly T[], episode: number,
): T | null {
  return ranges.filter(item => item.startEpisode <= episode)
    .reduce<T | null>((latest, item) =>
      !latest || item.startEpisode > latest.startEpisode ? item : latest, null);
}

export function subtitleEpisodeForRange(mapping: SubtitleFolderRangeMapping, episode: number): number | null {
  const localEpisode = episode - mapping.startEpisode + mapping.subtitleEpisode;
  return Number.isSafeInteger(localEpisode) && localEpisode >= 1 && localEpisode <= 10000
    && episode >= mapping.startEpisode ? localEpisode : null;
}

/**
 * Never treat a parenthesized absolute episode in "S02E01 (050)" as season-local
 * episode 50. Explicit season and local-episode evidence are both required.
 * Parent directories such as S02/01.srt are supported as well.
 */
export function matchingSubtitleFolderRangePaths(
  paths: readonly string[], mapping: SubtitleFolderRangeMapping, episode: number,
): string[] {
  const expected = subtitleEpisodeForRange(mapping, episode);
  if (expected === null) return [];
  return paths.filter(filename => {
    const evidence = readEpisodeEvidence(filename, true);
    return !evidence.conflict && !evidence.multipleSeasons
      && evidence.season === mapping.season && evidence.episodes.includes(expected);
  });
}
