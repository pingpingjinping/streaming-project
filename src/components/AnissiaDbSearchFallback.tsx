"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import AnimeCard from "./AnimeCard";
import type { AnimeListResponse } from "@/lib/providers/types";

type LookupState = "loading" | "done" | "error";

/** Rendered only when the old Anissia API has no visible hits.
 * Its DB request starts after navigation, so slow DB reads cannot block the
 * initial search results page.
 */
export default function AnissiaDbSearchFallback({
  keyword, captionsOnly, initialPage,
}: {
  keyword: string;
  captionsOnly: boolean;
  initialPage: number;
}) {
  const [page, setPage] = useState(initialPage);
  const [result, setResult] = useState<AnimeListResponse | null>(null);
  const [status, setStatus] = useState<LookupState>("loading");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setResult(null);
    const params = new URLSearchParams({
      source: "anissia",
      tab: "list",
      q: keyword,
      page: String(page),
      captions: captionsOnly ? "1" : "0",
      db_only: "1",
    });
    fetch("/api/anime/list?" + params.toString(), {
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
        console.warn("[Anissia DB fallback]", error);
        setStatus("error");
      });
    return () => controller.abort();
  }, [keyword, captionsOnly, page, retry]);

  if (status === "loading") {
    return (
      <div role="status" aria-live="polite" className="mt-6 flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-purple-500/20 bg-slate-900/60 px-6 py-8 text-center">
        <p className="font-semibold text-slate-200">애니시아 검색 결과 없음</p>
        <div className="flex items-center gap-2 text-sm text-purple-300">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>한글 자막 DB에서 찾고 있습니다...</span>
        </div>
        <p className="text-xs text-slate-400">애니시아 · AniAll · 네이버블로그 연결 작품 확인 중</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div role="alert" className="mt-6 rounded-2xl border border-amber-500/20 bg-slate-900/60 p-6 text-center">
        <p className="text-sm text-slate-300">애니시아 검색 결과가 없고, 한글 DB 조회도 완료하지 못했어.</p>
        <button type="button" onClick={() => setRetry(n => n + 1)}
          className="mt-3 rounded-xl bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-500">
          DB 다시 검색
        </button>
      </div>
    );
  }

  return (
    <section className="mt-6" aria-live="polite">
      <p className="mb-4 text-sm font-semibold text-emerald-300">
        {result?.items.length
          ? "한글 자막 DB에서 " + result.items.length + "개 작품을 찾았어."
          : "애니시아와 한글 자막 DB에서 검색 결과가 없습니다."}
      </p>
      {!!result?.items.length && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {result.items.map((anime, index) => (
            <AnimeCard key={anime.id + "-" + index} anime={anime} />
          ))}
        </div>
      )}
      {result && result.total_pages > 1 && (
        <nav aria-label="한글 DB 검색 결과 페이지" className="mt-8 flex items-center justify-center gap-4">
          <button type="button" disabled={page <= 1} onClick={() => setPage(n => Math.max(1, n - 1))}
            className="rounded-xl border border-purple-500/30 px-4 py-2 text-sm text-slate-200 disabled:opacity-40">이전</button>
          <span className="text-sm text-purple-300">{result.total_pages_exact === false ? `${page} 페이지` : `${page} / ${result.total_pages} 페이지`}</span>
          <button type="button" disabled={!result.has_next} onClick={() => setPage(n => n + 1)}
            className="rounded-xl border border-purple-500/30 px-4 py-2 text-sm text-slate-200 disabled:opacity-40">다음</button>
        </nav>
      )}
    </section>
  );
}
