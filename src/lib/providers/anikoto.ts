import { chromiumFetch } from "@/lib/chromiumFetch";
import { toAnikotoId, stripAnikotoId } from "./ids";
import type { AnimeProvider } from "./types";

const BASE_URL = "https://anikoto.to";

export const anikotoProvider: AnimeProvider = {
  name: "anikoto",

  async search(keyword: string) {
    try {
      const searchUrl = `${BASE_URL}/filter?keyword=${encodeURIComponent(keyword)}`;
      const res = await chromiumFetch(searchUrl);

      if (!res.ok) {
        return [];
      }

      const html = await res.text();
      const results: any[] = [];

      const itemRegex = /<a[^>]+href="\/watch\/([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[\s\S]*?<h3[^>]*>([^<]+)<\/h3>/gi;
      let match: RegExpExecArray | null;

      while ((match = itemRegex.exec(html)) !== null) {
        const rawId = match[1].replace(/^\/watch\//, "").trim();
        const thumbnail = match[2];
        const title = match[3].trim();

        results.push({
          id: toAnikotoId(rawId),
          title,
          thumbnail,
          provider: "anikoto",
        });
      }

      if (results.length === 0) {
        const fallbackRegex = /href="\/watch\/([^"?#]+)"[^>]*title="([^"]+)"/gi;
        while ((match = fallbackRegex.exec(html)) !== null) {
          results.push({
            id: toAnikotoId(match[1]),
            title: match[2].trim(),
            provider: "anikoto",
          });
        }
      }

      return results;
    } catch (e) {
      console.error("[anikotoProvider] search error:", e);
      return [];
    }
  },

  async getEpisodes(animeId: string) {
    try {
      const realId = stripAnikotoId(animeId);
      const watchUrl = `${BASE_URL}/watch/${realId}`;
      const res = await chromiumFetch(watchUrl);

      if (!res.ok) return [];

      const html = await res.text();
      const episodes: any[] = [];

      const epRegex = /data-number="([^"]+)"\s+data-id="([^"]+)"/gi;
      let match: RegExpExecArray | null;

      while ((match = epRegex.exec(html)) !== null) {
        const epNum = parseFloat(match[1]);
        episodes.push({
          episodeNumber: isNaN(epNum) ? 1 : epNum,
          episodeId: toAnikotoId(match[2]),
          title: `EP ${match[1]}`,
        });
      }

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

      return episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
    } catch (e) {
      console.error("[anikotoProvider] getEpisodes error:", e);
      return [];
    }
  },

  async getStream(episodeId: string) {
    try {
      const realEpId = stripAnikotoId(episodeId);
      let embedUrl = "";

      try {
        const apiRes = await chromiumFetch(`${BASE_URL}/api/servers?epId=${encodeURIComponent(realEpId)}`);
        if (apiRes.ok) {
          const json = await apiRes.json();
          const server = json.servers?.find((s: any) =>
            ["megacloud", "streamwish", "vidstreaming"].includes(s.name?.toLowerCase())
          ) || json.servers?.[0];

          embedUrl = server?.embedUrl || server?.src || "";
        }
      } catch {}

      if (!embedUrl) {
        const pageRes = await chromiumFetch(`${BASE_URL}/watch/${realEpId}`);
        if (pageRes.ok) {
          const html = await pageRes.text();
          const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"/i);
          if (iframeMatch) {
            embedUrl = iframeMatch[1];
          }
        }
      }

      if (!embedUrl) return null;

      if (embedUrl.startsWith("//")) {
        embedUrl = `https:${embedUrl}`;
      } else if (embedUrl.startsWith("/")) {
        embedUrl = `${BASE_URL}${embedUrl}`;
      }

      return {
        type: "iframe",
        url: embedUrl,
        headers: {
          Referer: BASE_URL,
        },
      };
    } catch (e) {
      console.error("[anikotoProvider] getStream error:", e);
      return null;
    }
  },
};
