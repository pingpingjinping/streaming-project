import { fetchCreatorSubtitle, resolveKoreanTitle } from './subtitles';

/** Subtitles are also loaded by the player; a slow blog must not delay video navigation. */
export function preloadPlaybackSubtitle(creator: string, url: string, title: string,
  sourceEpisode: number, episode: number, animeId: string) {
  let timer: ReturnType<typeof setTimeout>;
  const subtitle = resolveKoreanTitle(title).then(resolved => fetchCreatorSubtitle(
    creator || '제작자', url, resolved || title, sourceEpisode, 4000, episode, animeId,
  )).catch(() => null);
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 250); });
  return Promise.race([subtitle, deadline]).finally(() => clearTimeout(timer));
}
