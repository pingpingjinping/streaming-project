"use client";
import VideoServerSelect from "./VideoServerSelect";

import { useEffect, useRef, useState, useCallback } from "react";
import { scaleAssFontSizes, subtitleRenderSize } from "@/lib/subtitlePresentation";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  Maximize2,
  Minimize2,
  RotateCcw,
  Clock,
  Target,
  Type,
  Subtitles,
  Sparkles,
  Search,
  Check,
  Loader2,
  FolderOpen,
  Settings,
} from "lucide-react";
import { EpisodeItem } from "./Player";
import SubtitleSelectModal, { CreatorInfo, SubtitleOption } from "./SubtitleSelectModal";
import type { ServerSource } from "@/lib/providers/types";
import { usePlayerFullscreen } from "./usePlayerFullscreen";
import { useContainedPlayerFrame } from "./useContainedPlayerFrame";
import { iframeSeekMessage, iframePausedState, syncIframeSubtitleClock, updateSubtitleHud, aspectFromPlayerMessage, type IframeSubtitleClock } from "@/lib/iframePlayback";
import SponsorSubtitleSyncModal from "./SponsorSubtitleSyncModal";
import { effectiveSubtitleOffset, formatSyncTime, type SponsorSubtitleSync } from "@/lib/sponsorSubtitleSync";
import PlayerSettingsModal, {
  DEFAULT_PLAYER_SETTINGS,
  loadPlayerSettings,
  fetchUserSettingsFromDb,
  applyPlayerSettingsStyles,
  getSubtitleOffsetY,
  type PlayerSettings,
} from "./PlayerSettingsModal";

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
  isTop?: boolean;
}

interface IframePlayerProps {
  animeId: string;
  animeTitle: string;
  animePoster?: string;
  episodeNumber: number;
  initialEpTitle?: string;
  m3u8Url?: string;
  defaultVttUrl?: string;
  linkPreEp?: number | null;
  linkNextEp?: number | null;
  isDub?: boolean;
  subEpisodes?: EpisodeItem[];
  dubEpisodes?: EpisodeItem[];
  streamType?: "m3u8" | "iframe";
  embedUrl?: string;
  serverSources?: ServerSource[];
  initialSubtitle?: any;
  initialCreator?: string;
  initialSubUrl?: string;
  videoSource?: string;
  videoServer?: string;
  sourceAnimeId?: string;
  sourceEpisodeNumber?: number;
}

const EMPTY_SERVER_SOURCES: ServerSource[] = [];

