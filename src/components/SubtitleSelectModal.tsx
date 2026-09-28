"use client";

import { useState, useRef, useEffect, DragEvent, ChangeEvent } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Search,
  Users,
  Upload,
  FileText,
  Wand2,
  ExternalLink,
  Check,
  Loader2,
  AlertCircle,
  Sparkles,
  Subtitles,
} from "lucide-react";

export interface CreatorInfo {
  name: string;
  episode: string;
  update_date: string;
  website: string;
  is_current_ep: boolean;
  matchScore?: number;
  matchedTitle?: string;
  verifiedMatch?: boolean;
  sourceProvider?: "aniall" | "anissia";
  localArchive?: boolean;
}

export interface SubtitleOption {
  name: string;
  format: "ASS" | "VTT";
  is_ass: boolean;
  content: string;
  url?: string;
  matchScore?: number;
  matchedTitle?: string;
  verifiedMatch?: boolean;
  sourceCreatorWebsite?: string;
  sourceMatchedTitle?: string;
  sourceProvider?: "aniall" | "anissia";
  isCached?: boolean;
  localArchive?: boolean;
}

const creatorKey = (creator: CreatorInfo) => `${creator.website}\n${creator.matchedTitle || ""}`;
type RejectedSource = { provider: string; sourceKey: string };
const rejectionId = (provider: string, sourceKey: string) => JSON.stringify([provider, sourceKey]);
const creatorSource = (creator: CreatorInfo): RejectedSource => ({
  provider: creator.localArchive ? "local" : creator.sourceProvider || "anissia",
  sourceKey: creator.website || creator.name,
});
const subtitleSource = (subtitle: SubtitleOption): RejectedSource => ({
  provider: subtitle.localArchive ? "local" : subtitle.sourceProvider || "local",
  sourceKey: subtitle.sourceCreatorWebsite || subtitle.url || subtitle.name,
});

interface SubtitleSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  animeId: string;
  animeTitle: string;
  episodeNumber: number;
  creators: CreatorInfo[];
  currentSubName?: string;
  currentSubSourceCreatorWebsite?: string;
  currentSubMatchedTitle?: string;
  onSelectSubtitle: (sub: SubtitleOption) => void;
}

