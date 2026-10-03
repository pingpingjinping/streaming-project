"use client";
import {bundleSelectionMatches} from "@/lib/subtitleLocalIdentity";
import SubtitleFolderAssignments from "./SubtitleFolderAssignments";
import SubtitleEpisodeExceptions from "./SubtitleEpisodeExceptions";

import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Loader2, Search, Subtitles, X } from "lucide-react";

type Provider = "aniall" | "anissia" | "naver";

type BundleAssignment = {
  animeId: string;
  provider: Provider;
  bundleKey: string;
  label: string;
  exclusive: boolean;
};

type FolderCandidate = {
  folderName: string;folderKey?:string;
  provider: Provider;
};

type SubtitleCandidate = {
  name: string;
  reviewedFileId?:string;localFileId?:string;
  sourceProvider?: Provider;
  sourceFolderKey?:string;sourceFolderLabel?:string;
  sourceBundleKey?: string;
  sourceBundleLabel?: string;
  sourceMatchedTitle?: string;
  matchedTitle?: string;
  localArchive?: boolean;
};

export default function SubtitleBundleAssignmentSetting({
  animeId,
  animeTitle,
}: {
  animeId: string;
  animeTitle: string;
}) {
  const [exceptionCandidate,setExceptionCandidate]=useState<SubtitleCandidate|null>(null);
  const [assignment, setAssignment] = useState<BundleAssignment | null>(null);
  const [keyword, setKeyword] = useState(animeTitle);
  const [episode, setEpisode] = useState(1);
  const [folders, setFolders] = useState<FolderCandidate[]>([]);
  const [results, setResults] = useState<SubtitleCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/anime/subtitle-bundle?animeId=${encodeURIComponent(animeId)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "묶음 지정을 불러오지 못했습니다.");
        return data;
      })
      .then((data) => { if (!cancelled) setAssignment(data.assignment || null); })
      .catch((error) => { if (!cancelled) setNotice(error.message || "묶음 지정을 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, [animeId]);

  const bundleResults = useMemo(() => {
    const map = new Map<string, SubtitleCandidate>();
    for (const item of results) {
      if (!item.localArchive || !item.sourceProvider || !item.sourceBundleKey) continue;
      const key = `${item.sourceProvider}:${item.sourceBundleKey}`;
      if (!map.has(key)) map.set(key, item);
    }
    return [...map.values()];
  }, [results]);

  const searchLocal = async (override?: string) => {
    const q = (override || keyword).trim();
    if (!q || loading) return;
    if (override) setKeyword(override);
    setLoading(true);
    setNotice("");
    setResults([]);
    try {
      const params = new URLSearchParams({
        mode: "folders",
        title: q,
        ep: String(episode),
        animeId,
      });
      const [folderResponse, subtitleResponse] = await Promise.all([
        fetch(`/api/anime/subtitles/local?${params.toString()}`, { cache: "no-store" }),
        fetch(`/api/anime/subtitles/local?mode=search&title=${encodeURIComponent(q)}&ep=${episode}&animeId=${encodeURIComponent(animeId)}`, { cache: "no-store" }),
      ]);
      const folderData = await folderResponse.json();
      const subtitleData = await subtitleResponse.json();
      if (folderResponse.ok && folderData.success) setFolders(folderData.folders || []);
      else setFolders([]);
      if (!subtitleResponse.ok || !subtitleData.success) {
        throw new Error(subtitleData.message || "로컬 자막 검색에 실패했습니다.");
      }
      setResults(subtitleData.subtitles || []);
      if (!(subtitleData.subtitles || []).some((item: SubtitleCandidate) => item.sourceBundleKey)) {
        setNotice("이 회차에서 지정 가능한 로컬 자막 묶음을 찾지 못했어. 다른 폴더 후보나 회차로 다시 찾아 봐.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "로컬 자막 검색에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const assign = async (item: SubtitleCandidate) => {
    if (!item.sourceProvider || !item.sourceBundleKey || savingKey) return;
    const key = `${item.sourceProvider}:${item.sourceBundleKey}`;
    setSavingKey(key);
    setNotice("");
    try {
      const response = await fetch("/api/anime/subtitle-bundle", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          animeId,
          provider: item.sourceProvider,
          bundleKey: item.sourceFolderKey || item.sourceBundleKey,
          fileId:item.reviewedFileId || item.localFileId,
          label: item.sourceBundleLabel || item.sourceMatchedTitle || item.matchedTitle || keyword || animeTitle,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "묶음을 지정하지 못했습니다.");
      setAssignment(data.assignment || null);
      setNotice("지정 완료. 이 묶음은 이 작품/시즌에서 우선 사용하고 다른 작품·시즌 후보에서는 숨겨져.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "묶음을 지정하지 못했습니다.");
    } finally {
      setSavingKey("");
    }
  };

  const clear = async () => {
    if (!assignment || savingKey) return;
    setSavingKey("clear");
    setNotice("");
    try {
      const response = await fetch(`/api/anime/subtitle-bundle?animeId=${encodeURIComponent(animeId)}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "지정을 해제하지 못했습니다.");
      setAssignment(null);
      setNotice("묶음 지정을 해제했어. 자동 매칭으로 돌아가.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "지정을 해제하지 못했습니다.");
    } finally {
      setSavingKey("");
    }
  };

  return (
    <section className="mt-5 rounded-2xl border border-emerald-500/25 bg-emerald-950/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Subtitles className="h-4 w-4 text-emerald-300" />
            <h2 className="text-sm font-bold text-emerald-100">로컬 자막 묶음 지정</h2>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            ZIP 안의 작품·시즌별 묶음을 지정해. 회차가 확인된 파일만 자동 적용하고, TV·OVA는 따로 지정할 수 있어.
          </p>
        </div>
        {assignment && (
          <button type="button" onClick={clear} disabled={Boolean(savingKey)}
            className="flex items-center gap-1 rounded-lg border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-50">
            <X className="h-3.5 w-3.5" /> 지정 해제
          </button>
        )}
      </div>

      {assignment && (
        <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
          <span className="font-bold">현재 지정:</span>{" "}
          {assignment.provider === "aniall" ? "AniAll" : assignment.provider === "naver" ? "Naver" : "Anissia"}
          {" · "}{assignment.label || assignment.bundleKey}
        </div>
      )}

      <SubtitleEpisodeExceptions animeId={animeId} animeTitle={animeTitle} currentEpisode={episode}
        candidate={exceptionCandidate} onCancel={()=>setExceptionCandidate(null)} />

      <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); searchLocal(); }}>
        <input value={keyword} onChange={(event) => setKeyword(event.target.value)}
          placeholder="로컬 폴더/작품명 검색"
          className="min-w-48 flex-1 rounded-xl border border-emerald-500/20 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-emerald-400" />
        <input type="number" min={1} max={10000} value={episode}
          onChange={(event) => setEpisode(Math.max(1, Number(event.target.value) || 1))}
          className="w-20 rounded-xl border border-emerald-500/20 bg-slate-900 px-2 py-2 text-center text-xs text-white outline-none focus:border-emerald-400"
          title="검색할 회차" />
        <button type="submit" disabled={loading}
          className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          Pi 로컬 검색
        </button>
      </form>

      <SubtitleFolderAssignments animeId={animeId} choices={[...folders,...results]} onSaved={setAssignment} />
      {folders.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-semibold text-slate-400">폴더 후보</p>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {folders.slice(0, 60).map((folder, index) => (
              <button type="button" key={`${folder.provider}-${folder.folderName}-${index}`}
                onClick={() => searchLocal(folder.folderName)}
                className="flex max-w-full items-center gap-1 rounded-lg border border-white/10 bg-slate-900/70 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-emerald-500/40 hover:text-white">
                <FolderOpen className="h-3 w-3 shrink-0" />
                <span className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] text-left">{folder.folderName}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {bundleResults.length > 0 && (
        <div className="mt-3 space-y-2">
          {bundleResults.map((item) => {
            const key = `${item.sourceProvider}:${item.sourceBundleKey}`;
            const selected = Boolean(assignment && assignment.provider === item.sourceProvider
              && bundleSelectionMatches(assignment.bundleKey,item.sourceBundleKey!));
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-slate-900/70 p-3">
                <div className="min-w-0 w-full">
                  <p className="whitespace-normal break-words [overflow-wrap:anywhere] leading-relaxed text-xs font-semibold text-white">
                    {item.sourceBundleLabel || item.sourceMatchedTitle || item.matchedTitle || item.name}
                  </p>
                  <p className="mt-0.5 whitespace-normal break-words [overflow-wrap:anywhere] text-[11px] text-slate-400">
                    {item.sourceProvider === "aniall" ? "AniAll" : item.sourceProvider === "naver" ? "Naver" : "Anissia"} · {item.name}
                  </p>
                </div>
                {(item.reviewedFileId || item.localFileId) && <button type="button" onClick={()=>setExceptionCandidate(item)}
                  className="shrink-0 rounded-lg border border-amber-500/40 px-3 py-2 text-[11px] text-amber-200">예외 만들기</button>}
                <button type="button" onClick={() => assign(item)}
                  disabled={Boolean(savingKey) || selected}
                  className="shrink-0 rounded-lg bg-purple-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-purple-500 disabled:bg-emerald-950/50 disabled:text-emerald-300">
                  {selected ? "지정됨" : savingKey === key ? "지정 중…" : item.sourceFolderKey ? "이 버전 계속" : "이 묶음 지정"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {results.some(item=>item.reviewedFileId || item.localFileId) && <details className="mt-3 rounded-xl border border-slate-700 p-3 text-xs">
        <summary className="cursor-pointer font-semibold text-amber-100">파일별 예외 선택</summary>
        <div className="mt-2 max-h-60 space-y-2 overflow-y-auto">
          {results.filter(item=>item.reviewedFileId || item.localFileId).map((item,index)=><div key={`${item.reviewedFileId || item.localFileId}-${index}`} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-words text-slate-300">{item.name}</span>
            <button type="button" onClick={()=>setExceptionCandidate(item)} className="shrink-0 rounded-lg border border-amber-500/40 px-2 py-1 text-amber-200">예외 만들기</button>
          </div>)}
        </div>
      </details>}

      {notice && <p className="mt-3 text-[11px] text-emerald-200">{notice}</p>}
    </section>
  );
}
