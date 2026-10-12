import type { EpisodeStreamInfo } from './providers/types';

/** ReAnime already supplies its server URLs. Select a copy without changing its cached response. */
export function selectVideoServer(stream: EpisodeStreamInfo | null, key?: string): EpisodeStreamInfo | null {
  if (!stream || !key || stream.stream_type !== 'iframe') return stream;
  const server = stream.server_sources.find(source => source.key === key && source.player_url);
  if (!server) return stream;
  return { ...stream, embed_url: server.player_url, player_url: server.player_url,
    video_server: server.key, server_sources: [server, ...stream.server_sources.filter(source => source !== server)] };
}
