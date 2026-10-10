import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { convertCloudflareSearchResponse } from "@/lib/cloudflareSearchResponse";

/**
 * Same-origin authenticated proxy for the public, read-only Cloudflare D1
 * search Worker. Keeps browser CORS out of the equation and never scans the
 * Pi's PostgreSQL database for the optional supplemental search.
 */
const SEARCH_ENDPOINT = "https://anime-search-api.pingpingjinping.workers.dev/search";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const q = (params.get("q") || "").trim();
  const rawPage = params.get("page") || "1";
  if (!q || q.length > 100 || !/^\d{1,3}$/.test(rawPage)) {
    return NextResponse.json({ error: "Invalid search query" }, { status: 400 });
  }
  const page = Number(rawPage);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) {
    return NextResponse.json({ error: "Invalid search page" }, { status: 400 });
  }

  const upstream = new URL(SEARCH_ENDPOINT);
  upstream.searchParams.set("q", q);
  upstream.searchParams.set("page", String(page));

  try {
    const response = await fetch(upstream, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error("Cloudflare search HTTP " + response.status);
    const data = await response.json();
    const result = convertCloudflareSearchResponse(data, page, params.get("captions") === "1");
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.warn("[Cloudflare supplementary anime search]", error);
    return NextResponse.json(
      { error: "Cloudflare 추가 DB 검색에 실패했습니다." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
