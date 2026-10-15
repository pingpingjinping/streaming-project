"use client";
import SubtitleFolderAssignments from "./SubtitleFolderAssignments";
import {parseBundleScope,bundleSelectionMatches} from "@/lib/subtitleLocalIdentity";
import {readEpisodeEvidence} from "@/lib/subtitleEpisodes";
import SubtitleEpisodeExceptions from "./SubtitleEpisodeExceptions";

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
  sourceProvider?: "aniall" | "anissia" | "naver";
  localArchive?: boolean;
}

export interface SubtitleOption {
  temporary?: boolean;
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
  sourceProvider?: "aniall" | "anissia" | "naver";
  isCached?: boolean;
  localArchive?: boolean;
  localArchiveTrackKey?: string;
  reviewedFileId?: string;
  localFileId?: string;
  episodeConfirmed?: boolean;
  episodeException?: boolean;
  sourceFolderKey?:string;sourceFolderLabel?:string;
  sourceBundleKey?: string;
  sourceBundleLabel?: string;
  bundleAssigned?: boolean;
  orig_filename?: string;
}

type LocalSubtitleFolderChoice = { folderName: string;folderKey?:string;archivePath?:string;entryType?:"folder"|"zip";provider:"aniall"|"anissia"|"naver" };
const creatorKey = (creator: CreatorInfo) => `${creator.website}\n${creator.matchedTitle || ""}`;
type RejectedSource = { provider: string; sourceKey: string };
type BundleAssignment = {
  animeId: string;
  provider: "aniall" | "anissia" | "naver";
  bundleKey: string;
  label: string;
  exclusive: boolean;
};
const rejectionId = (provider: string, sourceKey: string) => JSON.stringify([provider, sourceKey]);
const creatorSource = (creator: CreatorInfo): RejectedSource => ({
  provider: creator.localArchive ? creator.sourceProvider || "local" : creator.website ? creator.sourceProvider || "anissia" : "local",
  sourceKey: creator.website || creator.name,
});
const subtitleSource = (subtitle: SubtitleOption): RejectedSource => ({
  provider: subtitle.localArchive ? subtitle.sourceProvider || "local" : subtitle.sourceCreatorWebsite ? subtitle.sourceProvider || "anissia" : "local",
  sourceKey: subtitle.reviewedFileId ? `reviewed:${subtitle.reviewedFileId}` : subtitle.localArchive && subtitle.sourceProvider === "anissia"
    ? subtitle.name
    : subtitle.sourceCreatorWebsite || (subtitle.localArchive ? subtitle.name : subtitle.url || subtitle.name),
});

