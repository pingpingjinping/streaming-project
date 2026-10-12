import type { AnimeDetail, EpisodeItem } from './providers/types';
import { getAnikotoPlaybackCandidates } from './anikotoLinks';
import { anikotoProvider } from './providers/anikoto';

/** Use explicit reviewed source ranges; never derive a connection from titles. */
export async function reviewedProviderPlayback(
  anime: AnimeDetail,
  requestedSource?: string,
): Promise<AnimeDetail> {
  if (!(anime.id.startsWith('re_') || anime.id.startsWith('ani_')) ||
      (requestedSource && requestedSource !== 'anikoto') ||
      (!requestedSource && anime.video_available !== false)) return anime;
  try {
    const candidates = (await getAnikotoPlaybackCandidates(anime.id, 1, true))
      .filter(row => ['manual', 'reviewed', 'multi_reviewed', 'automatic'].includes(row.linkStatus));
    // Choose one source playlist, not a mixture of different releases.
    for (const candidate of candidates.slice(0, 3)) {
      const detail = await anikotoProvider.getAnimeDetail(candidate.animeId);
      if (!detail?.sub_episodes?.length) continue;
      if (candidate.linkStatus === 'automatic') {
        const { matchesVideoPlaybackIdentity } = await import('./resolvers/videoResolver');
        const aliases = anime.identity_titles?.length ? anime.identity_titles : [anime.title, anime.original_title || ''];
        if (!matchesVideoPlaybackIdentity(detail, aliases, anime.anilist_id || null, false)) continue;
      }
      const episodes: EpisodeItem[] = [];
      for (const sourceEpisode of detail.sub_episodes) {
        if (!sourceEpisode.watch_url || !Number.isInteger(sourceEpisode.number) || sourceEpisode.number < 1) continue;
        // The selected player's entire native playlist owns navigation.
        const number = sourceEpisode.number;
        const workNumber = candidate.mappingKind === 'whole' ? number
          : candidate.sourceStart !== undefined && candidate.targetStart !== undefined && candidate.targetEnd !== undefined
            ? candidate.targetStart + number - candidate.sourceStart : null;
        const subtitleEpisode = workNumber !== null && (candidate.mappingKind === 'whole' ||
          (workNumber >= (candidate.targetStart ?? Infinity) && workNumber <= (candidate.targetEnd ?? -Infinity))) ? workNumber : null;
        const caption = anime.sub_episodes.find(e => e.number === subtitleEpisode);
        episodes.push({ ...sourceEpisode, number,
          subtitle_episode: subtitleEpisode, caption_url: caption?.caption_url, creator_name: caption?.creator_name,
          title: sourceEpisode.title?.replace(/^\d+화/, `${number}화`) || `${number}화`,
          watch_url: `/watch/${anime.id}/${number}?video_source=anikoto` });
      }
      if (!episodes.some(row => row.number === 1)) continue;
      const unique = [...new Map(episodes.map(row => [row.number, row])).values()]
        .sort((a, b) => a.number - b.number);
      return { ...anime, sub_episodes: unique, dub_episodes: [], total_episodes: unique.length,
        video_available: true, playback_source: 'anikoto' };
    }
  } catch (error) {
    console.warn('[reviewedProviderPlayback] Alternate playlist unavailable:', error);
  }
  return anime;
}
