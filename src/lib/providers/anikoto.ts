import { chromiumFetch } from '@/lib/chromiumFetch';
import { toAnikotoId, stripAnikotoId } from './ids';
import type { Provider, AnimeSearchResult, EpisodeSource, EpisodeStream } from './types';

export class AnikotoProvider implements Provider {
  readonly id = 'anikoto';
  readonly name = 'Anikoto';
  // Anikoto 메인 도메인 (설정/프록시 연동 가능)
  private baseUrl = 'https://anikoto.to';

  /**
   * 영문 / 로마자 키워드로 애니 검색
   */
  async search(keyword: string): Promise<AnimeSearchResult[]> {
    try {
      const searchUrl = `${this.baseUrl}/filter?keyword=${encodeURIComponent(keyword)}`;
      const res = await chromiumFetch(searchUrl);
      
      if (!res.ok) {
        console.warn(`[Anikoto] search failed with status ${res.status}`);
        return [];
      }

      const html = await res.text();
      const results: AnimeSearchResult[] = [];

      // Anikoto 카드 아이템 파싱 정규식
      // <a href="/watch/{id}" ...> ... <img src="{thumbnail}" ...> ... <h3>{title}</h3>
      const itemRegex = /<a[^>]+href="\/watch\/([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[\s\S]*?<h3[^>]*>([^<]+)<\/h3>/gi;
      let match: RegExpExecArray | null;

      while ((match = itemRegex.exec(html)) !== null) {
        const rawId = match[1].replace(/^\/watch\//, '').trim();
        const thumbnail = match[2];
        const title = match[3].trim();

        results.push({
          id: toAnikotoId(rawId), // 프로젝트 내부 ID 접두사 'ak_' 부착
          title,
          thumbnail,
          provider: this.id,
        });
      }

      // 정규식 매칭이 안 잡힐 경우 대체 카드 링크 파싱 폴백
      if (results.length === 0) {
        const fallbackRegex = /href="\/watch\/([^"?#]+)"[^>]*title="([^"]+)"/gi;
        while ((match = fallbackRegex.exec(html)) !== null) {
          results.push({
            id: toAnikotoId(match[1]),
            title: match[2].trim(),
            provider: this.id,
          });
        }
      }

      return results;
    } catch (e) {
      console.error(`[Anikoto] search error:`, e);
      return [];
    }
  }

  /**
   * 에피소드 회차 목록 조회
   * @param animeId - 'ak_' 접두사가 붙어 있는 내부 ID
   */
  async getEpisodes(animeId: string): Promise<EpisodeSource[]> {
    try {
      const realId = stripAnikotoId(animeId); // 사이트 요청용 실제 ID 추출
      const watchUrl = `${this.baseUrl}/watch/${realId}`;
      const res = await chromiumFetch(watchUrl);

      if (!res.ok) return [];

      const html = await res.text();
      const episodes: EpisodeSource[] = [];

      // 1. 에피소드 data-number, data-id 속성 추출
      const epRegex = /data-number="([^"]+)"\s+data-id="([^"]+)"/gi;
      let match: RegExpExecArray | null;

      while ((match = epRegex.exec(html)) !== null) {
        const epNum = parseFloat(match[1]);
        episodes.push({
          episodeNumber: isNaN(epNum) ? 1 : epNum,
          episodeId: toAnikotoId(match[2]), // 회차 ID도 ak_ 접두사 부여
          title: `EP ${match[1]}`,
        });
      }

      // 2. data 속성이 없고 a href="/watch/{slug}?ep={epNumber}" 형태인 경우 폴백
      if (episodes.length === 0) {
        const hrefRegex = /href="\/watch\/[^"?#]+\?ep=([0-9.]+)"[^>]*>([^<]*)/gi;
        while ((match = hrefRegex.exec(html)) !== null) {
          const epNum = parseFloat(match[1]);
          episodes.push({
            episodeNumber: isNaN(epNum) ? 1 : epNum,
            episodeId: toAnikotoId(`${realId}?ep=${match[1]}`),
            title: match[2].trim() || `EP ${match[1]}`,
          });
        }
      }

      // 회차 번호 기준 오름차순 정렬
      return episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
    } catch (e) {
      console.error(`[Anikoto] getEpisodes error:`, e);
      return [];
    }
  }

  /**
   * 에피소드 스트리밍 소스(iframe 주소) 반환
   * @param episodeId - 'ak_' 접두사가 붙어 있는 에피소드 식별자
   */
  async getStream(episodeId: string): Promise<EpisodeStream | null> {
    try {
      const realEpId = stripAnikotoId(episodeId);
      let embedUrl = '';

      // 1. 서버 정보 JSON API 조회 시도
      try {
        const apiRes = await chromiumFetch(`${this.baseUrl}/api/servers?epId=${encodeURIComponent(realEpId)}`);
        if (apiRes.ok) {
          const json = await apiRes.json();
          // MegaCloud, Vidstreaming, StreamWish 우선 선택
          const server = json.servers?.find((s: any) =>
            ['megacloud', 'streamwish', 'vidstreaming'].includes(s.name?.toLowerCase())
          ) || json.servers?.[0];

          embedUrl = server?.embedUrl || server?.src || '';
        }
      } catch {
        // API 요청 실패 시 아래 DOM 폴백 진행
      }

      // 2. watch 페이지 내부 iframe 직접 추출 폴백
      if (!embedUrl) {
        const pageRes = await chromiumFetch(`${this.baseUrl}/watch/${realEpId}`);
        if (pageRes.ok) {
          const html = await pageRes.text();
          const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"/i);
          if (iframeMatch) {
            embedUrl = iframeMatch[1];
          }
        }
      }

      if (!embedUrl) return null;

      // 상대 경로로 시작할 경우 절대 경로로 보정
      if (embedUrl.startsWith('//')) {
        embedUrl = `https:${embedUrl}`;
      } else if (embedUrl.startsWith('/')) {
        embedUrl = `${this.baseUrl}${embedUrl}`;
      }

      return {
        type: 'iframe',
        url: embedUrl,
        headers: {
          Referer: this.baseUrl,
        },
      };
    } catch (e) {
      console.error(`[Anikoto] getStream error:`, e);
      return null;
    }
  }
}