function formatTime(sec: number): string {
  if (isNaN(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${String(m).padStart(2, "0")}:${s.padStart(4, "0")}`;
}

export default function IframePlayer({
  animeId,
  animeTitle,
  animePoster,
  episodeNumber,
  initialEpTitle,
  linkPreEp,
  linkNextEp,
  subEpisodes = [],
  embedUrl = "",
  serverSources = EMPTY_SERVER_SOURCES,
  initialSubtitle,
  initialCreator = "",
  initialSubUrl = "",
  videoSource,
  videoServer,
  sourceAnimeId,
  sourceEpisodeNumber,
}: IframePlayerProps) {
  const [activeEmbedUrl, setActiveEmbedUrl] = useState(embedUrl);
  const [activeServerSources, setActiveServerSources] = useState(serverSources);
  const [activeServerKey, setActiveServerKey] = useState(videoServer || serverSources.find(source => source.player_url === embedUrl)?.key);
  const [serverBusy, setServerBusy] = useState(false);
  const [serverError, setServerError] = useState('');
  const switchRequest = useRef<AbortController | null>(null);
  const serverResumePosition = useRef<number | null>(null);
  useEffect(() => {
    setActiveEmbedUrl(embedUrl); setActiveServerSources(serverSources);
    setActiveServerKey(videoServer || serverSources.find(source => source.player_url === embedUrl)?.key);
    setServerError(''); setServerBusy(false);
    return () => { const pending = switchRequest.current; switchRequest.current = null; pending?.abort(); };
  }, [embedUrl, serverSources, videoServer, animeId, episodeNumber]);
  const episodeUrl = (number: number | string) => {
    const query = new URLSearchParams();
    if (videoSource) query.set('video_source', videoSource);
    if (activeServerKey) query.set('video_server', activeServerKey);
    return `/watch/${animeId}/${number}${query.size ? `?${query}` : ''}`;
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const mediaFrameRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudTextRef = useRef<HTMLDivElement>(null);
  const topHudTextRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const octopusRef = useRef<any>(null);
  const currentBlobUrlRef = useRef<string | null>(null);

  // Anikoto's own fullscreen expands the iframe; the site's fullscreen used
  // to force its subtitle+iframe frame to 16:9, leaving top/bottom bars on
  // narrower displays. Only known 4:3 sources may change that frame.
  const isAnikotoEmbed = videoSource === "anikoto" || activeServerSources.some(source => source.id === "anikoto");
  const [aspectChoice, setAspectChoice] = useState<"auto" | "4:3" | "16:9">("auto");
  const [detectedAspect, setDetectedAspect] = useState<number | null>(null);
  const aspectStorageKey = `anime_player_aspect:${sourceAnimeId || animeId}:${sourceEpisodeNumber ?? episodeNumber}:${activeServerKey || "default"}`;
  useEffect(() => {
    if (!isAnikotoEmbed) { setAspectChoice("auto"); setDetectedAspect(null); return; }
    let saved: string | null = null;
    try { saved = localStorage.getItem(aspectStorageKey); } catch {}
    setAspectChoice(saved === "4:3" || saved === "16:9" ? saved : "auto");
    setDetectedAspect(null);
  }, [aspectStorageKey, activeEmbedUrl, isAnikotoEmbed]);
  const cycleAspectChoice = () => {
    const next = aspectChoice === "auto" ? "4:3" : aspectChoice === "4:3" ? "16:9" : "auto";
    setAspectChoice(next);
    try { localStorage.setItem(aspectStorageKey, next); } catch {}
  };
  // Do not mix aspect hints into the existing playback/status message handler:
  // a separate listener keeps clock and subtitle timing behavior unchanged.
  useEffect(() => {
    if (!isAnikotoEmbed) return;
    const handleAspect = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const ratio = aspectFromPlayerMessage(event.data);
      if (ratio !== null) setDetectedAspect(current => current === ratio ? current : ratio);
    };
    window.addEventListener("message", handleAspect);
    return () => window.removeEventListener("message", handleAspect);
  }, [isAnikotoEmbed, activeEmbedUrl]);

  const aspectLabel = aspectChoice === "auto"
    ? `자동${detectedAspect === 4 / 3 ? " (4:3)" : ""}`
    : aspectChoice;
  const resolvedAspect = aspectChoice === "4:3" ? 4 / 3 : aspectChoice === "16:9" ? 16 / 9 : detectedAspect ?? 16 / 9;

  // States
  const { mode: fullscreenMode, isFullscreen, toggleFullscreen, retryNativeFullscreen, appleWebFullscreen } = usePlayerFullscreen(containerRef);
  const iphoneWebFullscreen = appleWebFullscreen && /iPhone/i.test(navigator.userAgent);
  const frameAspect = isAnikotoEmbed && !appleWebFullscreen ? resolvedAspect : 16 / 9;
  useContainedPlayerFrame(containerRef, mediaFrameRef, isFullscreen, fullscreenMode === "web", false,
    iphoneWebFullscreen ? 4 / 3 : frameAspect, frameAspect);
  const showNativeRetry = fullscreenMode === "web" && typeof navigator !== "undefined" && !appleWebFullscreen;
  const nativeRetryLabel = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
    ? "상태바 숨기기" : "전체화면 재시도";
  const fullscreenRef = useRef(isFullscreen);
  fullscreenRef.current = isFullscreen;
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [playerSettings, setPlayerSettings] = useState<PlayerSettings>(DEFAULT_PLAYER_SETTINGS);
  const settingsEditedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const local = loadPlayerSettings();
    setPlayerSettings(local);
    applyPlayerSettingsStyles(local);
    fetchUserSettingsFromDb().then((result) => {
      if (cancelled || settingsEditedRef.current || !result.authenticated || !result.settings) return;
      const merged = { ...DEFAULT_PLAYER_SETTINGS, ...result.settings };
      setPlayerSettings(merged);
      applyPlayerSettingsStyles(merged);
      try { localStorage.setItem("anime_player_settings", JSON.stringify(merged)); } catch {}
    });
    return () => { cancelled = true; };
  }, []);
  const [currentVideoTime, setCurrentVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [syncOffset, setSyncOffset] = useState(0.0);
  const [sponsorSync, setSponsorSync] = useState<SponsorSubtitleSync>({ startSeconds: null, delaySeconds: 0 });
  const [sponsorSyncOpen, setSponsorSyncOpen] = useState(false);
  const sponsorSyncRef = useRef<SponsorSubtitleSync>({ startSeconds: null, delaySeconds: 0 });
  const [isSubEnabled, setIsSubEnabled] = useState(true);
  const [subSize, setSubSize] = useState<"small" | "normal" | "large">("normal");
  const subScale = { small: 0.8, normal: 1, large: 1.25 }[subSize];
  const subScaleRef = useRef(subScale);
  subScaleRef.current = subScale;
  const [isSavedSync, setIsSavedSync] = useState(false);
  const [isOctopusScriptLoaded, setIsOctopusScriptLoaded] = useState(() => {
    return typeof window !== "undefined" && Boolean(window.SubtitlesOctopus);
  });
  const [isOctopusActive, setIsOctopusActive] = useState(false);
  const [navigatingTarget, setNavigatingTarget] = useState<string | null>(null);
  const syncOffsetRef = useRef(syncOffset);
  syncOffsetRef.current = syncOffset;
  const isSubEnabledRef = useRef(isSubEnabled);
  isSubEnabledRef.current = isSubEnabled;
  const cuesRef = useRef<SubtitleCue[]>([]);
  const isOctopusActiveRef = useRef(false);
  isOctopusActiveRef.current = isOctopusActive;

  // Subtitles & Creators (서버에서 사전 로드된 자막이 있으면 0초 딜레이로 즉시 바인딩)
  const [subtitles, setSubtitles] = useState<SubtitleOption[]>(() => {
    if (initialSubtitle && initialSubtitle.content) {
      return [
        {
          name: initialSubtitle.name || initialCreator || "선택된 자막",
          format: initialSubtitle.is_ass ? "ASS" : "VTT",
          is_ass: Boolean(initialSubtitle.is_ass),
          temporary: Boolean(initialSubtitle.temporary),
          content: initialSubtitle.content,
          url: initialSubUrl || "",
        },
      ];
    }
    return [];
  });
  const [currentSubIndex, setCurrentSubIndex] = useState(0);
  const [creators, setCreators] = useState<CreatorInfo[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [subtitleSettingsRevision,setSubtitleSettingsRevision]=useState(0);
  useEffect(()=>{
    const changed=(event:Event)=>{
      if((event as CustomEvent).detail?.animeId===animeId)setSubtitleSettingsRevision(value=>value+1);
    };
    window.addEventListener('subtitle-settings-changed',changed);
    return()=>window.removeEventListener('subtitle-settings-changed',changed);
  },[animeId]);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [firstDialogue, setFirstDialogue] = useState<SubtitleCue | null>(null);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  const syncDebounceTimer = useRef<NodeJS.Timeout | null>(null);
  const lastHistorySaveTime = useRef(0);
  const lastCurrentTimeRef = useRef(0);
  const lastDurationRef = useRef(0);
  const resumeHistoryReadyRef = useRef(false);
  const playbackPausedRef = useRef(true);
  const playbackStatusKnownRef = useRef(false);
  const lastClockAdvanceRef = useRef(0);
  const subtitleClockRef = useRef<IframeSubtitleClock | null>(null);
  const pendingResumeRef = useRef<{
    episode: number;
    seconds: number;
    attempts: number;
    lastAttemptAt: number;
  } | null>(null);

  // Show temporary toast notice
  const showNotice = useCallback((msg: string, duration = 3000) => {
    setNoticeMessage(msg);
    setTimeout(() => {
      setNoticeMessage((prev) => (prev === msg ? null : prev));
    }, duration);
  }, []);

  const isPlaybackCompleted = useCallback((seconds: number, duration: number) => {
    if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) return false;
    return seconds >= duration - 15 || (duration > 60 && seconds / duration >= 0.95);
  }, []);

  const tryResumeIframe = useCallback((observedTime?: number, force = false) => {
    const pending = pendingResumeRef.current;
    if (!pending || pending.episode !== episodeNumber || pending.seconds <= 10) return;

    if (typeof observedTime === "number" && Number.isFinite(observedTime)) {
      if (Math.abs(observedTime - pending.seconds) <= 4 || observedTime > pending.seconds + 5) {
        pendingResumeRef.current = null;
        showNotice(`이어보기: ${formatTime(pending.seconds)}부터 재생합니다.`, 5000);
        return;
      }
    }

    // Metadata must be loaded before seek attempts consume the retry budget.
    if (!Number.isFinite(lastDurationRef.current) || lastDurationRef.current <= 0) return;
    const now = Date.now();
    if (!force && now - pending.lastAttemptAt < 650) return;
    if (pending.attempts >= 12) return;
    const target = iframeRef.current?.contentWindow;
    if (!target) return;

    pending.attempts += 1;
    pending.lastAttemptAt = now;
    target.postMessage(iframeSeekMessage(pending.seconds), "*");
  }, [episodeNumber, showNotice]);

  const syncHistory = useCallback(
    (isEnded = false) => {
      // Preserve the saved position while the initial resume seek is pending.
      if (!resumeHistoryReadyRef.current || pendingResumeRef.current) return;
      const curTime = lastCurrentTimeRef.current;
      const dur = lastDurationRef.current;
      if (curTime <= 2 && !isEnded) return;

      const isCompleted = isEnded || isPlaybackCompleted(curTime, dur);

      fetch("/api/anime/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          animeId,
          animeTitle,
          animePoster: animePoster || "",
          episodeNumber,
          episodeTitle: initialEpTitle || `${episodeNumber}화`,
          watchUrl: `/watch/${animeId}/${episodeNumber}`,
          currentTime: Math.floor(curTime),
          duration: Math.floor(dur),
          isCompleted,
          anime_id: animeId,
          anime_title: animeTitle,
          anime_poster: animePoster || "",
          episode_number: episodeNumber,
          episode_title: initialEpTitle || `${episodeNumber}화`,
          watch_url: `/watch/${animeId}/${episodeNumber}`,
          watch_time: Math.floor(curTime),
          is_completed: isCompleted,
        }),
        keepalive: true,
      }).catch(() => {});
    },
    [animeId, animeTitle, animePoster, episodeNumber, initialEpTitle, isPlaybackCompleted]
  );

  async function selectServer(server: ServerSource) {
    if (serverBusy || !server.key || server.key === activeServerKey) return;
    setServerBusy(true); setServerError('');
    const controller = new AbortController();
    switchRequest.current?.abort(); switchRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      let url = server.player_url, sources = activeServerSources, key = server.key;
      if (!url) {
        if (!sourceAnimeId?.startsWith('ak_')) throw Error('영상 작품 정보를 확인하지 못했습니다.');
        const query = new URLSearchParams({ id: sourceAnimeId, ep: String(sourceEpisodeNumber ?? episodeNumber), server: key });
        const response = await fetch(`/api/anime/video-server?${query}`, { cache: 'no-store', signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.success || !result.embed_url) throw Error(result.message || '선택한 서버를 불러오지 못했습니다.');
        url = result.embed_url; sources = result.server_sources; key = result.video_server;
      }
      if (controller.signal.aborted) return;
      syncHistory(false);
      const time = lastCurrentTimeRef.current;
      serverResumePosition.current = pendingResumeRef.current?.seconds ?? (playbackStatusKnownRef.current ? time : null);
      if (time > 10) { try { localStorage.setItem(`anime_progress_${animeId}_ep${episodeNumber}`, String(time)); } catch {} }
      setActiveEmbedUrl(url); setActiveServerSources(sources); setActiveServerKey(key);
      const current = new URL(window.location.href);
      current.searchParams.set('video_server', key);
      if (videoSource) current.searchParams.set('video_source', videoSource);
      window.history.replaceState(window.history.state, '', current.pathname + current.search);
    } catch (error: any) {
      if (switchRequest.current === controller) setServerError(error.name === 'AbortError'
        ? '서버 응답이 늦습니다. 다른 서버를 선택해 주세요.' : error.message);
    } finally {
      clearTimeout(timeout);
      if (switchRequest.current === controller) { setServerBusy(false); switchRequest.current = null; }
    }
  }

  // Helper: Strip HTML tags, ASS tags, and HTML entities
  const cleanSubtitleText = (raw: string): string => {
    if (!raw) return "";
    return raw
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "") // <i>, </i>, <font...>, </font>, <b>, <u> 등 모든 HTML 태그 완벽 제거
      .replace(/\{[^}]*\}/g, "") // ASS 스타일 태그 {\an8} 등 제거
      .replace(/\\N/gi, "\n")
      .replace(/\\n/gi, "\n")
      .replace(/\\h/gi, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n")
      .trim();
  };

  // 1. ASS Dialogue Parser
  const parseAssToCues = useCallback((assText: string): SubtitleCue[] => {
    if (!assText) return [];
    const list: SubtitleCue[] = [];
    const pattern =
      /^Dialogue:\s*[^,]+,(\d+:\d{2}:\d{2}(?:\.\d+)?),(\d+:\d{2}:\d{2}(?:\.\d+)?),([^,]*),([^,]*),(?:[^,]*,){4}(.*)$/gim;

    const toSec = (tStr: string) => {
      const p = tStr.trim().split(":");
      if (p.length === 3) {
        return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
      } else if (p.length === 2) {
        return parseFloat(p[0]) * 60 + parseFloat(p[1]);
      }
      return parseFloat(tStr) || 0;
    };

    let match;
    while ((match = pattern.exec(assText)) !== null) {
      const startSec = toSec(match[1]);
      let endSec = toSec(match[2]);
      const rawText = match[5];
      const cleanText = cleanSubtitleText(rawText);

      const isTop = /\{\\an[789]\}/i.test(rawText);

      // 자막이 10초 이상 계속 켜져있는 비정상 싱크 cap
      if (endSec - startSec > 10) {
        endSec = startSec + Math.max(3, Math.min(cleanText.length * 0.25, 8));
      }

      if (cleanText && endSec > startSec) {
        list.push({ start: startSec, end: endSec, text: cleanText, isTop });
      }
    }
    return list;
  }, []);

  // 2. VTT & SAMI Parser
  const parseVttToCues = useCallback((vttText: string): SubtitleCue[] => {
    if (!vttText) return [];

    const lower = vttText.toLowerCase();

    // 2-1. SAMI (.smi) 파일이 전달된 경우 (로컬 파일 등)
    if (lower.includes("<sync") || lower.includes("<sami")) {
      const syncRegex = /<SYNC\s+Start=(\d+)[^>]*>(?:<P[^>]*>)?([\s\S]*?)(?=<SYNC|\Z)/gi;
      let m: RegExpExecArray | null;
      const list: SubtitleCue[] = [];
      let currentCue: { start: number; text: string } | null = null;

      while ((m = syncRegex.exec(vttText)) !== null) {
        const startSec = parseInt(m[1], 10) / 1000;
        if (isNaN(startSec)) continue;
        const text = cleanSubtitleText(m[2]);

        // 이전 열려있는 대사가 있다면 닫아준다
        if (currentCue) {
          const diff = startSec - currentCue.start;
          if (diff > 0) {
            const maxDur = Math.max(3, Math.min(currentCue.text.length * 0.25, 7.5));
            const actualEnd = diff > maxDur ? currentCue.start + maxDur : startSec;
            list.push({ start: currentCue.start, end: actualEnd, text: currentCue.text });
          }
          currentCue = null;
        }

        // 현재 싱크에 텍스트가 있다면 새 대사 등록
        if (text.length > 0) {
          currentCue = { start: startSec, text };
        }
      }

      if (currentCue) {
        const maxDur = Math.max(3, Math.min(currentCue.text.length * 0.25, 6));
        list.push({ start: currentCue.start, end: currentCue.start + maxDur, text: currentCue.text });
      }
      return list;
    }

    // 2-2. WebVTT & SRT 파싱
    const list: SubtitleCue[] = [];
    const lines = vttText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    let currentStart: number | null = null;
    let currentEnd: number | null = null;
    let currentTexts: string[] = [];

    const toSec = (tStr: string) => {
      if (!tStr) return 0;
      const cleanStr = tStr.replace(",", ".").trim();
      const p = cleanStr.split(":");
      if (p.length === 3) {
        return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
      } else if (p.length === 2) {
        return parseFloat(p[0]) * 60 + parseFloat(p[1]);
      }
      return parseFloat(cleanStr) || 0;
    };

    const timeArrowPattern =
      /((?:\d{1,2}:)?\d{2}:\d{2}[\.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[\.,]\d{1,3})/;

    const flushCue = () => {
      if (currentStart !== null && currentEnd !== null && currentTexts.length > 0) {
        const raw = currentTexts.join("\n");
        const clean = cleanSubtitleText(raw);
        let end = currentEnd;
        // 안전장치: 자막이 10초 이상 계속 켜져있는 비정상 싱크 cap
        if (end - currentStart > 10) {
          end = currentStart + Math.max(3, Math.min(clean.length * 0.25, 8));
        }
        if (clean && end > currentStart) {
          list.push({ start: currentStart, end, text: clean });
        }
      }
      currentTexts = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        flushCue();
        currentStart = null;
        currentEnd = null;
        continue;
      }
      const timeMatch = timeArrowPattern.exec(line);
      if (timeMatch) {
        flushCue();
        currentStart = toSec(timeMatch[1]);
        currentEnd = toSec(timeMatch[2]);
      } else if (currentStart !== null && !line.startsWith("WEBVTT") && !/^\d+$/.test(line)) {
        currentTexts.push(line);
      }
    }

    flushCue();
    return list;
  }, []);

  // 3. Restore ordinary and breakpoint sync independently for each episode.
  useEffect(() => {
    let cancelled = false;
    sponsorSyncRef.current = { startSeconds: null, delaySeconds: 0 };
    setSponsorSync(sponsorSyncRef.current);
    setSyncOffset(0);
    setIsSavedSync(false);
    async function loadSavedSync() {
      try {
        const res = await fetch(
          `/api/anime/reanime-sync?animeId=${encodeURIComponent(animeId)}&ep=${episodeNumber}`
        );
        const data = await res.json();
        if (cancelled || !data.success || !data.setting) return;
        const savedOffset = Number(data.setting.sync_offset) || 0;
        const savedStart = data.setting.sponsor_sync_start;
        const savedDelay = Number(data.setting.sponsor_sync_delay) || 0;
        const next: SponsorSubtitleSync = {
          startSeconds: Number.isInteger(savedStart) && savedStart >= 0 && savedDelay > 0 ? savedStart : null,
          delaySeconds: savedDelay > 0 ? savedDelay : 0,
        };
        setSyncOffset(savedOffset);
        sponsorSyncRef.current = next;
        setSponsorSync(next);
        setIsSavedSync(true);
      } catch (err) {
        console.error("Failed to load saved sync offset:", err);
      }
    }
    void loadSavedSync();
    return () => { cancelled = true; };
  }, [animeId, episodeNumber]);

  // 4. Save sync setting to DB (debounced)
  const saveSyncToDb = useCallback(
    (offset: number) => {
      setIsSavedSync(false);
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current);
      }
      syncDebounceTimer.current = setTimeout(async () => {
        try {
          const currentSub = subtitles[currentSubIndex];
          await fetch("/api/anime/reanime-sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              animeId,
              ep: episodeNumber,
              syncOffset: offset,
              subtitleName: currentSub?.name || "",
              subtitleUrl: currentSub?.url || "",
            }),
          });
          setIsSavedSync(true);
        } catch (err) {
          console.error("Failed to save sync offset to DB:", err);
        }
      }, 800);
    },
    [animeId, episodeNumber, subtitles, currentSubIndex]
  );

  // Save an independent per-episode sponsor breakpoint, preserving ordinary offset.
  const saveSponsorSync = useCallback(async (startSeconds: number | null, delaySeconds: number): Promise<boolean> => {
    try {
      const response = await fetch("/api/anime/reanime-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "sponsor", animeId, ep: episodeNumber,
          sponsorSyncStart: startSeconds, sponsorSyncDelay: delaySeconds,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) return false;
      const next: SponsorSubtitleSync = { startSeconds, delaySeconds };
      sponsorSyncRef.current = next;
      setSponsorSync(next);
      // Re-anchor libass immediately, even when paused.
      if (octopusRef.current?.worker) {
        const time = lastCurrentTimeRef.current;
        const offset = effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, time);
        subtitleClockRef.current = syncIframeSubtitleClock(
          octopusRef.current, subtitleClockRef.current, time + offset, playbackPausedRef.current,
          { offset, reset: true });
      }
      showNotice(startSeconds === null ? "스폰서 이후 싱크 설정 해제 (이 회차에 저장)"
        : `스폰서 이후 싱크: ${formatSyncTime(startSeconds)}부터 +${delaySeconds}초 (이 회차에 저장)`);
      return true;
    } catch (error) {
      console.error("[Iframe sponsor subtitle sync save]", error);
      return false;
    }
  }, [animeId, episodeNumber, showNotice]);

  // 5. Fetch Korean subtitles for this anime
  const [resolvedTitle, setResolvedTitle] = useState<string>("");

  useEffect(() => {
    let isCancelled = false;
    async function fetchSubs() {
      setLoadingSubs(true);
      try {
        const queryParams = new URLSearchParams({
          title: animeTitle,
          ep: String(episodeNumber),
          animeId,
        });
        if (initialSubUrl) queryParams.set("website", initialSubUrl);
        if (initialCreator) queryParams.set("creatorName", initialCreator);

        const res = await fetch(`/api/anime/subtitles?${queryParams.toString()}`);
        const data = await res.json();
        if (isCancelled) return;

        if (data.success) {
          const needsManualChoice = Boolean(data.needs_manual_subtitle_choice);
          if (data.resolved_title) {
            setResolvedTitle(data.resolved_title);
          }
          if (Array.isArray(data.creators)) {
            setCreators(data.creators);
          }
          if (Array.isArray(data.subtitles)) {
            const list: SubtitleOption[] = data.subtitles.map((s: any) => ({
              name: s.name,
              format: s.is_ass ? "ASS" : "VTT",
              is_ass: Boolean(s.is_ass),
              temporary: Boolean(s.temporary),
              content: s.content || "",
              url: s.url || "",
              matchScore: s.matchScore,
              matchedTitle: s.matchedTitle,
              verifiedMatch: s.verifiedMatch,
              sourceCreatorWebsite: s.sourceCreatorWebsite,
              sourceMatchedTitle: s.sourceMatchedTitle,
              sourceProvider: s.sourceProvider,
              localArchive: Boolean(s.localArchive),
              localArchiveTrackKey: s.localArchiveTrackKey,
              reviewedFileId: s.reviewedFileId,
              localFileId:s.localFileId,episodeException:s.episodeException,episodeConfirmed:s.episodeConfirmed,
              sourceFolderKey:s.sourceFolderKey,sourceFolderLabel:s.sourceFolderLabel,
              sourceBundleKey:s.sourceBundleKey,sourceBundleLabel:s.sourceBundleLabel,bundleAssigned:s.bundleAssigned,
            }));
            setSubtitles(list);
            setCurrentSubIndex(needsManualChoice ? -1 : 0);
          }
          if (needsManualChoice) setIsModalOpen(true);
        }
      } catch (err) {
        console.error("Error fetching subtitles:", err);
      } finally {
        if (!isCancelled) setLoadingSubs(false);
      }
    }
    fetchSubs();
    return () => {
      isCancelled = true;
    };
  }, [animeTitle, episodeNumber, animeId, initialSubUrl, initialCreator, showNotice,subtitleSettingsRevision]);

  // 6. Load SubtitlesOctopus library script
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.SubtitlesOctopus) {
      setIsOctopusScriptLoaded(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "/libass/subtitles-octopus.js";
    script.async = true;
    script.onload = () => {
      setIsOctopusScriptLoaded(true);
    };
    script.onerror = () => {
      console.warn("Failed to load /libass/subtitles-octopus.js, HTML HUD fallback will be used.");
      setIsOctopusScriptLoaded(false);
    };
    document.body.appendChild(script);
  }, []);

  // 7. When currentSub changes or script loads, parse cues or setup SubtitlesOctopus
  useEffect(() => {
    const sub = subtitles[currentSubIndex];
    if (!sub || !sub.content) return;

    if (sub.is_ass) {
      const parsed = parseAssToCues(sub.content);
      setCues(parsed);
      cuesRef.current = parsed;
      if (parsed.length > 0) setFirstDialogue(parsed[0]);
      showNotice(`${sub.name} (ASS 자막 ${parsed.length}개 대사 로드 완료)`);

      // Init SubtitlesOctopus on canvas if script is available
      if (typeof window !== "undefined" && window.SubtitlesOctopus && canvasRef.current) {
        try {
          isOctopusActiveRef.current = false;
          setIsOctopusActive(false);

          if (octopusRef.current) {
            try {
              octopusRef.current.dispose();
            } catch {}
            octopusRef.current = null;
          }
          if (currentBlobUrlRef.current) {
            try {
              URL.revokeObjectURL(currentBlobUrlRef.current);
            } catch {}
            currentBlobUrlRef.current = null;
          }

          const w = mediaFrameRef.current?.clientWidth || 1920;
          const h = mediaFrameRef.current?.clientHeight || 1080;
          const sharpness = playerSettings.subtitleSharpness || 1;
          const { width: renderW, height: renderH } = subtitleRenderSize(w, h, sharpness, window.devicePixelRatio);
          if (canvasRef.current) {
            canvasRef.current.width = renderW;
            canvasRef.current.height = renderH;
          }

          const renderContent = scaleAssFontSizes(sub.content, subScaleRef.current);
          const blob = new Blob([renderContent], { type: "text/plain;charset=utf-8" });
          const blobUrl = URL.createObjectURL(blob);
          currentBlobUrlRef.current = blobUrl;

          octopusRef.current = new window.SubtitlesOctopus({
            canvas: canvasRef.current,
            subUrl: blobUrl,
            subContent: renderContent,
            fonts: [],
            fallbackFont: "/libass/default.woff2",
            workerUrl: "/libass/subtitles-octopus-worker.js",
            legacyWorkerUrl: "/libass/subtitles-octopus-worker.js",
            timeOffset: effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, lastCurrentTimeRef.current),
            targetFps: 60,
            onReady: () => {
              isOctopusActiveRef.current = true;
              setIsOctopusActive(true);
              try {
                const cw = mediaFrameRef.current?.clientWidth || 1920;
                const ch = mediaFrameRef.current?.clientHeight || 1080;
                const sharpness = playerSettings.subtitleSharpness || 1;
                const size = subtitleRenderSize(cw, ch, sharpness, window.devicePixelRatio);
                octopusRef.current?.resize(size.width, size.height);
                if (octopusRef.current) subtitleClockRef.current = syncIframeSubtitleClock(
                  octopusRef.current, null, lastCurrentTimeRef.current + effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, lastCurrentTimeRef.current), playbackPausedRef.current,
                  { offset: effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, lastCurrentTimeRef.current) });
              } catch {}
            },
            onError: (e: any) => {
              console.warn("SubtitlesOctopus canvas fallback to HUD:", e);
              isOctopusActiveRef.current = false;
              setIsOctopusActive(false);
              try {
                octopusRef.current?.dispose();
              } catch {}
              octopusRef.current = null;
            },
          });
        } catch (e) {
          console.warn("SubtitlesOctopus canvas init skipped, using HTML HUD:", e);
          isOctopusActiveRef.current = false;
          setIsOctopusActive(false);
          octopusRef.current = null;
        }
      }
    } else {
      isOctopusActiveRef.current = false;
      setIsOctopusActive(false);
      const parsed = parseVttToCues(sub.content);
      setCues(parsed);
      cuesRef.current = parsed;
      if (parsed.length > 0) setFirstDialogue(parsed[0]);
      showNotice(`${sub.name} (자막 ${parsed.length}개 대사 로드 완료)`);
      if (octopusRef.current) {
        try {
          octopusRef.current.dispose();
        } catch {}
        octopusRef.current = null;
      }
      if (currentBlobUrlRef.current) {
        try {
          URL.revokeObjectURL(currentBlobUrlRef.current);
        } catch {}
        currentBlobUrlRef.current = null;
      }
    }

    return () => {
      if (currentBlobUrlRef.current) {
        try {
          URL.revokeObjectURL(currentBlobUrlRef.current);
        } catch {}
        currentBlobUrlRef.current = null;
      }
      if (octopusRef.current) {
        try {
          octopusRef.current.dispose();
        } catch {}
        octopusRef.current = null;
      }
      isOctopusActiveRef.current = false;
      setIsOctopusActive(false);
    };
  }, [
    subtitles,
    currentSubIndex,
    parseAssToCues,
    parseVttToCues,
    isOctopusScriptLoaded,
    showNotice,
    playerSettings.subtitleSharpness,
  ]);

  useEffect(() => {
    const sub = subtitles[currentSubIndex];
    if (!octopusRef.current || !sub?.is_ass || !sub.content) return;
    octopusRef.current.setTrack(scaleAssFontSizes(sub.content, subScale));
    subtitleClockRef.current = syncIframeSubtitleClock(
      octopusRef.current, subtitleClockRef.current,
      lastCurrentTimeRef.current + effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, lastCurrentTimeRef.current),
      playbackPausedRef.current, { reset: true });
  }, [subScale, subtitles, currentSubIndex]);

  // 8. FlixCloud postMessage polling (100ms) & message listeners
  useEffect(() => {
    const timer = setInterval(() => {
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage({ command: "getTime" }, "*");
      }
    }, 100);

    const handleMessage = (event: MessageEvent) => {
      if (!event.data) return;
      const isPlayerMessage = event.source === iframeRef.current?.contentWindow;
      if (!isPlayerMessage || typeof event.data !== "object") return;

      const paused = iframePausedState(event.data);
      if (paused !== null) {
        playbackPausedRef.current = paused;
        playbackStatusKnownRef.current = true;
        if (octopusRef.current?.worker) subtitleClockRef.current = syncIframeSubtitleClock(
          octopusRef.current, subtitleClockRef.current,
          lastCurrentTimeRef.current + effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, lastCurrentTimeRef.current), paused,
          { offset: effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, lastCurrentTimeRef.current) });
      }

      // Handle Fullscreen queries from iframe
      if (isPlayerMessage && event.data.zenCommand === "getFullscreenState") {
        event.source?.postMessage(
          { zenFullscreenState: isFullscreen },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "*" as any
        );
      }

      // Handle Fullscreen toggle command from iframe
      if (isPlayerMessage && event.data.zenCommand === "toggleFullscreen") {
        toggleFullscreen();
      }

      // Handle currentTime updates from FlixCloud
      if (typeof event.data.currentTime === "number" && Number.isFinite(event.data.currentTime) && event.data.currentTime >= 0) {
        const time = event.data.currentTime;
        if (!playbackStatusKnownRef.current) {
          // Other bridges may omit status; freeze once their clock stops.
          if (time !== lastCurrentTimeRef.current) lastClockAdvanceRef.current = Date.now();
          playbackPausedRef.current = Date.now() - lastClockAdvanceRef.current >= 500;
        }
        setCurrentVideoTime(time);
        lastCurrentTimeRef.current = time;

        if (typeof event.data.duration === "number" && Number.isFinite(event.data.duration) && event.data.duration > 0) {
          setVideoDuration(event.data.duration);
          lastDurationRef.current = event.data.duration;
        }

        tryResumeIframe(time);
        const duration = lastDurationRef.current;
        const progressKey = `anime_progress_${animeId}_ep${episodeNumber}`;
        if (time > 2 && resumeHistoryReadyRef.current && !pendingResumeRef.current) {
          if (isPlaybackCompleted(time, duration)) {
            localStorage.removeItem(progressKey);
          } else {
            localStorage.setItem(progressKey, String(time));
          }
        }

        // Drive SubtitlesOctopus if ASS (safely isolated from HUD rendering)
        if (octopusRef.current && typeof octopusRef.current.setCurrentTime === "function") {
          try {
            if (octopusRef.current.worker) {
              const effectiveTime = time + effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, time);
              subtitleClockRef.current = syncIframeSubtitleClock(
                octopusRef.current, subtitleClockRef.current, effectiveTime, playbackPausedRef.current,
                { offset: effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, time) });
            } else {
              isOctopusActiveRef.current = false;
              setIsOctopusActive(false);
              octopusRef.current = null;
            }
          } catch (e) {
            console.warn("SubtitlesOctopus setCurrentTime exception, fallback to HUD:", e);
            isOctopusActiveRef.current = false;
            setIsOctopusActive(false);
            try {
              octopusRef.current?.dispose();
            } catch {}
            octopusRef.current = null;
          }
        }

        // Drive HTML HUD text (하단 대사 & 상단 설명 자막 분리 렌더링)
        const currentSub = subtitles[currentSubIndex];
        const isCurrentAss = Boolean(currentSub?.is_ass);
        const shouldHideHud =
          !isSubEnabledRef.current ||
          cuesRef.current.length === 0 ||
          (isCurrentAss && isOctopusActiveRef.current);

        if (shouldHideHud) {
          updateSubtitleHud(hudTextRef.current, "");
          updateSubtitleHud(topHudTextRef.current, "");
        } else {
          const effectiveTime = time + effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, time);
          const matchedCues = cuesRef.current.filter((c) => effectiveTime >= c.start && effectiveTime < c.end);
          updateSubtitleHud(hudTextRef.current, matchedCues.filter(c => !c.isTop).map(c => c.text).join("\n"));
          updateSubtitleHud(topHudTextRef.current, matchedCues.filter(c => c.isTop).map(c => c.text).join("\n"));
        }

        // Save history every 10 seconds
        const now = Date.now();
        if (now - lastHistorySaveTime.current > 10000 && time > 2) {
          lastHistorySaveTime.current = now;
          syncHistory(false);
        }
      }
    };

    window.addEventListener("message", handleMessage);

    const syncOctopusCanvasSize = () => {
      const isFs = fullscreenRef.current;
      try {
        iframeRef.current?.contentWindow?.postMessage(
          { zenFullscreenState: isFs, event: "fullscreen", isFullscreen: isFs },
          "*"
        );
      } catch {}

      if (octopusRef.current && typeof octopusRef.current.resize === "function") {
        try {
          const w = mediaFrameRef.current?.clientWidth || 1920;
          const h = mediaFrameRef.current?.clientHeight || 1080;
          const sharpness = playerSettings.subtitleSharpness || 1;
          const { width: renderW, height: renderH } = subtitleRenderSize(w, h, sharpness, window.devicePixelRatio);

          // Do not mutate canvas.width/height here. Setting either property
          // clears the canvas immediately, and SubtitlesOctopus then sees the
          // requested size as already applied and skips its worker resize.
          // Let Octopus own the backing-size transition so it can notify
          // libass and redraw the current frame after rotation/fullscreen.
          octopusRef.current.resize(renderW, renderH);
          subtitleClockRef.current = syncIframeSubtitleClock(
            octopusRef.current, subtitleClockRef.current,
            lastCurrentTimeRef.current + effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, lastCurrentTimeRef.current), playbackPausedRef.current,
            { offset: effectiveSubtitleOffset(syncOffsetRef.current, sponsorSyncRef.current, lastCurrentTimeRef.current), reset: true });
        } catch {}
      }
    };

    const resizeTimers = new Set<ReturnType<typeof setTimeout>>();
    const handleFullscreenChange = () => {
      syncOctopusCanvasSize();
      for (const delay of [100, 300]) {
        const timeout = setTimeout(() => {
          resizeTimers.delete(timeout);
          syncOctopusCanvasSize();
        }, delay);
        resizeTimers.add(timeout);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("mozfullscreenchange", handleFullscreenChange);
    document.addEventListener("MSFullscreenChange", handleFullscreenChange);
    window.addEventListener("resize", syncOctopusCanvasSize);
    window.visualViewport?.addEventListener("resize", syncOctopusCanvasSize);
    // CSS fullscreen and rotation change the contained frame without a native
    // fullscreen event. Size libass from that same frame after layout settles.
    const mediaObserver = typeof ResizeObserver === "function" ? new ResizeObserver(syncOctopusCanvasSize) : null;
    if (mediaFrameRef.current) mediaObserver?.observe(mediaFrameRef.current);
    const layoutTimer = setTimeout(syncOctopusCanvasSize, 100);

    const handleUnload = () => {
      syncHistory(false);
    };
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload);

    return () => {
      syncHistory(false);
      clearInterval(timer);
      window.removeEventListener("message", handleMessage);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("mozfullscreenchange", handleFullscreenChange);
      document.removeEventListener("MSFullscreenChange", handleFullscreenChange);
      window.removeEventListener("resize", syncOctopusCanvasSize);
      window.visualViewport?.removeEventListener("resize", syncOctopusCanvasSize);
      mediaObserver?.disconnect();
      clearTimeout(layoutTimer);
      resizeTimers.forEach(clearTimeout);
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
    };
  }, [
    syncHistory,
    isFullscreen,
    toggleFullscreen,
    subtitles,
    currentSubIndex,
    playerSettings.subtitleSharpness,
    animeId,
    episodeNumber,
    isPlaybackCompleted,
    tryResumeIframe,
  ]);

  // 9. 이전 시청 기록 조회 및 이어보기 안내 / 복원 시도
  useEffect(() => {
    let isCancelled = false;
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];
    const switchedTime = serverResumePosition.current;
    serverResumePosition.current = null;
    pendingResumeRef.current = null;
    resumeHistoryReadyRef.current = false;
    lastCurrentTimeRef.current = 0;
    lastDurationRef.current = 0;
    setCurrentVideoTime(0); setVideoDuration(0);
    playbackPausedRef.current = true;
    playbackStatusKnownRef.current = false;
    subtitleClockRef.current = null;

    async function checkSavedHistory() {
      try {
        const localKey = `anime_progress_${animeId}_ep${episodeNumber}`;
        const localTime = parseFloat(localStorage.getItem(localKey) || "0") || 0;

        let data: any = null;
        if (switchedTime === null) try {
          const res = await fetch(`/api/anime/history?anime_id=${encodeURIComponent(animeId)}`,
            { signal: AbortSignal.timeout(3500) });
          if (res.ok) data = await res.json();
        } catch (err) {
          // A failed cloud lookup must not discard the saved local position.
          console.warn("Failed to fetch cloud history; using local progress:", err);
        }
        if (isCancelled) return;

        const epItem = data?.success && Array.isArray(data.items)
          ? data.items.find((item: any) => Number(item.episode_number) === Number(episodeNumber))
          : null;
        const cloudTime = epItem
          ? parseFloat(epItem.watch_time || epItem.current_time || "0") || 0
          : 0;
        const cloudDuration = epItem ? parseFloat(epItem.duration || "0") || 0 : 0;

        // Older iframe code marked 85% as completed. Do not let that stale flag
        // suppress resume unless the saved position is actually at our current
        // completion threshold (95% or within the final 15 seconds).
        const trulyCompleted = Boolean(epItem?.is_completed)
          && (cloudDuration <= 0 || isPlaybackCompleted(cloudTime, cloudDuration));
        if (switchedTime === null && trulyCompleted) {
          localStorage.removeItem(localKey);
          return;
        }

        const savedTime = switchedTime ?? Math.max(localTime, cloudTime);
        if (savedTime <= (switchedTime === null ? 10 : 0)) return;

        pendingResumeRef.current = {
          episode: episodeNumber,
          seconds: savedTime,
          attempts: 0,
          lastAttemptAt: 0,
        };
        showNotice(`이어보기: ${formatTime(savedTime)} 위치로 이동 중…`, 5000);

        // Try immediately, after iframe load, and again while getTime replies.
        // Multiple attempts are intentional because FlixCloud may ignore an
        // early seek before its internal player has finished initializing.
        for (const delay of [0, 400, 1000, 2000, 3500, 5500]) {
          retryTimers.push(setTimeout(() => {
            if (!isCancelled) tryResumeIframe(undefined, true);
          }, delay));
        }
      } catch (err) {
        console.error("Failed to fetch anime history for resume:", err);
      } finally {
        if (!isCancelled) resumeHistoryReadyRef.current = true;
      }
    }

    checkSavedHistory();
    return () => {
      isCancelled = true;
      retryTimers.forEach(clearTimeout);
      pendingResumeRef.current = null;
    };
  }, [animeId, episodeNumber, activeEmbedUrl, showNotice, isPlaybackCompleted, tryResumeIframe]);

  // Adjust Sync Offset
  const adjustSync = (delta: number) => {
    const nextVal = Math.round((syncOffset + delta) * 10) / 10;
    setSyncOffset(nextVal);
    saveSyncToDb(nextVal);
  };

  const resetSync = () => {
    setSyncOffset(0.0);
    saveSyncToDb(0.0);
    showNotice("싱크가 0.0초로 초기화되었습니다.");
  };

  // Instant Sync matching first dialogue
  const handleAutoSyncFirstDialogue = () => {
    if (!firstDialogue) {
      showNotice("자막의 첫 대사 정보를 불러오지 못했습니다.");
      return;
    }
    // Dialogue time in sub vs current playback time in video
    // When dialogue is spoken, currentVideoTime + offset = firstDialogue.start
    // => offset = firstDialogue.start - currentVideoTime
    const calculatedOffset = Math.round((firstDialogue.start - currentVideoTime) * 10) / 10;
    setSyncOffset(calculatedOffset);
    saveSyncToDb(calculatedOffset);
    showNotice(
      `첫 대사에 맞춰 싱크가 ${calculatedOffset > 0 ? `+${calculatedOffset}` : calculatedOffset}초로 자동 조정되었습니다! 🎯`
    );
  };

  const cycleSubSize = () => {
    if (subSize === "small") setSubSize("normal");
    else if (subSize === "normal") setSubSize("large");
    else setSubSize("small");
  };

  const handleSelectSubtitle = (selectedSub: SubtitleOption) => {
    setSubtitles((prev) => {
      const idx = prev.findIndex((s) => s.name === selectedSub.name);
      if (idx >= 0) {
        setCurrentSubIndex(idx);
        return prev;
      }
      const updated = [selectedSub, ...prev];
      setCurrentSubIndex(0);
      return updated;
    });
    saveSyncToDb(syncOffset);
    showNotice(`자막 [${selectedSub.name}] 적용 완료! ✨`);
  };

  const subSizeClasses = {
    small: "text-[clamp(16px,2.4vw,24px)] leading-snug",
    normal: "text-[clamp(20px,3.2vw,34px)] leading-tight",
    large: "text-[clamp(24px,4.0vw,42px)] leading-tight",
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Top Header / Breadcrumb & Episode Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-purple-500/20 bg-slate-900/60 p-3 sm:p-4 backdrop-blur-md">
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <Link
            href={`/anime/${animeId}${videoSource ? `?video_source=${encodeURIComponent(videoSource)}` : ''}`}
            prefetch={false}
            onClick={() => {
              setNavigatingTarget("anime");
              syncHistory(false);
            }}
            className={`shrink-0 flex items-center gap-1.5 rounded-xl px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition ${
              navigatingTarget === "anime"
                ? "bg-purple-600 text-white pointer-events-none cursor-wait"
                : "bg-purple-600/20 text-purple-300 hover:bg-purple-600 hover:text-white"
            } ${navigatingTarget && navigatingTarget !== "anime" ? "pointer-events-none opacity-60" : ""}`}
          >
            {navigatingTarget === "anime" ? (
              <Loader2 className="h-4 w-4 animate-spin text-white" />
            ) : (
              <ArrowLeft className="h-4 w-4" />
            )}
            {navigatingTarget === "anime" ? "이동 중..." : "작품으로"}
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm sm:text-base font-bold text-white truncate">
              {resolvedTitle || animeTitle}
            </h1>
            <p className="text-[11px] sm:text-xs text-purple-400 truncate">
              {initialEpTitle || `${episodeNumber}화`} • {resolvedTitle ? animeTitle : "ReAnime 1080p"}
            </p>
          </div>
        </div>

        {/* Episode Switcher Dropdown & Nav Buttons */}
        <div className="flex items-center justify-between sm:justify-end gap-2 w-full sm:w-auto shrink-0 border-t sm:border-t-0 border-white/5 pt-2 sm:pt-0">
          {linkPreEp && (
            <Link
              href={episodeUrl(linkPreEp)}
              prefetch={false}
              onClick={() => {
                setNavigatingTarget("prev");
                syncHistory(false);
              }}
              className={`flex items-center justify-center gap-1 rounded-xl border px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition shrink-0 ${
                navigatingTarget === "prev"
                  ? "border-purple-500 bg-purple-900/40 text-purple-200 pointer-events-none cursor-wait"
                  : "border-white/10 bg-slate-800/80 text-slate-300 hover:border-purple-500 hover:text-white"
              } ${navigatingTarget && navigatingTarget !== "prev" ? "pointer-events-none opacity-60" : ""}`}
            >
              {navigatingTarget === "prev" ? (
                <Loader2 className="h-4 w-4 animate-spin text-purple-300" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
              {navigatingTarget === "prev" ? "이동..." : "이전화"}
            </Link>
          )}

          {subEpisodes.length > 0 && (
            <div className="relative flex-1 sm:flex-initial min-w-[110px] max-w-[200px] sm:max-w-none">
              <select
                disabled={Boolean(navigatingTarget)}
                value={episodeNumber}
                onChange={(e) => {
                  const targetEp = e.target.value;
                  if (targetEp) {
                    setNavigatingTarget("select");
                    syncHistory(false);
                    window.location.href = episodeUrl(targetEp);
                  }
                }}
                className={`w-full appearance-none rounded-xl border border-purple-500/30 bg-slate-800/90 py-1.5 pl-3 pr-8 text-xs font-bold text-purple-200 outline-none transition focus:border-purple-400 cursor-pointer ${
                  navigatingTarget ? "opacity-70 cursor-wait" : ""
                }`}
              >
                {subEpisodes.map((ep) => (
                  <option key={ep.number} value={ep.number} className="bg-slate-900 text-white">
                    {ep.title || `${ep.number}화`}
                  </option>
                ))}
              </select>
              {navigatingTarget === "select" ? (
                <Loader2 className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-purple-300" />
              ) : (
                <List className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-purple-400" />
              )}
            </div>
          )}

          {linkNextEp && (
            <Link
              href={episodeUrl(linkNextEp)}
              prefetch={false}
              onClick={() => {
                setNavigatingTarget("next");
                // Manual navigation is not proof that the current episode ended.
                // Save the real position and let the completion threshold decide.
                syncHistory(false);
              }}
              className={`flex items-center justify-center gap-1 rounded-xl px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-white transition shrink-0 ${
                navigatingTarget === "next"
                  ? "bg-purple-700 pointer-events-none cursor-wait"
                  : "bg-purple-600 hover:bg-purple-500"
              } ${navigatingTarget && navigatingTarget !== "next" ? "pointer-events-none opacity-60" : ""}`}
            >
              {navigatingTarget === "next" ? (
                <Loader2 className="h-4 w-4 animate-spin text-white" />
              ) : null}
              <span>{navigatingTarget === "next" ? "이동..." : "다음화"}</span>
              {navigatingTarget !== "next" && <ChevronRight className="h-4 w-4" />}
            </Link>
          )}
        </div>
      </div>

      {/* Main Video Box with Subtitle HUD Overlay */}
      <div
        ref={containerRef}
        className={`overflow-hidden bg-black ${
          fullscreenMode === "web"
            ? "player-fullscreen-viewport fixed inset-0 z-50 w-screen"
            : fullscreenMode === "native"
              ? "player-fullscreen-viewport relative w-screen"
              : "relative aspect-video w-full rounded-2xl border border-purple-500/30"
        }`}
      >
        {/* Keep video and subtitle layers together; provider embeds fit their own video ratio. */}
        <div ref={mediaFrameRef} className="relative h-full w-full shrink-0 overflow-hidden">
          {/* Layer 1: External player iframe */}
          {activeEmbedUrl && !activeEmbedUrl.includes("reanime.to/watch") ? (
            <iframe
              key={`${activeEmbedUrl}:${activeServerSources.some((source) => source.id === "anikoto") ? "anikoto" : "restricted"}`}
              ref={iframeRef}
              src={activeEmbedUrl}
              onLoad={() => {
                iframeRef.current?.contentWindow?.postMessage({ command: "getStatus" }, "*");
                tryResumeIframe(undefined, true);
              }}
              title="Anime Player"
              className="absolute inset-0 h-full w-full border-0 z-0"
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              // Anissia keeps its ani_ ID when it resolves to Anikoto. Use
              // the actual stream source, including direct Anikoto playback.
              sandbox={activeServerSources.some((source) => source.id === "anikoto") ? undefined : "allow-scripts allow-same-origin allow-forms allow-presentation"}
              allowFullScreen
              referrerPolicy="no-referrer-when-downgrade"
            />
          ) : (
            <div className="absolute inset-0 z-0 flex flex-col items-center justify-center bg-black/90 p-6 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-purple-400 mb-3" />
              <p className="text-sm font-semibold text-slate-300">
                영상 스트림 플레이어를 불러오는 중입니다...
              </p>
            </div>
          )}

          {/* Layer 2a: SubtitlesOctopus ASS Canvas (WASM libass) */}
          <canvas
            ref={canvasRef}
            style={{ translate: `0 ${getSubtitleOffsetY(playerSettings.subtitleOffsetY)}px` }}
            className={`absolute inset-0 h-full w-full pointer-events-none z-10 ${
              isSubEnabled && isOctopusActive ? "block" : "hidden"
            }`}
          />

          {/* Layer 2b-Top: Top Subtitle HUD Overlay (상단 설명/가사 자막) */}
          <div style={{ translate: `0 ${getSubtitleOffsetY(playerSettings.subtitleOffsetY)}px` }} className="absolute inset-0 pointer-events-none z-20 flex flex-col justify-start items-center pt-[5%] overflow-hidden">
            <div
              ref={topHudTextRef}
              className={`font-black text-amber-300 text-center max-w-[88%] px-4 py-1.5 rounded-xl transition-all duration-75 select-none whitespace-pre-line ${subSizeClasses[subSize]}`}
              style={{
                textShadow:
                  "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, -3px 0 0 #000, 3px 0 0 #000, 0 -3px 0 #000, 0 3px 0 #000, 0 4px 14px rgba(0, 0, 0, 0.95)",
                display: "none",
              }}
            />
          </div>

          {/* Layer 2b: Text / VTT Subtitle HUD Overlay (하단 대사) */}
          <div style={{ translate: `0 ${getSubtitleOffsetY(playerSettings.subtitleOffsetY)}px` }} className="absolute inset-0 pointer-events-none z-20 flex flex-col justify-end items-center pb-[7.5%] overflow-hidden">
            <div
              ref={hudTextRef}
              className={`font-black text-white text-center max-w-[88%] px-4 py-1.5 rounded-xl transition-all duration-75 select-none whitespace-pre-line ${subSizeClasses[subSize]}`}
              style={{
                textShadow:
                  "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, -3px 0 0 #000, 3px 0 0 #000, 0 -3px 0 #000, 0 3px 0 #000, 0 4px 14px rgba(0, 0, 0, 0.95)",
                display: "none",
              }}
            />
          </div>

        </div>

        {/* Manual fallback when the provider does not expose a reliable aspect.
            Outside mediaFrameRef, so resizing cannot reload the provider iframe. */}
        {isAnikotoEmbed && isFullscreen && (
          <button type="button" onClick={cycleAspectChoice}
            title="Anikoto 영상 비율 변경: 자동 → 4:3 → 16:9"
            aria-label="화면 비율 변경"
            className="absolute left-3 top-3 z-30 flex h-10 items-center rounded-full bg-slate-950/75 px-3 text-xs font-semibold text-white backdrop-blur-md transition hover:bg-slate-900">
            비율 {aspectLabel}
          </button>
        )}

        {/* Toast Notification Banner inside player */}
        {noticeMessage && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-xl border border-purple-500/40 bg-slate-900/90 px-4 py-2 text-xs font-bold text-purple-200 backdrop-blur-md animate-fade-in pointer-events-none">
            <Sparkles className="h-4 w-4 text-purple-400" />
            {noticeMessage}
          </div>
        )}

        {/* Native fullscreen already has browser/player exit controls. Web mode needs its own exit. */}
        {fullscreenMode === "web" && (
          <div
            className="absolute top-0 right-0 z-30 pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(0.5rem,env(safe-area-inset-right))]"
          >
            {/* Top Right: Exit Fullscreen Button */}
            <div className="flex items-center justify-end gap-2 pointer-events-auto">
              {showNativeRetry && <button type="button" onClick={async () => {
                if (await retryNativeFullscreen() === "web") showNotice("네이티브 전체화면으로 전환하지 못했습니다.");
              }}
                title={nativeRetryLabel} aria-label={nativeRetryLabel}
                className="flex h-11 items-center gap-1.5 rounded-full bg-slate-900/80 px-3 text-xs font-semibold text-white backdrop-blur-md transition hover:bg-slate-800">
                <Maximize2 className="h-4 w-4" />{nativeRetryLabel}
              </button>}
              <button
                onClick={toggleFullscreen}
                type="button"
                aria-label="전체화면 종료"
                className="player-web-fullscreen-exit flex h-11 w-11 items-center justify-center rounded-full bg-slate-900/60 text-white backdrop-blur-md transition hover:bg-slate-800 active:scale-95 cursor-pointer"
                title="전체화면 종료"
              >
                <Minimize2 className="h-4 w-4 text-purple-400" />
                <span className="sr-only">전체화면 종료</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Layer 3: Subtitle Control Toolbar (플레이어 하단) */}
      <div className="rounded-2xl border border-purple-500/20 bg-slate-900/70 p-3 sm:p-4 backdrop-blur-md space-y-3">
        {/* Row 1: Subtitle Source & First Dialogue Guide */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 sm:gap-3 border-b border-white/5 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-1 text-xs font-bold text-emerald-400">
              <Subtitles className="h-3.5 w-3.5" />
              {subtitles[currentSubIndex]?.name || "자막 연동 중..."}
            </span>

            <VideoServerSelect sources={activeServerSources} selectedKey={activeServerKey}
              busy={serverBusy} error={serverError} onSelect={selectServer} />

            <button
              onClick={() => setIsModalOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-purple-500/30 bg-purple-600/20 px-2.5 py-1 text-xs font-bold text-purple-300 transition hover:bg-purple-600 hover:text-white active:scale-95 cursor-pointer"
              title="다른 자막 제작자 선택, 수동 검색, 내 파일 직접 열기"
            >
              <Search className="h-3.5 w-3.5" />
              자막 변경 / 검색
            </button>

            {/* Video Time Monitor */}
            <span className="flex items-center gap-1 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 font-mono text-xs font-semibold text-sky-400">
              <Clock className="h-3 w-3" />
              {formatTime(currentVideoTime)} / {formatTime(videoDuration)}
            </span>

            {loadingSubs && (
              <span className="flex items-center gap-1 text-xs text-purple-400 animate-pulse">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 자막 검색 중...
              </span>
            )}
          </div>

          {/* First Dialogue Guide & Instant Sync Button */}
          {firstDialogue && (
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="flex items-center gap-1.5 rounded-lg bg-slate-800/80 px-3 py-1 text-xs text-slate-300 border border-purple-500/20"
                title={`자막 첫 대사: "${firstDialogue.text}"`}
              >
                <span className="font-bold text-purple-400">📌 첫 대사:</span>
                <span className="max-w-[200px] truncate text-slate-200">
                  &quot;{firstDialogue.text}&quot;
                </span>
                <span className="font-mono text-sky-400">
                  ({formatTime(firstDialogue.start)})
                </span>
              </div>

              <button
                onClick={handleAutoSyncFirstDialogue}
                className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 px-3 py-1 text-xs font-bold text-white transition hover:brightness-110 active:scale-95 cursor-pointer"
              >
                <Target className="h-3.5 w-3.5 text-yellow-300" />
                지금 대사에 맞추기
              </button>
            </div>
          )}
        </div>

        {/* Row 2: Fine-Tuning Sync Offset & Tooling */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {/* Sync Offset Adjuster */}
          <div className="flex items-center gap-1.5 text-xs overflow-x-auto no-scrollbar py-0.5 max-w-full">
            <span className="font-bold text-slate-400 mr-1 shrink-0">싱크 미세조절:</span>
            <button
              onClick={() => adjustSync(-5.0)}
              className="shrink-0 rounded-lg border border-white/10 bg-slate-800 px-2 py-1 font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white active:scale-95 cursor-pointer"
            >
              -5s
            </button>
            <button
              onClick={() => adjustSync(-1.0)}
              className="shrink-0 rounded-lg border border-white/10 bg-slate-800 px-2 py-1 font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white active:scale-95 cursor-pointer"
            >
              -1s
            </button>
            <button
              onClick={() => adjustSync(-0.1)}
              className="shrink-0 rounded-lg border border-white/10 bg-slate-800 px-2 py-1 font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white active:scale-95 cursor-pointer"
            >
              -0.1s
            </button>

            <span className="shrink-0 min-w-[56px] text-center font-mono text-sm font-extrabold text-purple-300">
              {syncOffset > 0 ? `+${syncOffset.toFixed(1)}s` : `${syncOffset.toFixed(1)}s`}
            </span>

            <button
              onClick={() => adjustSync(0.1)}
              className="shrink-0 rounded-lg border border-white/10 bg-slate-800 px-2 py-1 font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white active:scale-95 cursor-pointer"
            >
              +0.1s
            </button>
            <button
              onClick={() => adjustSync(1.0)}
              className="shrink-0 rounded-lg border border-white/10 bg-slate-800 px-2 py-1 font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white active:scale-95 cursor-pointer"
            >
              +1s
            </button>
            <button
              onClick={() => adjustSync(5.0)}
              className="shrink-0 rounded-lg border border-white/10 bg-slate-800 px-2 py-1 font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white active:scale-95 cursor-pointer"
            >
              +5s
            </button>

            <button
              onClick={resetSync}
              className="shrink-0 flex items-center gap-1 rounded-lg border border-white/10 bg-slate-800 px-2 py-1 font-semibold text-slate-400 transition hover:bg-slate-700 hover:text-slate-200 cursor-pointer"
              title="싱크 0초로 초기화"
            >
              <RotateCcw className="h-3 w-3" />
              초기화
            </button>

            {isSavedSync && (
              <span className="shrink-0 flex items-center gap-1 text-[11px] text-emerald-400 ml-1">
                <Check className="h-3 w-3" /> 저장됨
              </span>
            )}

            <button
              type="button"
              onClick={() => setSponsorSyncOpen(true)}
              title="스폰서 이후 자막 싱크 설정"
              className="shrink-0 rounded-lg border border-purple-500/40 bg-slate-800 px-2 py-1 font-semibold text-purple-200 transition hover:border-purple-500 hover:text-white active:scale-95 cursor-pointer"
            >
              스폰서 싱크
            </button>
          </div>

          {/* Subtitle Toggle, Size & Fullscreen */}
          <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white cursor-pointer"
              title="웹 전체화면 종료 버튼 설정"
            >
              <Settings className="h-3.5 w-3.5" /> 설정
            </button>
            <button
              onClick={() => setIsSubEnabled(!isSubEnabled)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
                isSubEnabled
                  ? "bg-purple-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              자막 {isSubEnabled ? "ON" : "OFF"}
            </button>

            <button
              onClick={cycleSubSize}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white cursor-pointer"
              title="자막 크기 변경"
            >
              <Type className="h-3.5 w-3.5 text-purple-400" />
              {subSize === "small" ? "작게" : subSize === "normal" ? "보통" : "크게"}
            </button>

            {isAnikotoEmbed && (
              <button type="button" onClick={cycleAspectChoice}
                title="Anikoto 영상 비율 변경: 자동 → 4:3 → 16:9"
                aria-label="화면 비율 변경"
                className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white cursor-pointer">
                비율 {aspectLabel}
              </button>
            )}

            <button
              onClick={toggleFullscreen}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-purple-500 hover:text-white cursor-pointer"
            >
              {isFullscreen ? (
                <>
                  <Minimize2 className="h-3.5 w-3.5" /> 축소
                </>
              ) : (
                <>
                  <Maximize2 className="h-3.5 w-3.5" /> 전체화면
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <SponsorSubtitleSyncModal
        isOpen={sponsorSyncOpen}
        onClose={() => setSponsorSyncOpen(false)}
        episodeNumber={episodeNumber}
        startSeconds={sponsorSync.startSeconds}
        delaySeconds={sponsorSync.delaySeconds}
        getCurrentTime={() => lastCurrentTimeRef.current}
        onSave={saveSponsorSync}
      />

      <PlayerSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={playerSettings}
        fullscreenExitOnly
        onUpdateSettings={(next) => {
          settingsEditedRef.current = true;
          setPlayerSettings(next);
        }}
      />

      {/* Subtitle Selection & Search Modal */}
      <SubtitleSelectModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        animeId={animeId}
        animeTitle={resolvedTitle || animeTitle}
        episodeNumber={episodeNumber}
        creators={creators}
        currentSubName={subtitles[currentSubIndex]?.name}
        currentSubSourceCreatorWebsite={subtitles[currentSubIndex]?.sourceCreatorWebsite}
        currentSubMatchedTitle={subtitles[currentSubIndex]?.sourceMatchedTitle}
        onSelectSubtitle={handleSelectSubtitle}
      />
    </div>
  );
}

