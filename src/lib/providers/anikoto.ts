import { chromiumFetch } from '@/lib/chromiumFetch';
import type { Provider, AnimeSearchResult, EpisodeSource, EpisodeStream } from './types';

export class AnikotoProvider implements Provider {
  readonly id = 'anikoto';
  readonly name = 'Anikoto';
  private baseUrl = 'https://anikoto.com'; // 베이스 도메인 (설정 연동 가능)

  /**
   * 영문/로마자 키워드로 애니메이션 검색
   */
  async search(keyword: string): Promise<AnimeSearchResult[]> {
    try {
      const url = `${this.baseUrl}/api/search?q=${encodeURIComponent(keyword)}`;
      const res = await chromiumFetch(url);
      
      if (!res.ok) {
        // API 엔드포인트 실패 시 HTML 검색 폴백
        return await this.searchHtmlFallback(keyword);
      }

      const json = await res.json();
      if (!Array.isArray(json.data)) return [];

      return json.data.map((item: any) => ({
        id: String(item.id || item.slug),
        title: item.title?.english || item.title?.romaji || item.title || '',
        thumbnail: item.poster || item.image || '',
        latestEpisode: item.episodesCount ? String(item.episodesCount) : undefined,
        provider: this.id,
      }));
    } catch (e) {
      console.error(`[Anikoto] search failed:`, e);
      return [];
    }
  }

  private async searchHtmlFallback(keyword: string): Promise<AnimeSearchResult[]> {
    const searchUrl = `${this.baseUrl}/filter?keyword=${encodeURIComponent(keyword)}`;
    const res = await chromiumFetch(searchUrl);
    const html = await res.text();

    const results: AnimeSearchResult[] = [];
    // 정규식으로 카드 아이템 매핑
    const cardRegex = /<a href="\/watch\/([^"]+)"[^>]*>[\s\S]*?<img src="([^"]+)"[\s\S]*?<h3[^>]*>([^<]+)<\/h3>/g;
    let match;

    while ((match = cardRegex.exec(html)) !== null) {
      results.push({
        id: match[1],
        title: match[3].trim(),
        thumbnail: match[2],
        provider: this.id,
      });
    }

    return results;
  }

  /**
   * 해당 작품의 에피소드 목록 조회
   */
  async getEpisodes(animeId: string): Promise<EpisodeSource[]> {
    try {
      const res = await chromiumFetch(`${this.baseUrl}/watch/${animeId}`);
      const html = await res.text();

      const episodes: EpisodeSource[] = [];

      // 페이지 내부 episode 목록 DOM 또는 JSON 파싱
      // 예: data-number="1" data-id="12345" 패턴
      const epRegex = /data-number="([^"]+)"\s+data-id="([^"]+)"/g;
      let match;

      while ((match = epRegex.exec(html)) !== null) {
        episodes.push({
          episodeNumber: parseFloat(match[1]),
          episodeId: match[2],
          title: `EP ${match[1]}`,
        });
      }

      // DOM에 직접 안 잡히는 경우 기본 1화 폴백
      if (episodes.length === 0) {
        episodes.push({
          episodeNumber: 1,
          episodeId: `${animeId}-ep-1`,
          title: 'EP 1',
        });
      }

      return episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
    } catch (e) {
      console.error(`[Anikoto] getEpisodes failed:`, e);
      return [];
    }
  }

  /**
   * 특정 에피소드의 비디오 소스(iframe 주소 또는 m3u8) 취득
   */
  async getStream(episodeId: string): Promise<EpisodeStream | null> {
    try {
      // 비디오 서버 정보 호출
      const res = await chromiumFetch(`${this.baseUrl}/api/servers?epId=${encodeURIComponent(episodeId)}`);
      
      let embedUrl = '';
      if (res.ok) {
        const json = await res.json();
        // MegaCloud, Vidstreaming, StreamWish 우선 순위 선택
        const server = json.servers?.find((s: any) => 
          ['megacloud', 'streamwish', 'vidstreaming'].includes(s.name.toLowerCase())
        ) || json.servers?.[0];

        embedUrl = server?.embedUrl || server?.src || '';
      }

      if (!embedUrl) {
        // API 미지원 시 watch 페이지 내부 iframe 추출
        const pageRes = await chromiumFetch(`${this.baseUrl}/watch/${episodeId}`);
        const html = await pageRes.text();
        const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"/i);
        embedUrl = iframeMatch ? iframeMatch[1] : '';
      }

      if (!embedUrl) return null;

      // iframe 형태 반환 (IframePlayer에서 바로 구동)
      return {
        type: 'iframe',
        url: embedUrl,
        headers: {
          Referer: this.baseUrl,
        },
      };
    } catch (e) {
      console.error(`[Anikoto] getStream failed:`, e);
      return null;
    }
  }
}
