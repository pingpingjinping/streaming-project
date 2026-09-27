"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Link2, Loader2, Search, Trash2 } from "lucide-react";

interface Work {
  animeNo: number;
  year: number | null;
  title: string;
  nativeTitle: string;
  candidateKey: string;
  candidateYear: string;
  candidateTitle: string;
  titleScore: number | null;
  adjustedScore: number | null;
  yearAdjustment: number | null;
  formatStatus: string;
  yearStatus: string;
  reviewLabel: string;
}

interface SavedLink {
  id: number;
  label: string;
  url: string;
  source_type: "iframe" | "m3u8";
}

function LinkEditor({ work }: { work: Work }) {
  const [episode, setEpisode] = useState(1);
  const [links, setLinks] = useState<SavedLink[]>([]);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [sourceType, setSourceType] = useState<"auto" | "iframe" | "m3u8">("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const animeId = `ani_${work.animeNo}`;

  async function loadLinks(ep: number) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/anime/manual-source?animeId=${animeId}&ep=${ep}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "링크를 불러오지 못했습니다.");
      setLinks(data.sources || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "링크를 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!Number.isSafeInteger(episode) || episode < 1 || episode > 10000) {
      setError("회차를 1~10000 사이로 입력하세요.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/anime/manual-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ animeId, episodeNumber: episode, label, url, sourceType }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "저장 실패");
      setUrl("");
      await loadLinks(episode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장에 실패했습니다.");
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      const res = await fetch(`/api/anime/manual-source?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("링크를 삭제하지 못했습니다.");
      setLinks((prev) => prev.filter((item) => item.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-sky-500/20 bg-slate-950/50 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-300">
          회차
          <input
            type="number" min={1} max={10000} value={episode}
            onChange={(e) => { setEpisode(Number(e.target.value)); setLinks([]); }}
            className="mt-1 block w-24 rounded-lg border border-white/10 bg-slate-900 px-2 py-2 text-white"
          />
        </label>
        <button type="button" disabled={busy || !Number.isSafeInteger(episode) || episode < 1}
          onClick={() => loadLinks(episode)}
          className="rounded-lg border border-sky-500/30 px-3 py-2 text-xs text-sky-300 disabled:opacity-50">
          이 회차 저장된 링크 보기
        </button>
      </div>
      {links.length > 0 && (
        <div className="mt-3 space-y-2">
          {links.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-800/70 px-3 py-2 text-xs">
              <Link className="font-semibold text-sky-300 hover:underline"
                href={`/watch/${animeId}/${episode}?manual_source=${item.id}`}>
                {item.label} · {episode}화 재생
              </Link>
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white"
                title="원본 주소 열기"><ExternalLink className="h-4 w-4" /></a>
              <button type="button" disabled={busy} onClick={() => remove(item.id)}
                className="ml-auto text-slate-400 hover:text-rose-400" title="링크 삭제">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={save} className="mt-4 grid gap-2 sm:grid-cols-[1fr_130px]">
        <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" required
          placeholder="플레이어/embed 또는 m3u8 주소 (https://...)"
          className="min-w-0 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white" />
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value as typeof sourceType)}
          className="rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white">
          <option value="auto">자동 판별</option><option value="iframe">웹/embed</option><option value="m3u8">m3u8</option>
        </select>
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100}
          placeholder="링크 이름 (선택)"
          className="min-w-0 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white" />
        <button disabled={busy || !url.trim()} type="submit"
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} 링크 저장
        </button>
      </form>
      {error && <p role="alert" className="mt-2 text-xs text-rose-400">{error}</p>}
      <p className="mt-2 text-[11px] text-slate-500">링크는 계정·작품·회차별로 Pi의 DB에 저장됩니다.</p>
    </div>
  );
}

export default function UnmatchedCatalog({ items }: { items: Work[] }) {
  const [query, setQuery] = useState("");
  const [year, setYear] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const years = [...new Set(items.map((item) => item.year).filter((value): value is number => value !== null))].sort((a,b) => b-a);
  const filtered = items.filter((item) => {
    const q = query.trim().toLocaleLowerCase();
    return (!q || [item.title,item.nativeTitle,item.candidateTitle].some((s) => s.toLocaleLowerCase().includes(q)))
      && (!year || String(item.year) === year);
  });
  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="한국어·일본어 제목 검색"
            className="w-full rounded-xl border border-white/10 bg-slate-900 py-2 pl-9 pr-3 text-sm text-white" />
        </div>
        <select value={year} onChange={(e) => setYear(e.target.value)}
          className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white">
          <option value="">전체 연도</option>
          {years.map((value) => <option key={value} value={value}>{value}년</option>)}
        </select>
      </div>
      <p className="my-4 text-xs text-slate-400">{filtered.length}개 작품 · 점수는 연결 확정이 아닌 검토용 참고값</p>
      <div className="space-y-3">
        {filtered.map((work) => (
          <div key={work.animeNo} className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <Link href={`/anime/ani_${work.animeNo}`} className="font-bold text-white hover:text-purple-300">{work.title}</Link>
                <div className="mt-1 text-xs text-slate-400">{work.year || "연도 미상"} · 애니시아 #{work.animeNo}{work.nativeTitle && ` · ${work.nativeTitle}`}</div>
                {work.candidateKey && (
                  <div className="mt-2 text-xs leading-relaxed text-amber-200/80">
                    참고 후보: {work.candidateTitle || work.candidateKey} {work.candidateYear && `(${work.candidateYear})`}
                    {work.titleScore !== null && ` · 제목 ${work.titleScore} → 조정 ${work.adjustedScore}`}
                    {work.yearAdjustment !== null && ` (연도 ${work.yearAdjustment > 0 ? "+" : ""}${work.yearAdjustment})`}
                    <span className="ml-2 text-slate-400">{work.formatStatus} · {work.reviewLabel}</span>
                  </div>
                )}
              </div>
              <button type="button" onClick={() => setSelected(selected === work.animeNo ? null : work.animeNo)}
                className="shrink-0 rounded-lg bg-purple-600/20 px-3 py-2 text-xs font-semibold text-purple-200 hover:bg-purple-600/30">
                {selected === work.animeNo ? "닫기" : "회차 링크 추가"}
              </button>
            </div>
            {selected === work.animeNo && <LinkEditor key={work.animeNo} work={work} />}
          </div>
        ))}
      </div>
    </div>
  );
}
