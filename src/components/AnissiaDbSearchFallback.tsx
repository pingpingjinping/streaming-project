"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import AnimeCard from "./AnimeCard";
import { filterSupplementalDbItems } from "@/lib/anissiaSearchStages";
import type { AnimeListItem, AnimeListResponse } from "@/lib/providers/types";

type LookupState = "idle" | "loading" | "done" | "error";

/**
 * If the fast Anissia search is empty, automatically fall back to the DB.
 * Otherwise, let the visitor opt in after the initial cards are on screen,
 * avoiding a slow DB read on the critical search-rendering path.
 */
export default function AnissiaDbSearchFallback({
  keyword, captionsOnly, initialPage, upstreamItems,
}: {
  keyword: string;
  captionsOnly: boolean;
  initialPage: number;
  upstreamItems: Pick<AnimeListItem, "id" | "detail_url">[];
}) {
  const automatic = upstreamItems.length === 0;
  const [started, setStarted] = useState(automatic);
  const [page, setPage] = useState(automatic ? initialPage : 1);
  const [result, setResult] = useState<AnimeListResponse | null>(null);
  const [status, setStatus] = useState<LookupState>(automatic ? "loading" : "idle");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!started) return;
    const controller = new AbortController();
    setStatus("loading");
    setResult(null);
    const params = new URLSearchParams({
      q: keyword,
      page: String(page),
      captions: captionsOnly ? "1" : "0",
    });
    // No upstream hits: keep the existing automatic Pi DB fallback.
    // Optional "추가 DB 검색" button: query only the Cloudflare D1 Worker.
    const endpoint = automatic
      ? "/api/anime/list?" + new URLSearchParams({
          source: "anissia",
          tab: "list",
          q: keyword,
          page: String(page),
          captions: captionsOnly ? "1" : "0",
          db_only: "1",
        }).toString()
      : "/api/anime/search-cloudflare?" + params.toString();
    fetch(endpoint, {
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async response => {
        if (!response.ok) throw new Error("DB request failed: " + response.status);
        return response.json() as Promise<AnimeListResponse>;
      })
      .then(data => {
        if (controller.signal.aborted) return;
        if (data.error) throw new Error(data.error);
        setResult(data);
        setStatus("done");
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.warn("[Anissia DB search]", error);
        setStatus("error");
      });
    return () => controller.abort();
  }, [started, automatic, keyword, captionsOnly, page, retry]);

  if (status === "idle") {
    return (
      <section className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-purple-500/20 bg-slate-900/60 px-5 py-4">
        <p className="text-sm text-slate-300">Cloudflare 검색 DB에서 애니시아 · AniAll · 네이버블로그 연결 작품을 추가로 찾아볼 수 있어.</p>
        <button type="button" onClick={() => setStarted(true)}
          className="rounded-xl border border-purple-500/40 bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-purple-500">
          추가 DB 검색
        </button>
      </section>
    );
  }

  if (status === "loading") {
    return (
      <div role="status" aria-live="polite" className="mt-6 flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-purple-500/20 bg-slate-900/60 px-6 py-8 text-center">
        <p className="font-semibold text-slate-200">{automatic ? "애니시아 검색 결과 없음" : "추가 DB 검색"}</p>
        <div className="flex items-center gap-2 text-sm text-purple-300">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>{automatic ? "한글 자막 DB에서 찾고 있습니다..." : "Cloudflare 검색 DB에서 찾고 있습니다..."}</span>
        </div>
        <p className="text-xs text-slate-400">{automatic ? "애니시아 · AniAll · 네이버블로그 연결 작품 확인 중" : "Cloudflare가 처리하는 검색이야. Pi의 자막 DB는 조회하지 않아."}</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div role="alert" className="mt-6 rounded-2xl border border-amber-500/20 bg-slate-900/60 p-6 text-center">
        <p className="text-sm text-slate-300">{automatic
          ? "애니시아 검색 결과가 없고, 한글 DB 조회도 완료하지 못했어."
          : "추가 자막 DB 조회를 완료하지 못했어."}</p>
        <button type="button" onClick={() => setRetry(n => n + 1)}
          className="mt-3 rounded-xl bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-500">
          DB 다시 검색
        </button>
      </div>
    );
  }

  const uniqueItems = filterSupplementalDbItems(result?.items || [], upstreamItems);
  return (
    <section className="mt-6" aria-live="polite">
      <p className="mb-4 text-sm font-semibold text-emerald-300">
        {uniqueItems.length
          ? "추가 DB에서 " + uniqueItems.length + "개 작품을 찾았어."
          : result?.items.length
            ? "현재 페이지의 추가 DB 결과는 이미 표시된 작품과 중복돼."
            : automatic
              ? "애니시아와 한글 자막 DB에서 검색 결과가 없습니다."
              : "추가 DB 검색 결과가 없습니다."}
      </p>
      {!!uniqueItems.length && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {uniqueItems.map((anime, index) => (
            <AnimeCard key={anime.id + "-" + index} anime={anime} />
          ))}
        </div>
      )}
      {result && result.total_pages > 1 && (
        <nav aria-label="한글 DB 검색 결과 페이지" className="mt-8 flex items-center justify-center gap-4">
          <button type="button" disabled={page <= 1} onClick={() => setPage(n => Math.max(1, n - 1))}
            className="rounded-xl border border-purple-500/30 px-4 py-2 text-sm text-slate-200 disabled:opacity-40">이전</button>
          <span className="text-sm text-purple-300">{page} / {result.total_pages} 페이지</span>
          <button type="button" disabled={!result.has_next} onClick={() => setPage(n => n + 1)}
            className="rounded-xl border border-purple-500/30 px-4 py-2 text-sm text-slate-200 disabled:opacity-40">다음</button>
        </nav>
      )}
    </section>
  );
}