export default function SubtitleSelectModal({
  isOpen,
  onClose,
  animeId,
  animeTitle,
  episodeNumber,
  creators,
  currentSubName,
  currentSubSourceCreatorWebsite,
  currentSubMatchedTitle,
  onSelectSubtitle,
}: SubtitleSelectModalProps) {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<"creators" | "search" | "file">("creators");
  const [localArchiveOptions, setLocalArchiveOptions] = useState<SubtitleOption[]>([]);
  const [isLoadingLocalArchives, setIsLoadingLocalArchives] = useState(false);

  // Search tab states
  const [searchKeyword, setSearchKeyword] = useState(animeTitle || "");
  const [searchEp, setSearchEp] = useState(episodeNumber || 1);
  const [searchResults, setSearchResults] = useState<SubtitleOption[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSearchingLocal, setIsSearchingLocal] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Creator download states
  const [loadingCreator, setLoadingCreator] = useState<string | null>(null);
  const [creatorError, setCreatorError] = useState<string | null>(null);
  const [rejectedSources, setRejectedSources] = useState<RejectedSource[]>([]);
  const [savingRejection, setSavingRejection] = useState("");
  const [startEpisodeInput, setStartEpisodeInput] = useState("");
  const [savedStartEpisode, setSavedStartEpisode] = useState<number | null>(null);
  const [savingStartEpisode, setSavingStartEpisode] = useState(false);
  const [startEpisodeNotice, setStartEpisodeNotice] = useState<string | null>(null);

  // File upload states
  const [uploadedSub, setUploadedSub] = useState<SubtitleOption | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setSearchKeyword(animeTitle || "");
      setSearchEp(episodeNumber || 1);
      setCreatorError(null);
      setSearchError(null);
      setFileError(null);
      setFileNotice(null);
    }
  }, [isOpen, animeTitle, episodeNumber]);

  useEffect(() => {
    if (!isOpen || !animeId) return;
    let cancelled = false;
    fetch(`/api/anime/subtitle-episode-start?animeId=${encodeURIComponent(animeId)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "시작 회차 설정을 불러오지 못했습니다.");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        const value = Number(data.startEpisode);
        const start = Number.isInteger(value) && value > 0 ? value : null;
        setSavedStartEpisode(start);
        setStartEpisodeInput(start ? String(start) : "");
      })
      .catch((error) => {
        if (!cancelled) setStartEpisodeNotice(error.message || "시작 회차 설정을 불러오지 못했습니다.");
      });
    return () => { cancelled = true; };
  }, [isOpen, animeId]);

  useEffect(() => {
    if (!isOpen || !animeId) return;
    let cancelled = false;
    setRejectedSources([]);
    fetch(`/api/anime/subtitle-rejections?animeId=${encodeURIComponent(animeId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => { if (!cancelled && data.success) setRejectedSources(data.rejections || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen, animeId]);

  const isRejected = ({ provider, sourceKey }: RejectedSource) =>
    rejectedSources.some((entry) => rejectionId(entry.provider, entry.sourceKey) === rejectionId(provider, sourceKey));
  const visibleCreators = creators.filter((creator) => !isRejected(creatorSource(creator)));
  const visibleLocalArchiveOptions = localArchiveOptions.filter((option) => !isRejected(subtitleSource(option)));
  const visibleSearchResults = searchResults.filter((option) => !isRejected(subtitleSource(option)));

  const changeRejection = async (source: RejectedSource, reject: boolean) => {
    const key = rejectionId(source.provider, source.sourceKey);
    if (savingRejection) return;
    setSavingRejection(key);
    setCreatorError(null);
    try {
      const response = await fetch("/api/anime/subtitle-rejections", {
        method: reject ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ animeId, ...source }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "선택을 저장하지 못했습니다.");
      setRejectedSources((old) => reject
        ? [...old.filter((entry) => rejectionId(entry.provider, entry.sourceKey) !== key), source]
        : old.filter((entry) => rejectionId(entry.provider, entry.sourceKey) !== key));
    } catch (error) {
      setCreatorError(error instanceof Error ? error.message : "선택을 저장하지 못했습니다.");
    } finally {
      setSavingRejection("");
    }
  };

  useEffect(() => {
    if (!isOpen) {
      setLocalArchiveOptions([]);
      return;
    }
    let cancelled = false;
    setIsLoadingLocalArchives(true);
    const params = new URLSearchParams({
      title: animeTitle,
      ep: String(episodeNumber || 1),
      animeId,
    });
    fetch(`/api/anime/subtitles/local?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "로컬 자막 검색 실패");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setLocalArchiveOptions((data.subtitles || []).map((subtitle: any) => ({
          name: subtitle.name,
          format: subtitle.is_ass ? "ASS" : "VTT",
          is_ass: Boolean(subtitle.is_ass),
          content: subtitle.content || "",
          url: subtitle.url || "",
          matchScore: subtitle.matchScore,
          matchedTitle: subtitle.matchedTitle || subtitle.sourceMatchedTitle,
          verifiedMatch: subtitle.verifiedMatch,
          sourceProvider: "aniall",
          sourceCreatorWebsite: subtitle.sourceCreatorWebsite,
          sourceMatchedTitle: subtitle.sourceMatchedTitle,
          localArchive: true,
        })));
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("[Local archive recommendations]:", error);
          setLocalArchiveOptions([]);
        }
      })
      .finally(() => { if (!cancelled) setIsLoadingLocalArchives(false); });
    return () => { cancelled = true; };
  }, [isOpen, animeId, animeTitle, episodeNumber]);

  if (!mounted || !isOpen) return null;

  const handleSaveStartEpisode = async () => {
    const raw = startEpisodeInput.trim();
    const value = raw ? Number(raw) : null;
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 10000)) {
      setStartEpisodeNotice("시작 회차는 1~10000 사이의 정수로 입력해 주세요.");
      return;
    }
    setSavingStartEpisode(true);
    setStartEpisodeNotice(null);
    try {
      const response = await fetch("/api/anime/subtitle-episode-start", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ animeId, startEpisode: value }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "저장에 실패했습니다.");
      setSavedStartEpisode(value);
      setStartEpisodeInput(value === null ? "" : String(value));
      setStartEpisodeNotice(value === null ? "기본 회차 검색으로 되돌렸어." : `${value}화부터 연결하도록 저장했어.`);
    } catch (error: any) {
      setStartEpisodeNotice(error.message || "시작 회차 설정을 저장하지 못했습니다.");
    } finally {
      setSavingStartEpisode(false);
    }
  };

  // 1. Download and apply creator's subtitle
  const handleSelectCreator = async (creator: CreatorInfo) => {
    if (!creator.website || loadingCreator) return;
    const selectedCreatorKey = creatorKey(creator);
    setLoadingCreator(selectedCreatorKey);
    setCreatorError(null);

    try {
      const res = await fetch("/api/anime/subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorName: creator.name,
          website: creator.website,
          title: searchKeyword || animeTitle,
          matchedTitle: creator.matchedTitle,
          episodeNumber: episodeNumber,
          creatorEpisode: creator.episode,
          sourceProvider: creator.sourceProvider,
          animeId,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success || !data.subtitle) {
        throw new Error(data.message || "해당 제작자의 이번 회차 자막을 가져오지 못했습니다.");
      }

      const newSub: SubtitleOption = {
        name: `(${creator.name}) ${data.subtitle.orig_filename || `${episodeNumber}화 자막`}`,
        format: data.subtitle.is_ass ? "ASS" : "VTT",
        is_ass: Boolean(data.subtitle.is_ass),
        content: data.subtitle.content,
        url: data.subtitle.url,
        sourceCreatorWebsite: creator.website,
        sourceMatchedTitle: creator.matchedTitle,
        sourceProvider: creator.sourceProvider,
      };

      onSelectSubtitle(newSub);
      onClose();
    } catch (err: any) {
      setCreatorError(err.message || "자막 다운로드에 실패했습니다.");
    } finally {
      setLoadingCreator(null);
    }
  };

  // 2. Perform manual search with user-entered keyword
  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const keyword = searchKeyword.trim();
    if (!keyword) return;

    setIsSearching(true);
    setSearchError(null);
    setSearchResults([]);

    try {
      const res = await fetch(
        `/api/anime/subtitles?title=${encodeURIComponent(keyword)}&ep=${searchEp}&animeId=${encodeURIComponent(animeId)}&referenceTitle=${encodeURIComponent(animeTitle)}`
      );
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "자막 검색 실패");
      }

      const subs: SubtitleOption[] = (data.subtitles || []).map((s: any) => ({
        name: s.name,
        format: s.is_ass ? "ASS" : "VTT",
        is_ass: Boolean(s.is_ass),
        content: s.content || "",
        url: s.url || "",
        matchScore: s.matchScore,
        matchedTitle: s.matchedTitle || s.sourceMatchedTitle,
        verifiedMatch: s.verifiedMatch,
        sourceProvider: s.sourceProvider,
        sourceCreatorWebsite: s.sourceCreatorWebsite,
        sourceMatchedTitle: s.sourceMatchedTitle,
        isCached: Boolean(s.isCached),
        localArchive: Boolean(s.localArchive),
      }));

      // The server has already grouped these in the configured provider order.
      setSearchResults(subs);
      if (subs.length === 0) {
        setSearchError("검색된 자막이 없습니다. 다른 제목(예: 한국어 정식 방영명)으로 검색해 보세요.");
      }
    } catch (err: any) {
      setSearchError(err.message || "자막을 검색하는 중 오류가 발생했습니다.");
    } finally {
      setIsSearching(false);
    }
  };

  const handleLocalSearch = async () => {
    const keyword = searchKeyword.trim();
    if (!keyword) return;
    setIsSearchingLocal(true);
    setSearchError(null);
    setSearchResults([]);
    try {
      const res = await fetch(
        `/api/anime/subtitles/local?title=${encodeURIComponent(keyword)}&ep=${searchEp}&animeId=${encodeURIComponent(animeId)}`
      );
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "로컬 자막 검색 실패");
      const subs: SubtitleOption[] = (data.subtitles || []).map((s: any) => ({
        name: s.name,
        format: s.is_ass ? "ASS" : "VTT",
        is_ass: Boolean(s.is_ass),
        content: s.content || "",
        url: s.url || "",
        matchScore: s.matchScore,
        matchedTitle: s.matchedTitle || s.sourceMatchedTitle,
        verifiedMatch: s.verifiedMatch,
        sourceProvider: s.sourceProvider,
        sourceCreatorWebsite: s.sourceCreatorWebsite,
        sourceMatchedTitle: s.sourceMatchedTitle,
        localArchive: Boolean(s.localArchive),
      }));
      setSearchResults(subs);
      if (subs.length === 0) setSearchError("Pi의 로컬 보관함에서 해당 회차 자막을 찾지 못했어.");
    } catch (err: any) {
      setSearchError(err.message || "로컬 자막을 검색하는 중 오류가 발생했습니다.");
    } finally {
      setIsSearchingLocal(false);
    }
  };

  // Open a subtitle file directly, or unpack and save an episode ZIP on the Pi.
  const processSubtitleFile = async (file: File) => {
    setFileError(null);
    setFileNotice(null);
    setUploadedSub(null);
    const fileName = file.name;
    const lowerName = fileName.toLowerCase();

    if (lowerName.endsWith(".zip")) {
      try {
        const form = new FormData();
        form.set("animeId", animeId);
        form.set("ep", String(episodeNumber || 1));
        form.set("file", file);
        form.set("mode", "open");
        const response = await fetch("/api/anime/uploaded-subtitle", { method: "POST", body: form });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.message || "ZIP 자막을 Pi에 저장하지 못했습니다.");
        }
        const saved = Array.isArray(data.saved) ? data.saved : [];
        if (data.subtitle) {
          setUploadedSub({
            name: data.subtitle.name || "Pi 저장: " + fileName,
            format: data.subtitle.is_ass ? "ASS" : "VTT",
            is_ass: Boolean(data.subtitle.is_ass),
            content: data.subtitle.content || "",
          });
          setFileNotice("Pi에 " + saved.length + "개 회차 저장 · 현재 " + episodeNumber + "화 자막 준비 완료");
        } else {
          setFileNotice("Pi에 " + saved.length + "개 회차 저장 · 현재 " + episodeNumber + "화 자막은 ZIP에 없어");
        }
      } catch (error) {
        setFileError(error instanceof Error ? error.message : "ZIP 자막을 읽지 못했습니다.");
      }
      return;
    }

    if (
      !lowerName.endsWith(".ass") &&
      !lowerName.endsWith(".ssa") &&
      !lowerName.endsWith(".srt") &&
      !lowerName.endsWith(".smi") &&
      !lowerName.endsWith(".vtt")
    ) {
      setFileError("지원되는 자막 형식(.ass, .ssa, .srt, .smi, .vtt) 또는 ZIP이 아닙니다.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = (e.target?.result as string) || "";
      if (!text.trim()) {
        setFileError("자막 파일 내용이 비어 있습니다.");
        return;
      }
      const isAss = lowerName.endsWith(".ass") || lowerName.endsWith(".ssa");
      setUploadedSub({
        name: "[로컬 파일] " + fileName,
        format: isAss ? "ASS" : "VTT",
        is_ass: isAss,
        content: text,
      });
    };
    reader.onerror = () => setFileError("파일을 읽는 도중 오류가 발생했습니다.");
    reader.readAsText(file, "UTF-8");
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void processSubtitleFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void processSubtitleFile(e.target.files[0]);
    }
  };

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-md transition-opacity"
        onClick={onClose}
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-purple-500/30 bg-[#0f172a] shadow-2xl shadow-purple-900/40 z-10 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-purple-500/20 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-600/20 text-purple-400 border border-purple-500/30">
              <Subtitles className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">자막 선택 및 수동 검색</h2>
              <p className="text-xs text-slate-400">
                현재 자막: <span className="text-purple-300 font-semibold">{currentSubName || "연동 중"}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-800 hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-purple-500/15 bg-slate-900/60 px-6 pt-2">
          <button
            onClick={() => setActiveTab("creators")}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-bold transition ${
              activeTab === "creators"
                ? "border-purple-500 text-purple-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Users className="h-4 w-4" />
            제작자 선택 ({visibleCreators.length}명)
          </button>

          <button
            onClick={() => setActiveTab("search")}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-bold transition ${
              activeTab === "search"
                ? "border-purple-500 text-purple-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Search className="h-4 w-4" />
            다른 제목 검색
          </button>

          <button
            onClick={() => setActiveTab("file")}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-bold transition ${
              activeTab === "file"
                ? "border-purple-500 text-purple-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Upload className="h-4 w-4" />
            내 파일 직접 열기
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Tab 1: Creators List */}
          {activeTab === "creators" && (
            <div className="space-y-3">
              <section className="rounded-2xl border border-emerald-500/25 bg-emerald-950/15 p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-emerald-200">Pi 로컬 자막</h3>
                  {isLoadingLocalArchives && <span className="text-xs text-emerald-300">검색 중…</span>}
                </div>
                {visibleLocalArchiveOptions.length ? (
                  <div className="space-y-2">
                    {visibleLocalArchiveOptions.map((subtitle, index) => (
                      <div key={`${subtitle.name}-${index}`} className="flex items-center gap-2">
                        <button type="button"
                          onClick={() => { onSelectSubtitle(subtitle); onClose(); }}
                          className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/20 bg-slate-900/70 px-3 py-2 text-left hover:border-emerald-400/50 hover:bg-slate-900">
                          <span className="min-w-0 truncate text-sm font-semibold text-white">{subtitle.name}</span>
                          <span className="shrink-0 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-300">Pi 로컬 적용</span>
                        </button>
                        <button type="button" onClick={() => changeRejection(subtitleSource(subtitle), true)}
                          disabled={Boolean(savingRejection)}
                          className="shrink-0 rounded-lg px-2 py-2 text-[11px] text-slate-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50">이 자막은 아니야</button>
                      </div>
                    ))}
                  </div>
                ) : !isLoadingLocalArchives ? (
                  <p className="text-xs text-slate-400">현재 회차의 로컬 자막을 찾지 못했어. 다른 제목 검색에서 로컬 검색을 할 수 있어.</p>
                ) : null}
              </section>

              {creatorError && (
                <div className="flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-400">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{creatorError}</span>
                </div>
              )}

              {rejectedSources.length > 0 && (
                <details className="rounded-xl border border-slate-700/60 p-3 text-xs text-slate-400">
                  <summary className="cursor-pointer">숨긴 자막 {rejectedSources.length}개 · 다시 표시</summary>
                  <div className="mt-2 space-y-2">
                    {rejectedSources.map((entry) => (
                      <div key={rejectionId(entry.provider, entry.sourceKey)} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">{entry.provider}: {entry.sourceKey}</span>
                        <button type="button" disabled={Boolean(savingRejection)}
                          onClick={() => changeRejection(entry, false)}
                          className="shrink-0 rounded-lg px-2 py-1 text-purple-300 hover:bg-purple-500/10 disabled:opacity-50">되돌리기</button>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <section className="rounded-2xl border border-amber-500/25 bg-amber-950/10 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="subtitle-start-episode" className="text-xs font-semibold text-amber-100">
                    이 작품 페이지 자막 시작 회차
                  </label>
                  <input
                    id="subtitle-start-episode"
                    type="number"
                    min={1}
                    max={10000}
                    value={startEpisodeInput}
                    onChange={(event) => setStartEpisodeInput(event.target.value)}
                    placeholder="기본값"
                    className="w-24 rounded-lg border border-amber-500/30 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-amber-300"
                  />
                  <button
                    type="button"
                    onClick={handleSaveStartEpisode}
                    disabled={savingStartEpisode}
                    className="rounded-lg bg-amber-500/15 px-3 py-2 text-xs font-bold text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
                  >
                    {savingStartEpisode ? "저장 중…" : "저장"}
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                  예: 13을 저장하면 이 작품 페이지의 1화를 블로그 13화로 찾고, 12화는 24화로 찾아. 이 페이지의 모든 제작자에게 적용돼.
                </p>
                {savedStartEpisode && (
                  <p className="mt-1 text-[11px] text-amber-200">현재 설정: {savedStartEpisode}화부터</p>
                )}
                {startEpisodeNotice && <p className="mt-1 text-[11px] text-amber-200">{startEpisodeNotice}</p>}
              </section>

              {visibleCreators.length === 0 ? (
                <div className="py-12 text-center text-slate-400">
                  <p className="text-sm font-semibold">등록된 공식 자막 제작자가 없습니다.</p>
                  <p className="mt-1 text-xs text-slate-500">
                    &apos;다른 제목 검색&apos; 탭에서 한국어 제목으로 직접 검색해 보세요.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <p className="text-[11px] text-slate-400">제목 매칭 점수순 · 점수는 작품 제목과 시즌 비교 기준이며 자막 싱크를 뜻하지 않습니다.</p>
                  {visibleCreators.map((c, idx) => {
                    // Creator names can repeat for several anime entries. A name
                    // match alone made every row appear applied; only mark the
                    // exact blog + matched work selected in this player.
                    const isCurrent = Boolean(
                      c.website &&
                      currentSubSourceCreatorWebsite === c.website &&
                      currentSubMatchedTitle === c.matchedTitle
                    );
                    const isLoading = loadingCreator === creatorKey(c);
                    const isAss =
                      c.name.includes("카이란") ||
                      c.name.includes("슈퍼소닉") ||
                      c.name.includes("코코아");

                    return (
                      <div
                        key={idx}
                        className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 transition ${
                          isCurrent
                            ? "border-purple-500/60 bg-purple-950/20"
                            : "border-white/10 bg-slate-900/60 hover:border-purple-500/30"
                        }`}
                      >
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-white text-sm">{c.name}</span>
                            <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${c.sourceProvider === "aniall" ? "bg-amber-500/15 text-amber-200" : "bg-cyan-500/15 text-cyan-200"}`}>{c.sourceProvider === "aniall" ? "AniAll" : "애니시아"}</span>
                            {c.localArchive && <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-300">Pi 로컬</span>}
                            {c.matchedTitle && <span className="text-xs font-semibold text-slate-300">· {c.matchedTitle}</span>}
                            {c.verifiedMatch ? (
                              <span className="rounded-md bg-emerald-500/20 px-2 py-0.5 text-[11px] font-bold text-emerald-300">DB 연결 확인</span>
                            ) : typeof c.matchScore === "number" ? (
                              <span className="rounded-md bg-sky-500/20 px-2 py-0.5 text-[11px] font-bold text-sky-300">제목 매칭 {c.matchScore}점</span>
                            ) : null}
                            {isAss && (
                              <span className="flex items-center gap-1 rounded-md bg-purple-500/20 border border-purple-500/40 px-2 py-0.5 text-[11px] font-bold text-purple-300">
                                <Wand2 className="h-3 w-3" />
                                ASS 특수효과
                              </span>
                            )}
                            {isCurrent && (
                              <span className="flex items-center gap-1 rounded-md bg-emerald-500/20 text-emerald-400 px-2 py-0.5 text-[11px] font-bold">
                                <Check className="h-3 w-3" /> 사용 중
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-slate-400">
                            <span>최신 업데이트: {c.episode || "확인됨"}</span>
                            {c.website && (
                              <a
                                href={c.website}
                                target="_blank"
                                rel="noreferrer"
                                className="flex items-center gap-1 text-purple-400 hover:underline"
                              >
                                블로그 방문 <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                        <button type="button" onClick={() => changeRejection(creatorSource(c), true)}
                          disabled={Boolean(savingRejection)}
                          className="rounded-lg px-2 py-2 text-[11px] text-slate-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50">이 자막은 아니야</button>
                        <button
                          onClick={() => handleSelectCreator(c)}
                          disabled={isLoading || isCurrent}
                          className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition shadow-md ${
                            isCurrent
                              ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                              : isLoading
                              ? "bg-purple-600/50 text-white cursor-wait"
                              : "bg-purple-600 text-white hover:bg-purple-500 active:scale-95"
                          }`}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              다운로드 중...
                            </>
                          ) : isCurrent ? (
                            "적용됨"
                          ) : (
                            c.localArchive ? "Pi 로컬 자막 적용" : "이 제작자 자막 적용"
                          )}
                        </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Manual Title Search */}
          {activeTab === "search" && (
            <div className="space-y-4">
              <form onSubmit={handleSearch} className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  placeholder="한국어 작품명 입력 (예: 귀멸의 칼날, 장송의 프리렌)"
                  className="flex-1 rounded-xl border border-purple-500/30 bg-slate-900/90 px-4 py-2.5 text-xs text-white placeholder-slate-500 outline-none focus:border-purple-400"
                />
                <input
                  type="number"
                  value={searchEp}
                  onChange={(e) => setSearchEp(parseInt(e.target.value, 10) || 1)}
                  className="w-20 rounded-xl border border-purple-500/30 bg-slate-900/90 px-3 py-2.5 text-xs font-bold text-center text-white outline-none focus:border-purple-400"
                  min={1}
                />
                <button
                  type="submit"
                  disabled={isSearching || isSearchingLocal}
                  className="flex items-center gap-1.5 rounded-xl bg-purple-600 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-purple-600/30 transition hover:bg-purple-500 disabled:opacity-50"
                >
                  {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  온라인 검색
                </button>
                <button
                  type="button"
                  onClick={handleLocalSearch}
                  disabled={isSearching || isSearchingLocal}
                  className="flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs font-bold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
                >
                  {isSearchingLocal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Pi 로컬 검색
                </button>
              </form>

              {searchError && (
                <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-400">
                  {searchError}
                </div>
              )}

              {/* Search Results */}
              <div className="space-y-2">
                {visibleSearchResults.map((sub, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-4 hover:border-purple-500/40 transition"
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-xs">{sub.name}</span>
                        {sub.sourceProvider && <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${sub.sourceProvider === "aniall" ? "bg-amber-500/15 text-amber-200" : "bg-cyan-500/15 text-cyan-200"}`}>{sub.sourceProvider === "aniall" ? "AniAll" : "애니시아"}</span>}
                        {sub.localArchive && <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">Pi 로컬</span>}
                        {sub.verifiedMatch ? (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">DB 연결 확인</span>
                        ) : typeof sub.matchScore === "number" ? (
                          <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-bold text-sky-300">제목 매칭 {sub.matchScore}점</span>
                        ) : null}
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold ${
                            sub.is_ass
                              ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                              : "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                          }`}
                        >
                          {sub.format}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 line-clamp-1">
                        {sub.matchedTitle ? `${sub.sourceProvider === "aniall" ? "DB 작품명" : "애니시아"}: ${sub.matchedTitle} · ` : ""}자막 내용 {sub.content?.length || 0}자 포함
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                    <button type="button" onClick={() => changeRejection(subtitleSource(sub), true)}
                      disabled={Boolean(savingRejection)}
                      className="rounded-lg px-2 py-2 text-[11px] text-slate-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50">이 자막은 아니야</button>
                    <button
                      onClick={() => {
                        onSelectSubtitle(sub);
                        onClose();
                      }}
                      className="rounded-xl bg-purple-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-purple-500 active:scale-95"
                    >
                      선택
                    </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tab 3: Local File Upload */}
          {activeTab === "file" && (
            <div className="space-y-4">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition ${
                  isDragging
                    ? "border-purple-400 bg-purple-950/30"
                    : "border-purple-500/30 bg-slate-900/40 hover:border-purple-500 hover:bg-slate-900/60"
                }`}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-purple-600/20 text-purple-400 mb-3 border border-purple-500/30">
                  <Upload className="h-6 w-6" />
                </div>
                <h4 className="text-sm font-bold text-white">자막 파일을 이곳에 드래그하거나 클릭하여 선택하세요</h4>
                <p className="mt-1 text-xs text-slate-400">
                  지원 확장자: <strong>.ass, .ssa, .srt, .smi, .vtt, .zip</strong> · ZIP은 회차별로 나눠 Pi에 저장
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".ass,.ssa,.srt,.smi,.vtt,.zip"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>

              {fileError && (
                <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-400">
                  {fileError}
                </div>
              )}
              {fileNotice && (
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs text-emerald-300">
                  {fileNotice}
                </div>
              )}

              {uploadedSub && (
                <div className="flex items-center justify-between rounded-2xl border border-emerald-500/40 bg-emerald-950/20 p-4">
                  <div className="flex items-center gap-3">
                    <FileText className="h-6 w-6 text-emerald-400" />
                    <div>
                      <h5 className="text-xs font-bold text-white">{uploadedSub.name}</h5>
                      <span className="text-[11px] text-emerald-400 font-semibold">
                        형식: {uploadedSub.format} • 준비 완료
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      onSelectSubtitle(uploadedSub);
                      onClose();
                    }}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-500 shadow-lg shadow-emerald-600/30"
                  >
                    이 자막으로 재생
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