const subtitleDisplayName = (subtitle: SubtitleOption) => subtitle.localArchive && subtitle.sourceProvider === "anissia" && subtitle.sourceFolderLabel
  ? `${subtitle.sourceFolderLabel} · ${subtitle.name}` : subtitle.name;

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
  const [searchCreators, setSearchCreators] = useState<CreatorInfo[]>([]);
  const [catalogTitles, setCatalogTitles] = useState<Array<{ title: string; sources: string[] }>>([]);
  const [localFolders, setLocalFolders] = useState<LocalSubtitleFolderChoice[]>([]);
  const [selectedLocalFolder, setSelectedLocalFolder] = useState<LocalSubtitleFolderChoice | null>(null);
  const [selectedFolderSubtitles, setSelectedFolderSubtitles] = useState<SubtitleOption[]>([]);
  const [isLoadingSelectedFolder, setIsLoadingSelectedFolder] = useState(false);
  const [showOtherLocalResults, setShowOtherLocalResults] = useState(false);
  const selectedFolderRequestRef = useRef(0);
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
  const [exceptionCandidate,setExceptionCandidate]=useState<SubtitleOption|null>(null);
  const [subtitleSettingsRevision,setSubtitleSettingsRevision]=useState(0);
  useEffect(()=>{
    const changed=(event:Event)=>{
      if((event as CustomEvent).detail?.animeId===animeId)setSubtitleSettingsRevision(value=>value+1);
    };
    window.addEventListener('subtitle-settings-changed',changed);
    return()=>window.removeEventListener('subtitle-settings-changed',changed);
  },[animeId]);
  const [bundleAssignment, setBundleAssignment] = useState<BundleAssignment | null>(null);
  const [savingBundleKey, setSavingBundleKey] = useState("");
  const [bundleNotice, setBundleNotice] = useState<string | null>(null);

  // File upload states
  const [uploadedSub, setUploadedSub] = useState<SubtitleOption | null>(null);
  const [uploadedSubOptions, setUploadedSubOptions] = useState<SubtitleOption[]>([]);
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
      selectedFolderRequestRef.current++;
      setSelectedLocalFolder(null);
      setSelectedFolderSubtitles([]);
      setShowOtherLocalResults(false);
      setFileError(null);
      setFileNotice(null);
      setExceptionCandidate(null);
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

  useEffect(() => {
    if (!isOpen || !animeId) return;
    let cancelled = false;
    setBundleNotice(null);
    fetch(`/api/anime/subtitle-bundle?animeId=${encodeURIComponent(animeId)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "묶음 지정을 불러오지 못했습니다.");
        return data;
      })
      .then((data) => { if (!cancelled) setBundleAssignment(data.assignment || null); })
      .catch((error) => { if (!cancelled) setBundleNotice(error.message || "묶음 지정을 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, [isOpen, animeId,subtitleSettingsRevision]);

  const isRejected = ({ provider, sourceKey }: RejectedSource) =>
    rejectedSources.some((entry) => rejectionId(entry.provider, entry.sourceKey) === rejectionId(provider, sourceKey));
  const visibleCreators = creators.filter((creator) => !isRejected(creatorSource(creator)));
  const visibleLocalArchiveOptions = localArchiveOptions.filter((option) => !isRejected(subtitleSource(option)));
  const visibleSearchResults = searchResults.filter((option) => !isRejected(subtitleSource(option)));
  const visibleSearchCreators = searchCreators.filter((creator) => !isRejected(creatorSource(creator)));

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

  const selectLocalSubtitle=async(subtitle:SubtitleOption)=>{
    if(savingBundleKey)return;
    try {
      const scope=subtitle.sourceFolderKey ? parseBundleScope(subtitle.sourceFolderKey) : null;
      if(!subtitle.episodeException && ((scope?.type==='folder' && subtitle.localFileId)
        || (parseBundleScope(subtitle.sourceBundleKey || '')?.type==='reviewed' && subtitle.reviewedFileId))) {
        setSavingBundleKey(`${subtitle.sourceProvider}:${subtitle.sourceBundleKey}`);setBundleNotice(null);
        const response=await fetch('/api/anime/subtitle-bundle',{method:'PUT',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({animeId,provider:subtitle.sourceProvider,bundleKey:subtitle.sourceFolderKey || subtitle.sourceBundleKey,fileId:subtitle.localFileId || subtitle.reviewedFileId})});
        const data=await response.json();if(!response.ok || !data.success)throw new Error(data.message || '버전을 저장하지 못했습니다.');
        setBundleAssignment(data.assignment);window.dispatchEvent(new CustomEvent('subtitle-settings-changed',{detail:{animeId}}));
      }
      onSelectSubtitle(subtitle);onClose();
    }catch(error){setBundleNotice(error instanceof Error?error.message:'버전을 저장하지 못했습니다.');}
    finally{setSavingBundleKey('');}
  };
  const selectThisEpisodeSubtitle = async (subtitle: SubtitleOption) => {
    if (savingBundleKey) return;
    const fileId = subtitle.localFileId || subtitle.reviewedFileId;
    if (!subtitle.sourceProvider || !fileId || !Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 10000) {
      setBundleNotice('이번 화에 지정할 파일과 회차를 확인해 주세요.');
      return;
    }
    setSavingBundleKey(`episode:${subtitle.sourceProvider}:${fileId}`);
    setBundleNotice(null);
    try {
      const response = await fetch('/api/anime/subtitle-exceptions', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ animeId, episodeNumber, provider: subtitle.sourceProvider, fileId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '이번 화 지정을 저장하지 못했습니다.');
      onSelectSubtitle({ ...subtitle, ...data.subtitle, episodeException: true });
      onClose();
      window.dispatchEvent(new CustomEvent('subtitle-settings-changed', { detail: { animeId } }));
    } catch (error) {
      setBundleNotice(error instanceof Error ? error.message : '이번 화 지정을 저장하지 못했습니다.');
    } finally {
      setSavingBundleKey('');
    }
  };
  const assignBundle = async (subtitle: SubtitleOption) => {
    if (!subtitle.localArchive || !subtitle.sourceProvider || !subtitle.sourceBundleKey || savingBundleKey) return;
    const key = `${subtitle.sourceProvider}:${subtitle.sourceBundleKey}`;
    setSavingBundleKey(key);
    setBundleNotice(null);
    try {
      const response = await fetch("/api/anime/subtitle-bundle", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          animeId,
          provider: subtitle.sourceProvider,
          bundleKey: subtitle.sourceFolderKey || subtitle.sourceBundleKey,
          fileId:subtitle.reviewedFileId || subtitle.localFileId,
          label: subtitle.sourceBundleLabel || subtitle.sourceMatchedTitle || subtitle.matchedTitle || animeTitle,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "자막 묶음을 지정하지 못했습니다.");
      setBundleAssignment(data.assignment || null);
      window.dispatchEvent(new CustomEvent("subtitle-settings-changed",{detail:{animeId}}));
      onSelectSubtitle({ ...subtitle, bundleAssigned: true });
      onClose();
    } catch (error) {
      setBundleNotice(error instanceof Error ? error.message : "자막 묶음을 지정하지 못했습니다.");
    } finally {
      setSavingBundleKey("");
    }
  };

  const clearBundleAssignment = async () => {
    if (!bundleAssignment || savingBundleKey) return;
    setSavingBundleKey("clear");
    setBundleNotice(null);
    try {
      const response = await fetch(`/api/anime/subtitle-bundle?animeId=${encodeURIComponent(animeId)}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "묶음 지정을 해제하지 못했습니다.");
      setBundleAssignment(null);
      setBundleNotice("작품 전체 묶음 지정을 해제했어. 다시 자동 매칭으로 돌아가.");
      window.dispatchEvent(new CustomEvent("subtitle-settings-changed",{detail:{animeId}}));
    } catch (error) {
      setBundleNotice(error instanceof Error ? error.message : "묶음 지정을 해제하지 못했습니다.");
    } finally {
      setSavingBundleKey("");
    }
  };

  useEffect(() => {
    if (!isOpen) {
      setLocalArchiveOptions([]);
      return;
    }
    let cancelled = false;
    setIsLoadingLocalArchives(true);
    setLocalArchiveOptions([]);
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
          sourceProvider: subtitle.sourceProvider || "aniall",
          sourceCreatorWebsite: subtitle.sourceCreatorWebsite,
          sourceMatchedTitle: subtitle.sourceMatchedTitle,
          localArchive: true,
          localArchiveTrackKey: subtitle.localArchiveTrackKey,
          reviewedFileId: subtitle.reviewedFileId,
          localFileId:subtitle.localFileId,episodeConfirmed:subtitle.episodeConfirmed,episodeException:subtitle.episodeException,
          sourceFolderKey:subtitle.sourceFolderKey,sourceFolderLabel:subtitle.sourceFolderLabel,
          sourceBundleKey: subtitle.sourceBundleKey,
          sourceBundleLabel: subtitle.sourceBundleLabel,
          bundleAssigned: Boolean(subtitle.bundleAssigned),
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
  }, [isOpen, animeId, animeTitle, episodeNumber,subtitleSettingsRevision]);

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
  const handleSelectCreator = async (creator: CreatorInfo, requestedEpisode = episodeNumber, requestedTitle = searchKeyword || animeTitle) => {
    if ((!creator.website && !creator.localArchive) || loadingCreator) return;
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
          title: requestedTitle,
          matchedTitle: creator.matchedTitle,
          episodeNumber: requestedEpisode,
          creatorEpisode: creator.episode,
          sourceProvider: creator.sourceProvider,
          localArchive: creator.localArchive,
          animeId,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success || !data.subtitle) {
        throw new Error(data.message || "해당 제작자의 이번 회차 자막을 가져오지 못했습니다.");
      }

      const newSub: SubtitleOption = {
        name: `(${creator.name}) ${data.subtitle.orig_filename || `${requestedEpisode}화 자막`}${data.subtitle.temporary ? " · 임시" : ""}`,
        temporary: Boolean(data.subtitle.temporary),
        format: data.subtitle.is_ass ? "ASS" : "VTT",
        is_ass: Boolean(data.subtitle.is_ass),
        content: data.subtitle.content,
        url: data.subtitle.url,
        sourceCreatorWebsite: creator.website,
        sourceMatchedTitle: creator.matchedTitle,
        sourceProvider: creator.sourceProvider,
        localArchive: Boolean(creator.localArchive),
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
  const handleSearch = async (e?: React.FormEvent, keywordOverride?: string) => {
    if (e) e.preventDefault();
    const keyword = (keywordOverride || searchKeyword).trim();
    if (keywordOverride) setSearchKeyword(keywordOverride);
    if (!keyword) return;

    setIsSearching(true);
    setSearchError(null);
    setSearchResults([]);
    setSearchCreators([]);
    setLocalFolders([]);
    selectedFolderRequestRef.current++;
    setSelectedLocalFolder(null);
    setSelectedFolderSubtitles([]);
    setShowOtherLocalResults(false);
    setCatalogTitles([]);

    try {
      const catalogRes = await fetch(`/api/anime/subtitles/catalog?q=${encodeURIComponent(keyword)}`);
      const catalogData = await catalogRes.json();
      if (catalogRes.ok && catalogData.success) setCatalogTitles(catalogData.titles || []);
    } catch { /* Online lookup still works if DB title search fails. */ }

    try {
      const res = await fetch(
        `/api/anime/subtitles?mode=online&title=${encodeURIComponent(keyword)}&ep=${searchEp}&animeId=${encodeURIComponent(animeId)}&referenceTitle=${encodeURIComponent(animeTitle)}`
      );
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "자막 검색 실패");
      }

      const subs: SubtitleOption[] = (data.subtitles || []).map((s: any) => ({
        name: s.name,
        format: s.is_ass ? "ASS" : "VTT",
        is_ass: Boolean(s.is_ass),
        temporary: Boolean(s.temporary),
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
        localArchiveTrackKey: s.localArchiveTrackKey,
        reviewedFileId: s.reviewedFileId,
        localFileId:s.localFileId,episodeConfirmed:s.episodeConfirmed,episodeException:s.episodeException,
        sourceFolderKey:s.sourceFolderKey,sourceFolderLabel:s.sourceFolderLabel,
        sourceBundleKey: s.sourceBundleKey,
        sourceBundleLabel: s.sourceBundleLabel,
        bundleAssigned: Boolean(s.bundleAssigned),
      }));

      // The server has already grouped these in the configured provider order.
      setSearchResults(subs);
      const foundCreators: CreatorInfo[] = (data.creators || []).filter((creator: CreatorInfo) => creator.website);
      setSearchCreators(foundCreators);
      if (subs.length === 0 && foundCreators.length === 0) {
        setSearchError("해당 회차의 온라인 자막은 없거나 읽을 수 없어. DB 작품 제목을 선택해 다시 찾아 봐.");
      }
    } catch (err: any) {
      setSearchError(err.message || "자막을 검색하는 중 오류가 발생했습니다.");
    } finally {
      setIsSearching(false);
    }
  };

  const handleLocalSearch = async (keywordOverride?: string, archivePath?: string) => {
    const keyword = (keywordOverride || searchKeyword).trim();
    if (keywordOverride) setSearchKeyword(keywordOverride);
    if (!keyword) return;
    setIsSearchingLocal(true);
    setSearchError(null);
    setSearchResults([]);
    setSearchCreators([]);
    setCatalogTitles([]);
    setLocalFolders([]);
    selectedFolderRequestRef.current++;
    setSelectedLocalFolder(null);
    setSelectedFolderSubtitles([]);
    setShowOtherLocalResults(false);
    try {
      const folderRes = await fetch(`/api/anime/subtitles/local?mode=folders&title=${encodeURIComponent(keyword)}&ep=${searchEp}&animeId=${encodeURIComponent(animeId)}`);
      const folderData = await folderRes.json();
      if (folderRes.ok && folderData.success) setLocalFolders(folderData.folders || []);
      const res = await fetch(
        `/api/anime/subtitles/local?mode=search&title=${encodeURIComponent(keyword)}&ep=${searchEp}&animeId=${encodeURIComponent(animeId)}${archivePath ? `&archivePath=${encodeURIComponent(archivePath)}` : ""}`
      );
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "로컬 자막 검색 실패");
      const subs: SubtitleOption[] = (data.subtitles || []).map((s: any) => ({
        name: s.name,
        orig_filename: s.orig_filename,
        format: s.is_ass ? "ASS" : "VTT",
        is_ass: Boolean(s.is_ass),
        temporary: Boolean(s.temporary),
        content: s.content || "",
        url: s.url || "",
        matchScore: s.matchScore,
        matchedTitle: s.matchedTitle || s.sourceMatchedTitle,
        verifiedMatch: s.verifiedMatch,
        sourceProvider: s.sourceProvider,
        sourceCreatorWebsite: s.sourceCreatorWebsite,
        sourceMatchedTitle: s.sourceMatchedTitle,
        localArchive: Boolean(s.localArchive),
        localArchiveTrackKey: s.localArchiveTrackKey,
        reviewedFileId: s.reviewedFileId,
        localFileId:s.localFileId,episodeConfirmed:s.episodeConfirmed,episodeException:s.episodeException,
        sourceFolderKey:s.sourceFolderKey,sourceFolderLabel:s.sourceFolderLabel,
        sourceBundleKey: s.sourceBundleKey,
        sourceBundleLabel: s.sourceBundleLabel,
        bundleAssigned: Boolean(s.bundleAssigned),
      }));
      setSearchResults(subs);
      if (subs.length === 0) setSearchError("해당 회차의 로컬 자막은 없거나 읽을 수 없어. 위 폴더·ZIP 후보에서 골라 확인해 봐.");
    } catch (err: any) {
      setSearchError(err.message || "로컬 자막을 검색하는 중 오류가 발생했습니다.");
    } finally {
      setIsSearchingLocal(false);
    }
  };


  // Inspect the exact physical folder/ZIP without replacing the broad search.
  const openLocalFolder = async (folder: LocalSubtitleFolderChoice) => {
    const token = ++selectedFolderRequestRef.current;
    setSelectedLocalFolder(folder);
    setSelectedFolderSubtitles([]);
    setShowOtherLocalResults(false);
    setIsLoadingSelectedFolder(true);
    setSearchError(null);
    try {
      const params = new URLSearchParams({
        mode: "search", title: folder.folderName, ep: String(searchEp), animeId,
      });
      if (folder.archivePath) params.set("archivePath", folder.archivePath);
      const response = await fetch(`/api/anime/subtitles/local?${params.toString()}`);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "선택한 폴더의 자막을 읽지 못했습니다.");
      const candidates: SubtitleOption[] = (data.subtitles || []).map((s: any) => ({
        name: s.name,
        orig_filename: s.orig_filename,
        format: s.is_ass ? "ASS" : "VTT",
        is_ass: Boolean(s.is_ass),
        temporary: Boolean(s.temporary),
        content: s.content || "",
        url: s.url || "",
        matchScore: s.matchScore,
        matchedTitle: s.matchedTitle || s.sourceMatchedTitle,
        verifiedMatch: s.verifiedMatch,
        sourceProvider: s.sourceProvider,
        sourceCreatorWebsite: s.sourceCreatorWebsite,
        sourceMatchedTitle: s.sourceMatchedTitle,
        localArchive: Boolean(s.localArchive),
        localArchiveTrackKey: s.localArchiveTrackKey,
        reviewedFileId: s.reviewedFileId,
        localFileId:s.localFileId,episodeConfirmed:s.episodeConfirmed,episodeException:s.episodeException,
        sourceFolderKey:s.sourceFolderKey,sourceFolderLabel:s.sourceFolderLabel,
        sourceBundleKey: s.sourceBundleKey,
        sourceBundleLabel: s.sourceBundleLabel,
        bundleAssigned: Boolean(s.bundleAssigned),
      }));
      // A similarly titled season, movie, or special must never enter this panel.
      const exact = folder.entryType === "zip" ? candidates : candidates.filter((subtitle) => {
        const scope = parseBundleScope(subtitle.sourceFolderKey || "");
        return scope?.type === "folder" && scope.provider === folder.provider && scope.work === folder.folderName;
      });
      if (selectedFolderRequestRef.current === token) setSelectedFolderSubtitles(exact);
    } catch (error) {
      if (selectedFolderRequestRef.current === token)
        setSearchError(error instanceof Error ? error.message : "폴더 자막 검색 실패");
    } finally {
      if (selectedFolderRequestRef.current === token) setIsLoadingSelectedFolder(false);
    }
  };

  const belongsToSelectedFolder = (subtitle: SubtitleOption, folder: LocalSubtitleFolderChoice): boolean => {
    const scope = parseBundleScope(subtitle.sourceFolderKey || "");
    if (scope?.type === "folder") return scope.provider === folder.provider && scope.work === folder.folderName;
    // Archive paths are passed to the server for exact ZIP retrieval.
    return folder.entryType === "zip" && subtitle.sourceProvider === folder.provider
      && subtitle.name.includes(folder.folderName);
  };
  const selectedVisibleResults = [...selectedFolderSubtitles.filter(option => !isRejected(subtitleSource(option)))].sort((a,b) => {
    const episodeOf = (option: SubtitleOption) => {
      const evidence = readEpisodeEvidence(option.orig_filename || option.name, true);
      return evidence.episodes.length === 1 ? evidence.episodes[0] : Number.MAX_SAFE_INTEGER;
    };
    return episodeOf(a) - episodeOf(b) || (a.orig_filename || a.name).localeCompare(b.orig_filename || b.name, "ko", {numeric:true});
  });
  const selectedIds = new Set(selectedVisibleResults.map(s => s.localFileId || s.reviewedFileId || s.name));
  const otherVisibleResults = selectedLocalFolder
    ? visibleSearchResults.filter(s => !belongsToSelectedFolder(s, selectedLocalFolder)
      && !selectedIds.has(s.localFileId || s.reviewedFileId || s.name))
    : visibleSearchResults;
  const otherLocalFolders = selectedLocalFolder
    ? localFolders.filter(f => f.provider !== selectedLocalFolder.provider
      || (f.archivePath || f.folderName) !== (selectedLocalFolder.archivePath || selectedLocalFolder.folderName))
    : localFolders;

  // Open a subtitle file directly, or unpack and save an episode ZIP on the Pi.
  const processSubtitleFile = async (file: File) => {
    setFileError(null);
    setFileNotice(null);
    setUploadedSub(null);
    setUploadedSubOptions([]);
    const fileName = file.name;
    const lowerName = fileName.toLowerCase();

    if (lowerName.endsWith(".zip")) {
      try {
        const form = new FormData();
        form.set("animeId", animeId);
        form.set("title", animeTitle);
        form.set("ep", String(episodeNumber || 1));
        form.set("file", file);
        form.set("mode", "open");
        const response = await fetch("/api/anime/uploaded-subtitle", { method: "POST", body: form });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.message || "ZIP 자막을 Pi에 저장하지 못했습니다.");
        }
        const saved = Array.isArray(data.saved) ? data.saved : [];
        const storedOptions: SubtitleOption[] = (Array.isArray(data.subtitles)
          ? data.subtitles : data.subtitle ? [data.subtitle] : []).map((subtitle: any) => ({
            name: subtitle.name || "Pi 저장: " + subtitle.orig_filename || fileName,
            format: subtitle.format === "ASS" || subtitle.is_ass ? "ASS" : "VTT",
            is_ass: Boolean(subtitle.is_ass),
            content: subtitle.content || "",
          }));
        setUploadedSubOptions(storedOptions);
        setFileNotice(storedOptions.length
          ? "Pi에 " + saved.length + "개 회차 저장 · 현재 " + episodeNumber + "화 후보 " + storedOptions.length + "개 저장 완료. 아래에서 골라 재생해."
          : "Pi에 " + saved.length + "개 회차 저장 · 현재 " + episodeNumber + "화 자막은 ZIP에 없어");
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

  const renderSearchCard = (sub: SubtitleOption, idx: number) => (
                  <div
                    key={sub.localFileId || sub.reviewedFileId || `${idx}-${sub.name}`}
                    className="flex min-w-0 flex-col items-stretch gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-4 hover:border-purple-500/40 transition"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="w-full min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] font-bold leading-relaxed text-white text-xs">{subtitleDisplayName(sub)}</span>
                        {sub.sourceProvider && <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${sub.sourceProvider === "aniall" ? "bg-amber-500/15 text-amber-200" : "bg-cyan-500/15 text-cyan-200"}`}>{sub.sourceProvider === "aniall" ? "AniAll" : sub.sourceProvider === "naver" ? "네이버" : "애니시아"}</span>}
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
                      <p className="text-[11px] text-slate-400 whitespace-normal break-words [overflow-wrap:anywhere]">
                        {sub.matchedTitle ? `${sub.sourceProvider === "anissia" ? "애니시아" : "DB 작품명"}: ${sub.matchedTitle} · ` : ""}자막 내용 {sub.content?.length || 0}자 포함
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {sub.localArchive && sub.sourceProvider && sub.sourceBundleKey && (
                      <button type="button" onClick={() => assignBundle(sub)}
                        disabled={Boolean(savingBundleKey) || Boolean(bundleAssignment
                          && bundleAssignment.provider === sub.sourceProvider
                          && bundleSelectionMatches(bundleAssignment.bundleKey,sub.sourceBundleKey!))}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:bg-emerald-950/50 disabled:text-emerald-300">
                        {bundleAssignment && bundleAssignment.provider === sub.sourceProvider
                          && bundleSelectionMatches(bundleAssignment.bundleKey,sub.sourceBundleKey!)
                          ? "작품 지정됨"
                          : savingBundleKey === `${sub.sourceProvider}:${sub.sourceBundleKey}` ? "지정 중…" : sub.sourceFolderKey ? "이 버전 계속" : "작품 전체 지정"}
                      </button>
                    )}
                    {sub.localArchive && sub.sourceProvider && (sub.reviewedFileId || sub.localFileId) && <button type="button"
                      onClick={() => selectThisEpisodeSubtitle(sub)} disabled={Boolean(savingBundleKey)}
                      className="rounded-lg border border-cyan-500/40 px-3 py-2 text-[11px] font-bold text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50">
                      {savingBundleKey === `episode:${sub.sourceProvider}:${sub.localFileId || sub.reviewedFileId}` ? "저장 중…" : "이번 화만 지정"}
                    </button>}
                    {sub.localArchive && (sub.reviewedFileId || sub.localFileId) && <button type="button" onClick={()=>{setExceptionCandidate(sub);setActiveTab("creators");}}
                      className="rounded-lg border border-amber-500/40 px-3 py-2 text-[11px] font-bold text-amber-200">예외 만들기</button>}
                    <button type="button" onClick={() => changeRejection(subtitleSource(sub), true)}
                      disabled={Boolean(savingRejection)}
                      className="rounded-lg px-2 py-2 text-[11px] text-slate-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50">이 자막은 아니야</button>
                    <button
                      disabled={Boolean(savingBundleKey)}
                      onClick={() => {
                        selectLocalSubtitle(sub);
                      }}
                      className="rounded-xl bg-purple-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-purple-500 active:scale-95"
                    >
                      {!sub.episodeException && (sub.sourceFolderKey || sub.reviewedFileId) ? "선택 · 다음 화 유지" : "현재 화 선택"}
                    </button>
                    </div>
                  </div>
  );

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
                <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                  작품·시즌별 묶음을 지정하면 회차가 확인된 자막을 다음 화에도 찾아. OVA·특전은 별도로 고르거나 회차별 예외로 저장할 수 있어.
                </p>
                {bundleAssignment && (
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <span className="font-bold text-emerald-200">작품 전체 지정됨</span>
                      <span className="ml-2 text-slate-300">{bundleAssignment.provider} · {bundleAssignment.label || bundleAssignment.bundleKey}</span>
                    </div>
                    <button type="button" onClick={clearBundleAssignment} disabled={Boolean(savingBundleKey)}
                      className="shrink-0 rounded-lg border border-slate-600 px-2.5 py-1.5 font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-50">
                      지정 해제
                    </button>
                  </div>
                )}
                {bundleNotice && <p className="mb-2 text-[11px] text-emerald-200">{bundleNotice}</p>}
                <SubtitleEpisodeExceptions animeId={animeId} animeTitle={animeTitle} currentEpisode={episodeNumber || 1}
                  candidate={exceptionCandidate} onCancel={()=>setExceptionCandidate(null)} onSaved={(subtitle,ep)=>{
                    if(ep===(episodeNumber || 1)) {onSelectSubtitle(subtitle);onClose();}
                  }} />
                <SubtitleFolderAssignments animeId={animeId} choices={localArchiveOptions} onSaved={setBundleAssignment} />
                {visibleLocalArchiveOptions.length ? (
                  <div className="space-y-2">
                    {visibleLocalArchiveOptions.map((subtitle, index) => (
                      <div key={`${subtitle.name}-${index}`} className="flex min-w-0 flex-col gap-2">
                        <button type="button"
                          disabled={Boolean(savingBundleKey)}
                          onClick={() => selectLocalSubtitle(subtitle)}
                          className="flex w-full min-w-0 flex-col items-start gap-2 rounded-xl border border-emerald-500/20 bg-slate-900/70 px-3 py-2 text-left hover:border-emerald-400/50 hover:bg-slate-900">
                          <span className="w-full min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] text-sm font-semibold leading-relaxed text-white">{subtitleDisplayName(subtitle)}</span>
                          <span className="shrink-0 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-300">{!subtitle.episodeException && (subtitle.sourceFolderKey || subtitle.reviewedFileId) ? "현재 화 선택 · 다음 화 유지" : "현재 화 적용"}</span>
                        </button>
                        <div className="flex flex-wrap items-center gap-2">
                        {subtitle.sourceProvider && subtitle.sourceBundleKey && (
                          <button type="button" onClick={() => assignBundle(subtitle)}
                            disabled={Boolean(savingBundleKey) || Boolean(bundleAssignment
                              && bundleAssignment.provider === subtitle.sourceProvider
                              && bundleSelectionMatches(bundleAssignment.bundleKey,subtitle.sourceBundleKey!))}
                            className="shrink-0 rounded-lg bg-purple-600 px-2.5 py-2 text-[11px] font-bold text-white hover:bg-purple-500 disabled:bg-emerald-950/50 disabled:text-emerald-300">
                            {bundleAssignment && bundleAssignment.provider === subtitle.sourceProvider
                              && bundleSelectionMatches(bundleAssignment.bundleKey,subtitle.sourceBundleKey!)
                              ? "작품 지정됨"
                              : savingBundleKey === `${subtitle.sourceProvider}:${subtitle.sourceBundleKey}` ? "지정 중…" : subtitle.sourceFolderKey ? "이 버전 계속" : "작품 전체 지정"}
                          </button>
                        )}
                        {subtitle.sourceProvider && (subtitle.reviewedFileId || subtitle.localFileId) && <button type="button"
                          onClick={() => selectThisEpisodeSubtitle(subtitle)} disabled={Boolean(savingBundleKey)}
                          className="shrink-0 rounded-lg border border-cyan-500/40 px-2.5 py-2 text-[11px] font-bold text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50">
                          {savingBundleKey === `episode:${subtitle.sourceProvider}:${subtitle.localFileId || subtitle.reviewedFileId}` ? "저장 중…" : "이번 화만 지정"}
                        </button>}
                        {(subtitle.reviewedFileId || subtitle.localFileId) && <button type="button" onClick={()=>setExceptionCandidate(subtitle)}
                          className="shrink-0 rounded-lg border border-amber-500/40 px-2.5 py-2 text-[11px] font-bold text-amber-200">예외 만들기</button>}
                        <button type="button" onClick={() => changeRejection(subtitleSource(subtitle), true)}
                          disabled={Boolean(savingRejection)}
                          className="shrink-0 rounded-lg px-2 py-2 text-[11px] text-slate-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50">이 자막은 아니야</button>
                        </div>
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
                            <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${c.sourceProvider === "aniall" ? "bg-amber-500/15 text-amber-200" : "bg-cyan-500/15 text-cyan-200"}`}>{c.sourceProvider === "aniall" ? "AniAll" : c.sourceProvider === "naver" ? "네이버" : "애니시아"}</span>
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

                        <div className="flex flex-wrap items-center gap-2">
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
                  placeholder="작품명 또는 Pi 폴더·ZIP 이름 일부 입력 (예: 책벌레)"
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
                  onClick={() => handleLocalSearch()}
                  disabled={isSearching || isSearchingLocal}
                  className="flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs font-bold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
                >
                  {isSearchingLocal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Pi 로컬 검색
                </button>
              </form>

              {bundleNotice && <p className="text-sm text-emerald-200">{bundleNotice}</p>}
              {searchError && (
                <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-400">
                  {searchError}
                </div>
              )}

              {catalogTitles.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-300">DB 작품 제목 ({catalogTitles.length})</p>
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/40 p-2">
                    {catalogTitles.map((item) => (
                      <button type="button" key={item.title} onClick={() => handleSearch(undefined, item.title)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-white/10">
                        <span className="text-white">{item.title}</span>
                        <span className="shrink-0 text-slate-400">{item.sources.join(", ")}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-400">작품을 누르면 그 제목으로 온라인 자막을 찾아.</p>
                </div>
              )}

              {visibleSearchCreators.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-300">온라인 제작자 후보 ({visibleSearchCreators.length})</p>
                  {visibleSearchCreators.map((creator, index) => (
                    <div key={`${creatorKey(creator)}-${index}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900/60 p-3">
                      <div className="min-w-0 text-xs">
                        <p className="font-semibold text-white">{creator.matchedTitle || creator.name}</p>
                        <p className="truncate text-slate-400">{creator.name} · 최신 등록 {creator.episode || "알 수 없음"}화</p>
                      </div>
                      <button type="button" onClick={() => handleSelectCreator(creator, searchEp, searchKeyword)}
                        disabled={Boolean(loadingCreator)}
                        className="shrink-0 rounded-lg bg-purple-600 px-3 py-2 text-xs text-white disabled:opacity-50">
                        {loadingCreator === creatorKey(creator) ? "확인 중…" : "이 회차 확인"}
                      </button>
                    </div>
                  ))}
                  {creatorError && <p className="text-xs text-red-400">{creatorError}</p>}
                </div>
              )}


              {selectedLocalFolder ? (
                <section className="space-y-3 rounded-2xl border border-emerald-500/45 bg-emerald-950/15 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-bold text-emerald-200">선택한 {selectedLocalFolder.entryType === "zip" ? "ZIP" : "폴더"} · {selectedLocalFolder.folderName}</h3>
                      <p className="break-all text-[11px] text-slate-400">{selectedLocalFolder.provider} · {selectedLocalFolder.archivePath || selectedLocalFolder.folderName}</p>
                    </div>
                    <button type="button" onClick={() => { selectedFolderRequestRef.current++; setSelectedLocalFolder(null); setSelectedFolderSubtitles([]); setShowOtherLocalResults(false); }}
                      className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800">선택 해제</button>
                  </div>
                  <SubtitleFolderAssignments animeId={animeId} choices={[selectedLocalFolder, ...selectedFolderSubtitles]} onSaved={setBundleAssignment} />
                  {isLoadingSelectedFolder ? <p className="text-xs text-emerald-200">선택한 항목의 자막 확인 중…</p>
                    : selectedVisibleResults.length === 0 ? <p className="text-xs text-slate-400">선택한 항목에서 표시 가능한 자막을 찾지 못했어.</p>
                    : <>
                        <p className="text-xs font-semibold text-emerald-200">선택한 항목의 자막 ({selectedVisibleResults.length}) · 회차순</p>
                        <div className="space-y-2">{selectedVisibleResults.map(renderSearchCard)}</div>
                      </>}
                </section>
              ) : (
                <>
              {otherLocalFolders.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-300">Pi 로컬 폴더·ZIP ({otherLocalFolders.length})</p>
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/40 p-2">
                    {otherLocalFolders.map((folder, index) => (
                      <button type="button" key={`${folder.provider}-${folder.folderName}-${index}`}
                        onClick={() => void openLocalFolder(folder)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-white/10">
                        <span className="min-w-0 break-words [overflow-wrap:anywhere] text-white">{folder.folderName}{folder.archivePath && <span className="mt-1 block text-[10px] text-slate-500">{folder.archivePath}</span>}</span>
                        <span className="shrink-0 text-slate-400">{folder.provider === "aniall" ? "AniAll" : folder.provider === "naver" ? "Naver" : "Anissia"} · {folder.entryType === "zip" ? "ZIP" : "폴더"}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-400">폴더나 ZIP을 누르면 그 항목의 자막을 맨 위에 따로 표시해.</p>
                </div>
              )}
                  <div className="space-y-2">{visibleSearchResults.map(renderSearchCard)}</div>
                </>
              )}
              {selectedLocalFolder && (
                <section className="space-y-3 rounded-xl border border-white/15 bg-slate-950/30 p-3">
                  <button type="button" className="flex w-full items-center justify-between gap-3 text-left text-xs font-semibold text-slate-300 hover:text-white"
                    aria-expanded={showOtherLocalResults} onClick={() => setShowOtherLocalResults(value => !value)}>
                    <span>다른 검색 결과 · 폴더·ZIP {otherLocalFolders.length}개 / 자막 {otherVisibleResults.length}개</span>
                    <span>{showOtherLocalResults ? "접기 ▲" : "펼치기 ▼"}</span>
                  </button>
                  {showOtherLocalResults && (
                    <div className="space-y-3">
              {otherLocalFolders.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-300">Pi 로컬 폴더·ZIP ({otherLocalFolders.length})</p>
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/40 p-2">
                    {otherLocalFolders.map((folder, index) => (
                      <button type="button" key={`${folder.provider}-${folder.folderName}-${index}`}
                        onClick={() => void openLocalFolder(folder)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-white/10">
                        <span className="min-w-0 break-words [overflow-wrap:anywhere] text-white">{folder.folderName}{folder.archivePath && <span className="mt-1 block text-[10px] text-slate-500">{folder.archivePath}</span>}</span>
                        <span className="shrink-0 text-slate-400">{folder.provider === "aniall" ? "AniAll" : folder.provider === "naver" ? "Naver" : "Anissia"} · {folder.entryType === "zip" ? "ZIP" : "폴더"}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-400">폴더나 ZIP을 누르면 그 항목의 자막을 맨 위에 따로 표시해.</p>
                </div>
              )}
                      <div className="space-y-2">{otherVisibleResults.map(renderSearchCard)}</div>
                    </div>
                  )}
                </section>
              )}
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

              {uploadedSubOptions.length > 0 && (
                <div className="space-y-2 rounded-2xl border border-emerald-500/30 bg-emerald-950/10 p-4">
                  <div className="text-xs font-bold text-emerald-300">
                    Pi에 저장된 현재 {episodeNumber}화 자막 후보 {uploadedSubOptions.length}개
                  </div>
                  {uploadedSubOptions.map((option, index) => (
                    <div key={option.name + index} className="flex items-center justify-between gap-3 rounded-xl bg-slate-900/80 p-3">
                      <div className="min-w-0">
                        <div className="whitespace-normal break-words [overflow-wrap:anywhere] text-xs font-semibold leading-relaxed text-white">{option.name}</div>
                        <div className="mt-1 text-[11px] text-emerald-400">형식: {option.format} · Pi에 저장됨</div>
                      </div>
                      <button
                        onClick={() => { onSelectSubtitle(option); onClose(); }}
                        className="shrink-0 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-emerald-500"
                      >
                        이 자막으로 재생
                      </button>
                    </div>
                  ))}
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

