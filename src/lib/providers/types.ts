export interface AnimeListItem {
  id: string;
  title: string;
  original_title?: string;
  // Provider identity, independent of a bundled translated display title.
  identity_titles?: string[];
  anilist_id?: number;
  poster: string;
  detail_url: string;
  remarks: string;
  rank?: number | null;
  // 부가 메타데이터 필드 (애니시아 허브 및 통합 뷰 지원)
  rating?: number | null;
  time?: string | null;
  caption_count?: number | null;
  genres?: string[];
  latest_ep?: string | null;
  creator_name?: string | null;
  caption_url?: string | null;
  status?: string | null;
  source_name?: string;
  // Omitted when not checked; does not guarantee that a linked stream is online.
  video_link_status?: "linked" | "unlinked";
}

export interface AnimeListResponse {
  items: AnimeListItem[];
  page: number;
  has_next: boolean;
  total_pages: number;
  // False when only a prefix of a merged search has been loaded.
  total_pages_exact?: boolean;
  error?: string;
}

export interface EpisodeItem {
  number: number;
  title: string;
  watch_url: string;
  caption_url?: string;
  creator_name?: string;
  // A video's corresponding subtitle work episode; null is outside that work.
  subtitle_episode?: number | null;
}

export interface AnimeDetail {
  id: string;
  title: string;
  identity_titles?: string[];
  anilist_id?: number;
  poster: string;
  description: string;
  genres: string[];
  sub_episodes: EpisodeItem[];
  dub_episodes: EpisodeItem[];
  total_episodes: number;
  status_text: string;
  year: string;
  is_finished: boolean;
  banner?: string;
  rating?: number | null;
  caption_count?: number;
  original_title?: string;
  video_available?: boolean;
  playback_source?: 'rean' | 'anikoto' | 'linkkf' | 'ohli24';
}

export interface ServerSource {
  key?: string;
  label: string;
  player_url: string;
  id?: "rean" | "anikoto" | "linkkf" | "ohli24";
}

export interface EpisodeStreamInfo {
  success: boolean;
  video_server?: string;
  source_anime_id?: string;
  source_episode_number?: number;
  video_source?: "rean" | "anikoto" | "linkkf" | "ohli24";
  video_episodes?: EpisodeItem[];
  m3u8_url: string;
  vtt_url: string;
  player_url: string;
  embed_url?: string;
  stream_type?: "m3u8" | "iframe";
  server_sources: ServerSource[];
  link_next: string;
  link_pre: string;
  vod_data?: Record<string, unknown>;
  max_available_ep?: number;
  unsupported_reason?: string;
}

export interface AnimeListFilterParams {
  section?: string;
  genre?: string;
  year?: string;
  typeLang?: string;
  page?: number;
  period?: "day" | "week" | "month" | "all";
  category?: "recent_caption" | "airing" | "top" | "movie" | "finished" | "trending" | "upcoming";
  catalog?: boolean;
  captionsOnly?: boolean;
  sort?: string;
  status?: string;
  day?: number | string;
}

export interface AnimeProvider {
  readonly name: "linkkf" | "ohli24" | "reanime" | "anissia" | "anikoto";
  readonly displayName: string;
  getBaseUrl(): Promise<string>;
  getAnimeListFiltered(params: AnimeListFilterParams): Promise<AnimeListResponse>;
  getAnimeList(params: {
    category?: "recent_caption" | "airing" | "top" | "movie" | "finished" | "trending" | "upcoming";
    page?: number;
    genre?: string;
    period?: "day" | "week" | "month" | "all";
    sort?: string;
    day?: number | string;
  }): Promise<AnimeListResponse>;
  searchAnime(keyword: string, page?: number, options?: Pick<AnimeListFilterParams, "year" | "sort" | "genre" | "typeLang" | "status">): Promise<AnimeListResponse>;
  getAnimeDetail(animeId: string, options?: {
    subtitleEpisodeStart?: number | null;
    videoSource?: "rean" | "anikoto" | "linkkf" | "ohli24";
  }): Promise<AnimeDetail | null>;
  getEpisodeStream(watchUrl: string, options?: { serverKey?: string; allowServerFallback?: boolean }): Promise<EpisodeStreamInfo | null>;
}


