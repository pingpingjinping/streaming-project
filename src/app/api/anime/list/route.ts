import {getLinkedReanimeCatalog} from "@/lib/linkedReanimeCatalog";
import { searchManualSubtitleLinks, mergeManualSubtitleSearchResults } from "@/lib/manualSubtitleSearch";
import { getKoreanSubtitleCatalog } from '@/lib/koreanSubtitleCatalog';
import { NextRequest, NextResponse } from "next/server";
import {
  getProvider,
  LINKKF_GENRES,
  LINKKF_YEARS,
  LINKKF_TYPES,
  REANIME_GENRES,
} from "@/lib/providers";
import { OHLI24_GENRES } from "@/lib/providers/ohli24";
import type { AnimeListResponse } from "@/lib/providers/types";
import { getSessionUser } from "@/lib/auth";
import { getAnissiaCatalogCaptionsOnly } from "@/lib/db";
import { ANIKOTO_GENRES, ANIKOTO_YEARS, ANIKOTO_TYPES, ANIKOTO_STATUSES, ANIKOTO_SORTS } from "@/lib/anikotoCatalog";

export async function GET(request: NextRequest) {
  // 보안: 미인증 사용자가 서버를 무료 스크레이퍼로 악용하는 것을 방지
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const source = searchParams.get("source") || "anissia";
  const provider = getProvider(source);

  const q = searchParams.get("q")?.trim() || "";
  const tab = searchParams.get("tab") || "airing";
  const page = parseInt(searchParams.get("page") || "1", 10) || 1;
  const section = searchParams.get("section") || "2";
  const genre = searchParams.get("genre") || "";
  const year = searchParams.get("year") || "";
  const typeLang = searchParams.get("type") || "";
  const period = (searchParams.get("period") || "day") as "day" | "week" | "month" | "all";

  let result: AnimeListResponse;
  if(source==="reanime" && searchParams.get("linked")==="1") {
    result=await getLinkedReanimeCatalog({q,page,year,sort:searchParams.get("sort") || "year_desc"});
  } else if (source === 'anissia' && (q || tab === 'list')) {
    const captionsOnly = searchParams.has('captions')
      ? searchParams.get('captions') === '1' : await getAnissiaCatalogCaptionsOnly(user.username);
    result = await getKoreanSubtitleCatalog({ q, page, genre, year, captionsOnly, sort: searchParams.get('sort') || 'year_desc' });
    // The staged client fallback must surface genuine DB errors instead of
    // silently calling the upstream API again.
    if (result.error && searchParams.get('db_only') !== '1') {
      const fallback = q
        ? await provider.searchAnime(q, page).catch(() => result)
        : await provider.getAnimeListFiltered({ catalog: true, genre, year, page, captionsOnly }).catch(() => result);
      result = { ...fallback, error: result.error };
    }
  } else if (source === "anikoto") {
    const filters = { genre, year, typeLang, status: searchParams.get("status") || "", sort: searchParams.get("sort") || "default" };
    result = q ? await provider.searchAnime(q, page, filters) : await provider.getAnimeListFiltered({ ...filters, page });
  } else if (q) {
    result = await provider.searchAnime(q, page);
  } else if (source === "reanime") {
    const category = (
      tab === "trending"
        ? "trending"
        : tab === "top"
        ? "top"
        : tab === "upcoming"
        ? "upcoming"
        : tab === "finished"
        ? "finished"
        : "airing"
    ) as "airing" | "top" | "upcoming" | "finished" | "trending";
    result = await provider.getAnimeList({ category, page, genre });
  } else if (tab === "list") {
    const captionsOnly = source === "anissia"
      ? searchParams.has("captions")
        ? searchParams.get("captions") === "1"
        : await getAnissiaCatalogCaptionsOnly(user.username)
      : false;
    result = await provider.getAnimeListFiltered({ section, genre, year, typeLang, page,
      ...(source === "anissia" ? { catalog: true, captionsOnly } : {}),
    });
  } else if (tab === "top") {
    result = await provider.getAnimeList({ category: "top", page, period });
  } else {
    // Default 'airing'
    result = await provider.getAnimeListFiltered({ section: "2", page, category: "airing" });
  }

  // The client-side Anissia DB fallback must also see Pi-only manual links,
  // including matches absent from the Cloudflare release snapshot.
  if (source === "anissia" && q && searchParams.get("db_only") === "1" && page === 1) {
    const local = await searchManualSubtitleLinks(q);
    if (local.length) {
      result = { ...result, items: mergeManualSubtitleSearchResults(result.items, local) };
    }
  }

  const noCache = searchParams.get("nocache") === "1";
  const cacheControl =
    noCache || q || result.error || searchParams.get("linked")==="1" || (source === "anissia" && tab === "list")
      ? "no-store"
      : "public, s-maxage=300, stale-while-revalidate=600";

  const isReanime = source === "reanime";
  const isOhli24 = source === "ohli24";
  const isAnikoto = source === "anikoto";
  return NextResponse.json(
    {
      ...result,
      source,
      tab,
      filters: {
        genres: isAnikoto ? ANIKOTO_GENRES : isReanime ? REANIME_GENRES : isOhli24 ? OHLI24_GENRES : LINKKF_GENRES,
        years: isAnikoto ? ANIKOTO_YEARS : isOhli24 || isReanime ? [] : LINKKF_YEARS,
        types: isAnikoto ? ANIKOTO_TYPES : isOhli24 || isReanime ? [] : LINKKF_TYPES,
        ...(isAnikoto ? { statuses: ANIKOTO_STATUSES, sorts: ANIKOTO_SORTS } : {}),
      },
    },
    {
      headers: {
        "Cache-Control": cacheControl,
      },
    }
  );
}

