Warning: truncated output (original token count: 19170)
Total output lines: 2000

"use client";
import LocalizedAnimeTitle from "@/components/LocalizedAnimeTitle";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  List,
  MessageSquare,
  Sparkles,
  Mic,
  Film,
  Search,
  Loader2,
  Wand2,
  CheckCircle2,
  RotateCw,
  Users,
  FolderOpen,
  ExternalLink,
  Check,
  UserPen,
  Download,
  Settings,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";
import PlayerSettingsModal, {
  PlayerSettings,
  loadPlayerSettings,
  savePlayerSettings,
  applyPlayerSettingsStyles,
  fetchUserSettingsFromDb,
  saveUserSettingsToDb,
  DEFAULT_PLAYER_SETTINGS,
} from "./PlayerSettingsModal";
import IframePlayer from "./IframePlayer";
import { isReanimeId } from "@/lib/providers/ids";
import type { ServerSource } from "@/lib/providers/types";

export interface EpisodeItem {
  number: number;
  title: string;
  watch_url: string;
}

export interface CreatorInfo {
  name: string;
  episode: string;
  update_date: string;
  website: string;
  is_current_ep: boolean;
  matchedTitle?: string;
  matchScore?: number;
  verifiedMatch?: boolean;
}

const SPEED_CYCLE_RATES = [1.0, 1.3, 1.5, 2.0];

function updateSpeed2xButton(rate: number, doc?: Document) {
  if (typeof rate === "number" && !isNaN(rate) && rate > 0) {
    try {
      localStorage.setItem("anime_playback_rate", String(rate));
    } catch {}
  }
  // Document PiP 활성 시 버튼은 PIP 윈도우의 문서에 있으므로,
  // 플레이어 엘리먼트의 ownerDocument 기준으로 레이블을 찾아야 한다
  const targetDoc = doc || (typeof document !== "undefined" ? document : undefined);
  if (!targetDoc) return;
  const label = (targetDoc.querySelector(".speed-rate-label") ||
    targetDoc.querySelector(".speed-2x-label")) as HTMLElement | null;
  if (!label) return;

  const isNormal = Math.abs(rate - 1.0) < 0.05;
  const rateText = isNormal ? "1x" : `${rate}x`;

  if (!isNormal) {
    label.style.background = "#ffffff";
    label.style.borderColor = "#ffffff";
    label.style.boxShadow = "0 0 10px rgba(255, 255, 255, 0.7)";
    label.style.color = "#090d16";
    label.innerText = rateText;
  } else {
    label.style.background = "rgba(255, 255, 255, 0.12)";
    label.style.borderColor = "rgba(255, 255, 255, 0.25)";
    label.style.boxShadow = "none";
    label.style.color = "#ffffff";
    label.innerText = "1x";
  }
}

interface SubtitleItem {
  name: string;
  format: "ASS" | "VTT";
  is_ass: boolean;
  content?: string;
  url?: string;
  sourceCreatorWebsite?: string;
  sourceMatchedTitle?: string;
}

const creatorIdentity = (creator: CreatorInfo) => `${creator.website}\n${creator.matchedTitle || ""}`;

interface SkipInterval {
  type: "op" | "ed" | "mixed-op" | "mixed-ed";
  label: "오프닝" | "엔딩";
  start: number;
  end: number;
}

export interface PlayerProps {
  animeId: string;
  animeTitle: string;
  animePoster?: string;
  episodeNumber: number;
  initialEpTitle?: string;
  m3u8Url: string;
  defaultVttUrl?: string;
  linkPre?: string;
  linkNext?: string;
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
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Artplayer: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Hls: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SubtitlesOctopus: any;
  }
}

export default function Player(props: PlayerProps) {
  if (
    props.streamType === "iframe" ||
    (isReanimeId(props.animeId) && !props.m3u8Url)
  ) {
    return <IframePlayer {...props} />;
  }

  const {
    animeId,
    animeTitle,
    animePoster,
    episodeNumber,
    initialEpTitle,
    m3u8Url,
    defaultVttUrl,
    linkPreEp,
    linkNextEp,
    isDub,
    subEpisodes,
    dubEpisodes,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const octopusRef = useRef<any>(null);

  // Hybrid PiP Refs
  const currentAssContentRef = useRef<string | null>(null);
  const currentSubRef = useRef<SubtitleItem | null>(null);
  const pendingSubtitleRef = useRef<SubtitleItem | null>(null);
  const applySubtitleRef = useRef<((sub: SubtitleItem | null, offset?: number) => void) | null>(null);
  const syncSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSubtitleSettingsRef = useRef<((currentSubs: SubtitleItem[], activeIdx: number) => void) | null>(null);
  const currentSyncOffsetRef = useRef<number>(0.0);
  const docPipWindowRef = useRef<Window | null>(null);
  const docPipPlaceholderRef = useRef<HTMLDivElement | null>(null);
  const nativePipTextTrackRef = useRef<TextTrack | null>(null);
  const pipTrackElementRef = useRef<HTMLTrackElement | null>(null);
  const currentBlobUrlRef = useRef<string | null>(null);

  // 즉시 플레이어 음원/재생 중지 및 자원 해제 (페이지 이동, 언마운트, 회차 이동 시 음원 누출 방지)
  const stopPlayerImmediately = useCallback(() => {
    try {
      // 1) PiP 종료 (Document PiP 및 Native PiP)
      if (docPipWindowRef.current && !docPipWindowRef.current.closed) {
        try {
          const pipVids = docPipWindowRef.current.document.querySelectorAll("video");
          pipVids.forEach((v) => {
            try {
              v.pause();
              v.muted = true;
              v.volume = 0;
              v.removeAttribute("src");
              v.load();
            } catch {}
          });
          docPipWindowRef.current.close();
        } catch {}
        docPipWindowRef.current = null;
      }
      if (typeof document !== "undefined" && document.pictureInPictureElement) {
        try {
          document.exitPictureInPicture().catch(() => {});
        } catch {}
      }

      // 2) ArtPlayer 인스턴스 정지 및 HLS 해제
      const art = artRef.current;
      if (art) {
        if (art.hls) {
          try {
            art.hls.stopLoad?.();
            art.hls.detachMedia?.();
            art.hls.destroy?.();
          } catch {}
          art.hls = null;
        }
        if (art.video) {
          try {
            art.video.pause();
            art.video.muted = true;
            art.video.volume = 0;
            art.video.removeAttribute("src");
            art.video.load();
          } catch {}
        }
      }

      // 3) 혹시 DOM 컨테이너에 남아있을 수 있는 모든 video 태그 정지
      if (containerRef.current) {
        try {
          const vids = containerRef.current.querySelectorAll("video");
          vids.forEach((v) => {
            try {
              v.pause();
              v.muted = true;
              v.volume = 0;
              v.removeAttribute("src");
              v.load();
            } catch {}
          });
        } catch {}
      }
    } catch (e) {
      console.warn("[stopPlayerImmediately error]:", e);
    }
  }, []);

  // Episode Navigator States
  const currentEpisodes = (isDub ? dubEpisodes : subEpisodes) || [];

  // Episode & Stream States (무중단 회차 전환 지원)
  const [currentEp, setCurrentEp] = useState<number>(episodeNumber);
  const [currentEpTitle, setCurrentEpTitle] = useState<string>(() => {
    if (initialEpTitle) return initialEpTitle;
    const found = currentEpisodes.find((e) => e.number === episodeNumber);
    return found?.title || `${episodeNumber}화`;
  });
  const [currentM3u8Url, setCurrentM3u8Url] = useState<string>(m3u8Url);
  const [currentVttUrl, setCurrentVttUrl] = useState<string>(defaultVttUrl || "");
  const [currentPreEp, setCurrentPreEp] = useState<number | null>(linkPreEp ?? null);
  const [currentNextEp, setCurrentNextEp] = useState<number | null>(linkNextEp ?? null);
  const [isSwitchingEp, setIsSwitchingEp] = useState<number | null>(null);
  const [navigatingTarget, setNavigatingTarget] = useState<string | null>(null);

  const currentEpRef = useRef(currentEp);
  currentEpRef.current = currentEp;
  const currentM3u8UrlRef = useRef(currentM3u8Url);
  currentM3u8UrlRef.current = currentM3u8Url;
  const currentPreEpRef = useRef(currentPreEp);
  currentPreEpRef.current = currentPreEp;
  const currentNextEpRef = useRef(currentNextEp);
  currentNextEpRef.current = currentNextEp;
  const isSwitchingEpRef = useRef(false);
  const syncHistoryRef = useRef<((isCompleted?: boolean) => void) | null>(null);
  const switchEpisodeRef = useRef<((targetEp: number) => Promise<void>) | null>(null);
  const lastSyncTimeRef = useRef<number>(0);

  // External navigation (props change) sync
  const isFirstMountRef = useRef(true);
  useEffect(() => {
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      return;
    }
    setCurrentEp(episodeNumber);
    if (initialEpTitle) {
      setCurrentEpTitle(initialEpTitle);
    } else {
      const found = currentEpisodes.find((e) => e.number === episodeNumber);
      setCurrentEpTitle(found?.title || `${episodeNumber}화`);
    }
    setCurrentM3u8Url(m3u8Url);
    setCurrentVttUrl(defaultVttUrl || "");
    setCurrentPreEp(linkPreEp ?? null);
    setCurrentNextEp(linkNextEp ?? null);

    // 이미 플레이어가 초기화되어 있고 회차가 달라졌다면 switchEpisode 호출 (전환 중이 아닐 때만)
    if (artRef.current && !isSwitchingEpRef.current && episodeNumber !== currentEpRef.current && switchEpisodeRef.current) {
      switchEpisodeRef.current(episodeNumber);
    }
  }, [episodeNumber, initialEpTitle, m3u8Url, defaultVttUrl, linkPreEp, linkNextEp]);

  const CHUNK_SIZE = 50;
  const chunkCount = Math.ceil(currentEpisodes.length / CHUNK_SIZE);

  const getInitialChunkIndex = () => {
    if (currentEpisodes.length <= CHUNK_SIZE) return 0;
    const foundIdx = currentEpisodes.findIndex((e) => e.number === episodeNumber);
    if (foundIdx !== -1) {
      return Math.floor(foundIdx / CHUNK_SIZE);
    }
    return 0;
  };

  const [selectedChunk, setSelectedChunk] = useState<number>(getInitialChunkIndex);
  const [jumpInput, setJumpInput] = useState<string>("");
  const [jumpError, setJumpError] = useState<string>("");
  const activePillRef = useRef<HTMLButtonElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Sync selected chunk when currentEp or list changes
  useEffect(() => {
    if (currentEpisodes.length > CHUNK_SIZE) {
      const foundIdx = currentEpisodes.findIndex((e) => e.number === currentEp);
      if (foundIdx !== -1) {
        setSelectedChunk(Math.floor(foundIdx / CHUNK_SIZE));
      }
    }
  }, [currentEp, currentEpisodes.length]);

  // Auto scroll active episode into center view (전체화면 풀림 방지)
  useEffect(() => {
    const timer = setTimeout(() => {
      // 🌟 전체화면 중에는 외부 DOM 스크롤 시 브라우저가 전체화면을 강제 종료하므로 실행하지 않음
      if (document.fullscreenElement || artRef.current?.fullscreen) return;
      if (scrollContainerRef.current && activePillRef.current) {
        const container = scrollContainerRef.current;
        const pill = activePillRef.current;
        const offsetLeft = pill.offsetLeft - container.offsetWidth / 2 + pill.offsetWidth / 2;
        container.scrollTo({
          left: Math.max(0, offsetLeft),
          behavior: "smooth",
        });
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [selectedChunk, currentEp]);

  // 전체화면 해제 시 현재 활성 회차 알약 스크롤 위치 복원
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && !artRef.current?.fullscreen) {
        if (scrollContainerRef.current && activePillRef.current) {
          const container = scrollContainerRef.current;
          const pill = activePillRef.current;
          const offsetLeft = pill.offsetLeft - container.offsetWidth / 2 + pill.offsetWidth / 2;
          container.scrollTo({
            left: Math.max(0, offsetLeft),
            behavior: "smooth",
          });
        }
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  // 무중단 다음화 / 특정 회차 전환 함수 (전체화면 유지)
  const switchEpisode = useCallback(
    async (targetEp: number) => {
      if (isSwitchingEpRef.current || !artRef.current) return;
      isSwitchingEpRef.current = true;
      setIsSwitchingEp(targetEp);

      const art = artRef.current;
      art.notice.show = `${targetEp}화 로딩 중...`;

      try {
        // 1. 현재 에피소드 시청 완료 기록 및 로컬 캐시 정리
        const prevSaveKey = `anime_progress_${animeId}_ep${currentEpRef.current}`;
        localStorage.removeItem(prevSaveKey);
        if (syncHistoryRef.current) {
          syncHistoryRef.current(true);
        }

        // 2. 이전 자막 정리 (새 회차 자막 로드 전 잔상 방지)
        if (octopusRef.current) {
          try {
            octopusRef.current.dispose();
          } catch {}
          octopusRef.current = null;
        }
        if (containerRef.current) {
          containerRef.current
            .querySelectorAll(".libassjs-canvas-parent, canvas.libassjs-canvas")
            .forEach((el) => el.remove());
        }
        if (art.template?.$player) {
          art.template.$player
            .querySelectorAll(".libassjs-canvas-parent, canvas.libassjs-canvas")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .forEach((el: any) => el.remove());
        }
        // Native PiP 자막 트랙 큐 정리 (새 회차 자막 로드 전 잔상 방지)
        if (nativePipTextTrackRef.current && nativePipTextTrackRef.current.cues) {
          Array.from(nativePipTextTrackRef.current.cues).forEach((c) => {
            try {
              nativePipTextTrackRef.current?.removeCue(c);
            } catch {}
          });
        }
        if (art.template?.$subtitle) {
          art.template.$subtitle.style.display = "none";
        }

        // 3. 새 회차 스트림 정보 API 호출
        const res = await fetch(
          `/api/anime/episode_info?id=${encodeURIComponent(animeId)}&ep=${targetEp}${isDub ? "&is_dub=1" : ""}`
        );
        const data = await res.json();

        if (!data.success || !data.proxied_m3u8) {
          throw new Error(data.message || "새 회차 스트림 정보를 불러오지 못했습니다.");
        }

        const newM3u8 = data.proxied_m3u8;
        const newVtt = data.proxied_vtt || "";
        let newNextEp = data.link_next_ep_num ?? null;
        let newPreEp = data.link_pre_ep_num ?? null;
        const epTitle = data.episode_title || `${targetEp}화`;

        // 클라이언트 목록 기반 이전/다음 회차 번호 보정
        const foundIdx = currentEpisodes.findIndex((e) => e.number === targetEp);
        if (foundIdx !== -1) {
          if (newPreEp === null && foundIdx > 0) newPreEp = currentEpisodes[foundIdx - 1].number;
          if (newNextEp === null && foundIdx + 1 < currentEpisodes.length) newNextEp = currentEpisodes[foundIdx + 1].number;
        }

        // 4. 페이지 이동 없이 브라우저 URL 갱신 (Next.js 가로채기 방지 -> 전체화면 유지)
        const nextUrl = `/watch/${animeId}/${targetEp}${isDub ? "?dub=1" : ""}`;
        try {
          // Next.js App Router의 라우트 변경(RSC 리마운트 및 전체화면 풀림) 인터셉트 방지: __NA: true
          const nextState = { ...(window.history.state || {}), __NA: true };
          window.history.replaceState(nextState, "", nextUrl);
        } catch {
          try {
            window.history.replaceState(null, "", nextUrl);
          } catch {}
        }
        document.title = `${animeTitle} ${epTitle} - Netizen Anime`;

        // 5. 상태 및 ref 즉각 동기화 (비동기 렌더 지연 없이 이벤트 핸들러가 즉시 새 회차 참조)
        currentEpRef.current = targetEp;
        currentM3u8UrlRef.current = newM3u8;
        currentPreEpRef.current = newPreEp;
        currentNextEpRef.current = newNextEp;
        lastSyncTimeRef.current = 0; // 새 회차 첫 진행도 즉시 DB 동기화 준비

        setCurrentEp(targetEp);
        setCurrentEpTitle(epTitle);
        setCurrentM3u8Url(newM3u8);
        setCurrentVttUrl(newVtt);
        setCurrentPreEp(newPreEp);
        setCurrentNextEp(newNextEp);

        // 6. 플레이어 스트림 전환 및 즉시 재생 (전체화면 / PIP 상태 보존)
        const isDocPip = Boolean(docPipWindowRef.current && !docPipWindowRef.current.closed);
        const isNativePip = Boolean(
          (document.pictureInPictureElement && document.pictureInPictureElement === art?.video) ||
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (art?.video && (art.video as any).webkitPresentationMode === "picture-in-picture")
        );
        const isAnyPip = isDocPip || isNativePip;

        // PIP 모드 활성 중에는 전체화면 복원을 시도하지 않음 (전체화면일 때는 전체화면 완벽 보존)
        const wasFullscreen = !isAnyPip && Boolean(art.fullscreen || document.fullscreenElement);
        const wasFullscreenWeb = !isAnyPip && Boolean(art.fullscreenWeb);
        try {
          await Promise.race([
            art.switchUrl(newM3u8),
            new Promise((resolve) => setTimeout(resolve, 4000)),
          ]);
        } catch (switchErr) {
          console.warn("[art.switchUrl non-fatal error]:", switchErr);
        }

        try {
          await art.play();
        } catch {
          // 브라우저 자동재생 정책 대비
        }

        if (wasFullscreen && !art.fullscreen && !document.fullscreenElement) {
          try {
            art.fullscreen = true;
          } catch {}
        }
        if (wasFullscreenWeb && !art.fullscreenWeb) {
          try {
            art.fullscreenWeb = true;
          } catch {}
        }

        // Document PiP 활성 중이면 PIP 윈도우 스타일 동기화
        if (isDocPip && docPipWindowRef.current && !docPipWindowRef.current.closed) {
          try {
            const pipWin = docPipWindowRef.current;
            const pipDoc = pipWin.document;
            const DYNAMIC_STYLE_IDS = ["dynamic-sub-style", "player-custom-settings-style"];
            for (const id of DYNAMIC_STYLE_IDS) {
              const src = document.getElementById(id);
              if (!src) continue;
              let dst = pipDoc.getElementById(id);
              if (!dst) {
                dst = pipDoc.createElement("style");
                dst.id = id;
                pipDoc.head.appendChild(dst);
              }
              dst.textContent = src.textContent;
            }
          } catch {}
        }

        // 7. 이어보기 시점 확인
        const newSaveKey = `anime_progress_${animeId}_ep${targetEp}`;
        const savedSec = parseFloat(localStorage.getItem(newSaveKey) || "0");
        if (savedSec > 10) {
          art.currentTime = savedSec;
          art.notice.show = `이어보기: ${Math.floor(savedSec / 60)}분 ${Math.floor(savedSec % 60)}초부터 재생`;
        } else {
          art.notice.show = `▶ ${epTitle} 재생 시작`;
        }
      } catch (err) {
        console.error("[Seamless switch error]:", err);
        art.notice.show = `${targetEp}화 스트림을 불러오지 못했습니다. 다시 시도해 주세요.`;
      } finally {
        isSwitchingEpRef.current = false;
        setIsSwitchingEp(null);
      }
    },
    [animeId, animeTitle, isDub, currentEpisodes]
  );
  switchEpisodeRef.current = switchEpisode;

  const handleJump = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const targetNum = parseInt(jumpInput.trim(), 10);
    if (isNaN(targetNum) || targetNum <= 0) {
      setJumpError("회차 번호를 입력해주세요.");
      setTimeout(() => setJumpError(""), 3000);
      return;
    }

    const matched = currentEpisodes.find((ep) => ep.number === targetNum);
    if (!matched) {
      setJumpError(`${targetNum}화를 찾을 수 없습니다.`);
      setTimeout(() => setJumpError(""), 3000);
      return;
    }

    setJumpError("");
    switchEpisode(targetNum);
  };

  const displayedEpisodes =
    chunkCount > 1
      ? currentEpisodes.slice(selectedChunk * CHUNK_SIZE, (selectedChunk + 1) * CHUNK_SIZE)
      : currentEpisodes;

  const [subs, setSubs] = useState<SubtitleItem[]>([]);
  const [selectedSubIndex, setSelectedSubIndex] = useState<number>(0);
  const [isLoadingSubs, setIsLoadingSubs] = useState<boolean>(true);
  const [needsManualSubtitleChoice, setNeedsManualSubtitleChoice] = useState(false);
  const [creators, setCreators] = useState<CreatorInfo[]>([]);
  const [loadingCreatorName, setLoadingCreatorName] = useState<string | null>(null);
  const [currentSyncOffset, setCurrentSyncOffset] = useState<number>(0.0);
  const [currentSubSize, setCurrentSubSize] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("anime_sub_size");
      if (saved) {
        const val = parseInt(saved, 10);
        if (val === 28) return 22;
        return val || 22;
      }
    }
    return 22;
  });
  const localFileInputRef = useRef<HTMLInputElement>(null);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingSub, setUploadingSub] = useState(false);
  const [openingLocalSub, setOpeningLocalSub] = useState(false);

  // Skip States & Preferences
  const [skipIntervals, setSkipIntervals] = useState<SkipInterval[]>([]);
  const [playerSettings, setPlayerSettings] = useState<PlayerSettings>(loadPlayerSettings);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState<boolean>(false);
  const [autoSkipEnabled, setAutoSkipEnabled] = useState<boolean>(() => loadPlayerSettings().autoSkip);
  const [autoNextEnabled, setAutoNextEnabled] = useState<boolean>(() => loadPlayerSettings().autoNext);
  const [audioAnalysisStatus, setAudioAnalysisStatus] = useState<
    "idle" | "running" | "success" | "none"
  >("idle");
  const [audioAnalysisText, setAudioAnalysisText] = useState<string>("오디오 AI 분석");
  const [skipSource, setSkipSource] = useState<string>("");
  const [floatingSkip, setFloatingSkip] = useState<{
    show: boolean;
    label: string;
    targetTime: number;
    isManual?: boolean;
  }>({ show: false, label: "", targetTime: 0 });

  // Episode history map for in-player episode pills
  const [epHistoryMap, setEpHistoryMap] = useState<
    Record<number, { watch_time: number; duration: number; is_completed: boolean }>
  >({});

  // Apply initial player settings styles and maintain ref
  const playerSettingsRef = useRef<PlayerSettings>(playerSettings);
  useEffect(() => {
    playerSettingsRef.current = playerSettings;
    applyPlayerSettingsStyles(playerSettings);

    // 더블탭 레이블 및 모바일 중앙 컨트롤 스킵 초수 실시간 동기화
    try {
      const doc = (artRef.current?.template?.$player as HTMLElement | undefined)?.ownerDocument || document;
      const dur = playerSettings.doubleTouchDuration || 10;
      const leftLabel = doc.getElementById("dt-label-left");
      const rightLabel = doc.getElementById("dt-label-right");
      const secBack = doc.getElementById("mobile-seek-sec-back");
      const secFwd = doc.getElementById("mobile-seek-sec-fwd");
      if (leftLabel) leftLabel.textContent = `-${dur}초`;
      if (rightLabel) rightLabel.textContent = `+${dur}초`;
      if (secBack) secBack.textContent = `${dur}`;
      if (secFwd) secFwd.textContent = `${dur}`;
    } catch {}

    if (artRef.current) {
      artRef.current.hotkey = playerSettings.hotkey;
      if (artRef.current.option) {
        artRef.current.option.gesture = playerSettings.mobileGesture;
      }
    }
  }, [playerSettings]);

  // 계정 DB에서 플레이어 환경설정 불러와 동기화
  useEffect(() => {
    let isCancelled = false;
    fetchUserSettingsFromDb().then((result) => {
      if (isCancelled) return;
      if (result.authenticated && result.settings) {
        const merged: PlayerSettings = {
          ...DEFAULT_PLAYER_SETTINGS,
          ...result.settings,
        };
        setPlayerSettings(merged);
        setAutoSkipEnabled(merged.autoSkip);
        setAutoNextEnabled(merged.autoNext);
        applyPlayerSettingsStyles(merged);
        if (artRef.current) {
          artRef.current.hotkey = merged.hotkey;
        }
        try {
          localStorage.setItem("anime_player_settings", JSON.stringify(merged));
          localStorage.setItem("anime_auto_skip", merged.autoSkip ? "1" : "0");
          localStorage.setItem("anime_auto_next", merged.autoNext ? "1" : "0");
        } catch {}
      } else if (result.authenticated && !result.settings) {
        // 계정은 있으나 DB에 설정이 없는 경우, 현재 설정(PIP ON 포함)을 DB에 저장
        saveUserSettingsToDb(loadPlayerSettings()).catch(() => {});
      }
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  // Fetch history map for episode pills
  useEffect(() => {
    let isCancelled = false;
    fetch(`/api/anime/history?anime_id=${animeId}`)
      .then((r) => r.json())
      .then((d) => {
        if (isCancelled || !d.success || !Array.isArray(d.items)) return;
        const map: Record<number, { watch_time: number; duration: number; is_completed: boolean }> = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        d.items.forEach((item: any) => {
          const num = Number(item.episode_number);
          if (num > 0) {
            map[num] = {
              watch_time: parseFloat(item.watch_time || item.current_time || "0"),
              duration: parseFloat(item.duration || "0"),
              is_completed: Boolean(item.is_completed),
            };
          }
        });

        // LocalStorage fallback merge
        for (let i = 1; i <= 2000; i++) {
          const localSec = localStorage.getItem(`anime_progress_${animeId}_ep${i}`);
          if (localSec && !map[i]) {
            const sec = parseFloat(localSec);
            if (sec > 5) {
              map[i] = { watch_time: sec, duration: 0, is_completed: false };
            }
          }
        }

        setEpHistoryMap(map);
      })
      .catch(() => {});

    return () => {
      isCancelled = true;
    };
  }, [animeId]);

  const handleUpdateSettings = (newSettings: PlayerSettings) => {
    setPlayerSettings(newSettings);
    setAutoSkipEnabled(newSettings.autoSkip);
    setAutoNextEnabled(newSettings.autoNext);
    if (artRef.current) {
      artRef.current.hotkey = newSettings.hotkey;
    }
  };

  const toggleAutoSkip = () => {
    const nextVal = !playerSettings.autoSkip;
    const nextSettings = { ...playerSettings, autoSkip: nextVal };
    setPlayerSettings(nextSettings);
    savePlayerSettings(nextSettings);
    setAutoSkipEnabled(nextVal);
    if (artRef.current) {
      artRef.current.notice.show = `OP/ED 자동 스킵: ${nextVal ? "활성화(ON)" : "비활성화(OFF)"}`;
    }
  };

  const toggleAutoNext = () => {
    const nextVal = !playerSettings.autoNext;
    const nextSettings = { ...playerSettings, autoNext: nextVal };
    setPlayerSettings(nextSettings);
    savePlayerSettings(nextSettings);
    setAutoNextEnabled(nextVal);
    if (artRef.current) {
      artRef.current.notice.show = …5170 tokens truncated…Picture;
    if (!docPip) return;

    const pipWindow = await docPip.requestWindow({
      width: width,
      height: height,
    });

    docPipWindowRef.current = pipWindow;

    // 메인 문서 스타일 복사
    document.querySelectorAll('style, link[rel="stylesheet"]').forEach((el) => {
      try {
        pipWindow.document.head.appendChild(el.cloneNode(true));
      } catch {}
    });

    // 사용자 자막 크기 변수 동기화
    try {
      const rootStyle = getComputedStyle(document.documentElement);
      const userSubSize = rootStyle.getPropertyValue("--user-sub-size");
      const userSubScale = rootStyle.getPropertyValue("--user-sub-scale");
      if (userSubSize) pipWindow.document.documentElement.style.setProperty("--user-sub-size", userSubSize);
      if (userSubScale) pipWindow.document.documentElement.style.setProperty("--user-sub-scale", userSubScale);
    } catch {}

    const pipResetStyle = pipWindow.document.createElement("style");
    pipResetStyle.textContent = `
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        background-color: #000 !important;
        overflow: hidden !important;
      }
      .art-video-player {
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        border-radius: 0 !important;
      }
    `;
    pipWindow.document.head.appendChild(pipResetStyle);

    const placeholder = document.createElement("div");
    placeholder.id = "artplayer-pip-placeholder";
    placeholder.style.cssText =
      "width:100%;height:100%;min-height:320px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#090d16;color:#c084fc;font-size:15px;font-weight:700;gap:14px;border:1px dashed rgba(168,85,247,0.4);border-radius:0;";
    placeholder.innerHTML = `
      <div style="width:48px;height:48px;border-radius:50%;background:rgba(168,85,247,0.15);display:flex;align-items:center;justify-content:center;">
        <svg viewBox="0 0 1024 1024" width="26" height="26" fill="#c084fc"><path d="M844.8 219.648h-665.6c-6.144 0-10.24 4.608-10.24 10.752v563.2c0 5.632 4.096 10.24 10.24 10.24h256v92.16h-256a102.4 102.4 0 0 1-102.4-102.4v-563.2c0-56.832 45.568-102.4 102.4-102.4h665.6a102.4 102.4 0 0 1 102.4 102.4v204.8h-92.16v-204.8c0-6.144-4.608-10.752-10.24-10.752zM614.4 588.8c-28.672 0-51.2 22.528-51.2 51.2v204.8c0 28.16 22.528 51.2 51.2 51.2h281.6c28.16 0 51.2-23.04 51.2-51.2v-204.8c0-28.672-23.04-51.2-51.2-51.2H614.4z"></path></svg>
      </div>
      <span>화면 속 화면 (PIP) 모드로 재생 중입니다</span>
      <button type="button" class="btn-pip-restore" style="padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;color:#fff;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.3);cursor:pointer;">PIP 닫기</button>
    `;
    const restoreBtn = placeholder.querySelector(".btn-pip-restore");
    if (restoreBtn) {
      restoreBtn.addEventListener("click", () => exitDocumentPip());
    }

    docPipPlaceholderRef.current = placeholder;
    if (playerEl.parentNode) {
      playerEl.parentNode.insertBefore(placeholder, playerEl);
    }
    pipWindow.document.body.appendChild(playerEl);

    const ensureAssCanvasLayout = () => {
      const art = artRef.current;
      const player = art?.template?.$player as HTMLElement | undefined;
      const canvas = player
        ? (player.querySelector("canvas.libassjs-canvas") as HTMLElement | null)
        : (document.querySelector("canvas.libassjs-canvas") as HTMLElement | null);
      if (canvas) canvas.style.display = "block";
      const parent = player
        ? (player.querySelector(".libassjs-canvas-parent") as HTMLElement | null)
        : (document.querySelector(".libassjs-canvas-parent") as HTMLElement | null);
      if (parent) parent.style.display = "block";

      if (octopusRef.current && typeof octopusRef.current.resize === "function") {
        try {
          octopusRef.current.resize();
        } catch {}
      }
    };

    const onResize = () => {
      if (artRef.current) {
        try {
          artRef.current.resize();
        } catch {}
      }
      ensureAssCanvasLayout();
    };

    pipWindow.addEventListener("resize", onResize);
    setTimeout(onResize, 50);
    setTimeout(ensureAssCanvasLayout, 150);

    pipWindow.addEventListener("pagehide", () => {
      restoreFromDocumentPip();
    });

    if (art && art.notice) art.notice.show = "✨ PIP 모드 활성화됨";
  }, [isDocumentPipActive, exitDocumentPip, restoreFromDocumentPip]);

  // 14. 하이브리드 PIP 토글러 (jcore와 100% 동일한 1순위 Document PiP + 2순위 Video PiP 구조)
  const toggleHybridPip = useCallback(async () => {
    const art = artRef.current;
    if (!art || !art.video) return;

    // 1. 이미 Document PiP 활성 상태인 경우 -> 닫기
    if (isDocumentPipActive()) {
      exitDocumentPip();
      return;
    }

    // 2. 이미 네이티브 Video PiP 활성 상태인 경우 -> 종료
    if (
      document.pictureInPictureElement ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (art.video && (art.video as any).webkitPresentationMode === "picture-in-picture")
    ) {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } else if ((art.video as any).webkitSetPresentationMode && typeof (art.video as any).webkitSetPresentationMode === "function") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (art.video as any).webkitSetPresentationMode("inline");
        }
      } catch (err) {
        console.warn("exitPictureInPicture failed:", err);
      }
      return;
    }

    // 🌟 1순위: Document Picture-in-Picture 지원 시 (Chrome 116+, Edge 최신) -> 자막/캔버스/스킵버튼 통째로 PIP 진입
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ("documentPictureInPicture" in window && typeof (window as any).documentPictureInPicture?.requestWindow === "function") {
      try {
        await enterDocumentPip();
        return;
      } catch (docPipErr) {
        console.warn("Document PiP failed, fallback to Video PiP:", docPipErr);
      }
    }

    // 🌟 2순위: 표준 Video Picture-in-Picture Fallback (iOS Safari, Mac Safari 등) -> 네이티브 TextTrack으로 자막 출력
    if (art.video.readyState === 0) {
      if (art.notice) art.notice.show = "영상이 로딩 중입니다. 잠시 후 다시 시도해주세요.";
      return;
    }

    if (art.video.disablePictureInPicture) {
      art.video.disablePictureInPicture = false;
    }

    try {
      // PiP 진입 직전 실시간 자막 트랙 바인딩
      syncCuesToPipTrack(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((art.video as any).webkitSetPresentationMode && typeof (art.video as any).webkitSetPresentationMode === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art.video as any).webkitSetPresentationMode("picture-in-picture");
        return;
      } else if (art.video.requestPictureInPicture) {
        await art.video.requestPictureInPicture();
        return;
      }
    } catch (videoPipErr: any) {
      console.error("Video PiP failed:", videoPipErr);
      updateNativeTrackElement("");
      hideAllNativeVideoTracks();
      if (art.notice) art.notice.show = "PIP 모드를 실행할 수 없습니다.";
    }
  }, [isDocumentPipActive, exitDocumentPip, enterDocumentPip, syncCuesToPipTrack, updateNativeTrackElement, hideAllNativeVideoTracks]);

  // 15. Subtitle switcher
  const applySubtitle = useCallback(
    (sub: SubtitleItem | null, offset = 0.0) => {
      currentSubRef.current = sub;
      pendingSubtitleRef.current = sub;
      if (!artRef.current) return;
      const art = artRef.current;

      // 1. Clean up existing ASS SubtitlesOctopus instance and canvas elements
      if (octopusRef.current) {
        try {
          octopusRef.current.dispose();
        } catch {}
        octopusRef.current = null;
      }
      if (containerRef.current) {
        containerRef.current
          .querySelectorAll(".libassjs-canvas-parent, canvas.libassjs-canvas")
          .forEach((el) => el.remove());
      }
      if (art.template?.$player) {
        art.template.$player
          .querySelectorAll(".libassjs-canvas-parent, canvas.libassjs-canvas")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .forEach((el: any) => el.remove());
      }

      if (!sub || sub.name === "자막 끄기") {
        currentAssContentRef.current = null;
        art.subtitle.show = false;
        if (art.template?.$subtitle) art.template.$subtitle.style.display = "none";
        updateNativeTrackElement("");
        hideAllNativeVideoTracks();
        if (nativePipTextTrackRef.current) nativePipTextTrackRef.current.mode = "hidden";
        syncCuesToPipTrack(isNativePipActive());
        return;
      }

      if (sub.is_ass) {
        art.subtitle.show = false;
        // VTT 자막 영역의 인라인 display가 남아 ASS와 중복 표시되는 문제 방지
        if (art.template?.$subtitle) {
          art.template.$subtitle.style.display = "none";
        }
        let subBlobUrl = sub.url || "";
        if (!subBlobUrl && sub.content) {
          const blob = new Blob([sub.content], { type: "text/plain;charset=utf-8" });
          subBlobUrl = URL.createObjectURL(blob);
        }

        if (!sub.content && sub.url) {
          fetch(toAbsoluteUrl(sub.url))
            .then((r) => r.text())
            .then((txt) => {
              currentAssContentRef.current = txt;
              syncCuesToPipTrack(isNativePipActive());
            })
            .catch(() => {});
        } else {
          currentAssContentRef.current = sub.content || null;
          syncCuesToPipTrack(isNativePipActive());
        }

        if (window.SubtitlesOctopus) {
          try {
            octopusRef.current = new window.SubtitlesOctopus({
              video: art.video,
              subUrl: subBlobUrl,
              subContent: sub.content || undefined,
              fonts: ["/libass/default.woff2"],
              fallbackFont: "/libass/default.woff2",
              workerUrl: "/libass/subtitles-octopus-worker.js",
              legacyWorkerUrl: "/libass/subtitles-octopus-worker.js",
              timeOffset: offset,
              onReady: () => {
                art.notice.show = `${sub.name} (ASS 특수효과) 자막 로드 완료`;
                const playerEl = (art.template?.$player as HTMLElement | undefined) || containerRef.current;
                if (playerEl) {
                  const canvas = playerEl.querySelector("canvas.libassjs-canvas") as HTMLElement | null;
                  if (canvas) canvas.style.display = "block";
                  const parent = playerEl.querySelector(".libassjs-canvas-parent") as HTMLElement | null;
                  if (parent) parent.style.display = "block";
                }
                if (octopusRef.current && typeof octopusRef.current.resize === "function") {
                  try {
                    octopusRef.current.resize();
                  } catch {}
                }
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onError: (err: any) => {
                console.error("[SubtitlesOctopus error]:", err);
                art.notice.show = `${sub.name} ASS 자막 초기화 에러`;
              },
            });
          } catch (e) {
            console.error("[SubtitlesOctopus init error]:", e);
          }
        }
      } else {
        art.subtitle.show = true;
        if (art.template?.$player) {
          art.template.$player.classList.add("art-subtitle-show");
        }
        if (art.template?.$subtitle) {
          art.template.$subtitle.style.display = "flex";
        }

        let vttUrl = sub.url || "";
        if (!vttUrl && sub.content) {
          const blob = new Blob([sub.content], { type: "text/vtt;charset=utf-8" });
          vttUrl = URL.createObjectURL(blob);
        }
        if (vttUrl) {
          const absVttUrl = toAbsoluteUrl(vttUrl);
          art.subtitle
            .switch(absVttUrl, { name: sub.name, type: "vtt", escape: false })
            .then(() => {
              art.subtitle.show = true;
              if (art.template?.$player) {
                art.template.$player.classList.add("art-subtitle-show");
              }
              if (art.template?.$subtitle) {
                art.template.$subtitle.style.display = "flex";
              }
              syncCuesToPipTrack(isNativePipActive());
            })
            .catch((err: any) => {
              console.warn("Subtitle switch error:", err);
              art.subtitle.show = true;
              if (art.template?.$player) {
                art.template.$player.classList.add("art-subtitle-show");
              }
              if (art.template?.$subtitle) {
                art.template.$subtitle.style.display = "flex";
              }
            });
          art.subtitle.offset = offset;
          art.notice.show = `${sub.name} 자막 로드 완료`;
        }
      }
    },
    [syncCuesToPipTrack, isNativePipActive, toAbsoluteUrl, updateNativeTrackElement, hideAllNativeVideoTracks]
  );

  useEffect(() => {
    applySubtitleRef.current = applySubtitle;
  }, [applySubtitle]);

  // Subtitle font size controller
  const setSubtitleFontSize = useCallback((size: number) => {
    const numSize = parseInt(String(size), 10) || 22;
    const scale = (numSize / 22).toFixed(3);
    setCurrentSubSize(numSize);
    try {
      localStorage.setItem("anime_sub_size", String(numSize));
    } catch {}

    document.documentElement.style.setProperty("--user-sub-size", `${numSize}px`);
    document.documentElement.style.setProperty("--user-sub-scale", scale);

    let styleEl = document.getElementById("dynamic-sub-style");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "dynamic-sub-style";
      document.head.appendChild(styleEl);
    }
    styleEl.innerHTML = `
      :root {
        --user-sub-size: ${numSize}px !important;
        --user-sub-scale: ${scale} !important;
      }
      .art-video-player .art-subtitle,
      .art-video-player .art-subtitle .art-subtitle-line,
      .art-video-player .art-subtitle p,
      .art-video-player .art-subtitle div,
      .art-video-player .art-subtitle span {
        font-size: ${numSize}px !important;
        --art-subtitle-font-size: ${numSize}px !important;
      }
    `;

    if (artRef.current && artRef.current.subtitle) {
      try {
        artRef.current.subtitle.style("fontSize", `${numSize}px`);
      } catch {}
    }
    if (artRef.current) {
      artRef.current.notice.show = `자막 크기: ${numSize}px`;
    }
    // Document PiP 활성 시 PIP 문서에도 즉시 반영
    syncPipStyles();
  }, [syncPipStyles]);

  // Subtitle sync offset controller
  const setSubtitleSyncOffset = useCallback(
    (val: number) => {
      const offset = parseFloat(String(val));
      currentSyncOffsetRef.current = offset;
      setCurrentSyncOffset(offset);
      if (octopusRef.current && typeof octopusRef.current.setTimeOffset === "function") {
        try {
          octopusRef.current.setTimeOffset(offset);
        } catch {}
      }
      if (artRef.current && artRef.current.subtitle) {
        artRef.current.subtitle.offset = offset;
      }
      if (artRef.current) {
        artRef.current.notice.show = `자막 싱크: ${offset > 0 ? "+" : ""}${offset.toFixed(1)} 초 (이 회차에 저장)`;
      }
      syncCuesToPipTrack(isNativePipActive());
      if (syncSaveTimerRef.current) clearTimeout(syncSaveTimerRef.current);
      const episodeToSave = currentEpRef.current;
      syncSaveTimerRef.current = setTimeout(() => {
        const currentSub = currentSubRef.current;
        fetch("/api/anime/reanime-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            animeId,
            ep: episodeToSave,
            syncOffset: offset,
            subtitleName: currentSub?.name || "",
            subtitleUrl: currentSub?.url || "",
          }),
        }).catch((err) => console.error("Failed to save episode subtitle sync:", err));
      }, 500);
    },
    [animeId, syncCuesToPipTrack, isNativePipActive]
  );

  // Restore subtitle sync independently for each episode.
  useEffect(() => {
    let cancelled = false;
    currentSyncOffsetRef.current = 0;
    setCurrentSyncOffset(0);
    fetch(`/api/anime/reanime-sync?animeId=${encodeURIComponent(animeId)}&ep=${currentEp}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !data.success || !data.setting) return;
        const offset = Number(data.setting.sync_offset) || 0;
        currentSyncOffsetRef.current = offset;
        setCurrentSyncOffset(offset);
        if (octopusRef.current?.setTimeOffset) octopusRef.current.setTimeOffset(offset);
        if (artRef.current?.subtitle) artRef.current.subtitle.offset = offset;
        syncCuesToPipTrack(isNativePipActive());
      })
      .catch((err) => console.error("Failed to load episode subtitle sync:", err));
    return () => {
      cancelled = true;
    };
  }, [animeId, currentEp, syncCuesToPipTrack, isNativePipActive]);

  // Refresh ArtPlayer's setting menu for Subtitle Selector
  const refreshSubtitleSettings = useCallback(
    (currentSubs: SubtitleItem[], activeIdx: number) => {
      if (!artRef.current || !artRef.current.setting) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subSelectorOptions: any[] = [];
      const seenKeys = new Set<string>();

      currentSubs.forEach((sub, idx) => {
        if (!sub || (!sub.url && !sub.content)) return;
        const key = sub.url || sub.name;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        const isSelected = idx === activeIdx;
        const icon = sub.is_ass ? "🟣 " : "⚪ ";
        subSelectorOptions.push({
          html: `${icon}${sub.name}`,
          subData: sub,
          default: isSelected,
        });
      });

      if (defaultVttUrl && !seenKeys.has(defaultVttUrl)) {
        const isDefaultSelected =
          activeIdx >= 0 && currentSubs[activeIdx]?.url === defaultVttUrl;
        subSelectorOptions.push({
          html: "⚪ 기본 내장",
          subData: { name: "기본 내장", format: "VTT", is_ass: false, url: defaultVttUrl },
          default: isDefaultSelected,
        });
      }

      subSelectorOptions.push({
        html: "🚫 자막 끄기",
        subData: { name: "자막 끄기", format: "VTT", is_ass: false, url: "" },
        default: activeIdx === -1,
      });

      const activeSub = activeIdx >= 0 ? currentSubs[activeIdx] : null;
      const tooltipText = activeSub ? activeSub.name : "자막 없음";

      try {
        artRef.current.setting.update({
          name: "subtitleSelector",
          width: 240,
          html: "자막 선택",
          tooltip: tooltipText,
          selector: subSelectorOptions,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onSelect: function (item: any) {
            if (item.subData.name === "자막 끄기" || (!item.subData.url && !item.subData.content)) {
              setNeedsManualSubtitleChoice(false);
              setSelectedSubIndex(-1);
              currentSubRef.current = null;
              currentAssContentRef.current = null;
              updateNativeTrackElement("");
              hideAllNativeVideoTracks();
              if (nativePipTextTrackRef.current) {
                nativePipTextTrackRef.current.mode = "hidden";
              }
              if (octopusRef.current) {
                try {
                  octopusRef.current.dispose();
                } catch {}
                octopusRef.current = null;
              }
              if (containerRef.current) {
                containerRef.current
                  .querySelectorAll(".libassjs-canvas-parent, canvas.libassjs-canvas")
                  .forEach((el) => el.remove());
              }
              if (artRef.current) {
                artRef.current.subtitle.show = false;
                // VTT 자막 영역의 인라인 display가 남아 자막이 꺼지지 않는 문제 방지
                if (artRef.current.template?.$subtitle) {
                  artRef.current.template.$subtitle.style.display = "none";
                }
                artRef.current.notice.show = "자막 꺼짐";
              }
            } else {
              setNeedsManualSubtitleChoice(false);
              const foundIndex = currentSubs.findIndex((s) => s.name === item.subData.name);
              setSelectedSubIndex(foundIndex !== -1 ? foundIndex : 0);
              applySubtitle(item.subData, currentSyncOffset);
            }
            return item.html;
          },
        });
      } catch (e) {
        console.warn("Failed to update subtitleSelector setting:", e);
      }
    },
    [defaultVttUrl, applySubtitle, updateNativeTrackElement, hideAllNativeVideoTracks]
  );

  useEffect(() => {
    refreshSubtitleSettingsRef.current = refreshSubtitleSettings;
  }, [refreshSubtitleSettings]);

  // Open a local subtitle or ZIP, store it on Pi, and apply the current episode's subtitle.
  const handleLocalSubFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isZip = file.name.toLowerCase().endsWith(".zip");
    setOpeningLocalSub(true);
    try {
      const form = new FormData();
      form.set("animeId", animeId);
      form.set("ep", String(currentEp));
      form.set("file", file);
      if (isZip) form.set("mode", "open");
      const response = await fetch("/api/anime/uploaded-subtitle", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "자막 파일을 Pi에 저장하지 못했습니다.");

      if (data.subtitle) {
        const localSub: SubtitleItem = data.subtitle;
        setSubs((prev) => {
          const nextSubs = [localSub, ...prev.filter((sub) => sub.name !== localSub.name)];
          setSelectedSubIndex(0);
          applySubtitle(localSub, currentSyncOffset);
          setTimeout(() => refreshSubtitleSettings(nextSubs, 0), 100);
          return nextSubs;
        });
      }
      if (artRef.current) {
        if (isZip) {
          const saved = Array.isArray(data.saved) ? data.saved : [];
          artRef.current.notice.show = data.subtitle
            ? `Pi에 ${saved.length}개 회차 저장 · ${currentEp}화 자막 적용 완료`
            : `Pi에 ${saved.length}개 회차 저장 · 현재 ${currentEp}화 자막은 ZIP에 없음`;
        } else {
          artRef.current.notice.show = `Pi에 저장하고 자막 적용 완료: ${file.name}`;
        }
      }
    } catch (err) {
      console.error("[Local subtitle load error]:", err);
      if (artRef.current) {
        artRef.current.notice.show = err instanceof Error ? err.message : "자막 파일을 읽는 데 실패했습니다.";
      }
    } finally {
      setOpeningLocalSub(false);
      if (e.target) e.target.value = "";
    }
  };

  const handleUploadSubFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingSub(true);
    try {
      const form = new FormData();
      form.set("animeId", animeId);
      form.set("ep", String(currentEp));
      form.set("file", file);
      const response = await fetch("/api/anime/uploaded-subtitle", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok || !data.subtitle) throw new Error(data.message || "업로드에 실패했습니다.");
      const uploaded: SubtitleItem = data.subtitle;
      setSubs((previous) => {
        const next = [uploaded, ...previous.filter((sub) => !sub.name.startsWith("Pi 저장:"))];
        setSelectedSubIndex(0);
        applySubtitle(uploaded, currentSyncOffset);
        setTimeout(() => refreshSubtitleSettings(next, 0), 100);
        return next;
      });
      if (artRef.current) artRef.current.notice.show = `Pi에 자막 저장 완료: ${file.name}`;
    } catch (error) {
      if (artRef.current) artRef.current.notice.show = error instanceof Error ? error.message : "자막 업로드에 실패했습니다.";
    } finally {
      setUploadingSub(false);
      e.target.value = "";
    }
  };

  const removeUploadedSub = async () => {
    const response = await fetch(`/api/anime/uploaded-subtitle?animeId=${encodeURIComponent(animeId)}&ep=${currentEp}`, { method: "DELETE" });
    if (!response.ok) {
      if (artRef.current) artRef.current.notice.show = "저장된 자막을 삭제하지 못했습니다.";
      return;
    }
    setSubs((previous) => previous.filter((sub) => !sub.name.startsWith("Pi 저장:")));
    setSelectedSubIndex(-1);
    if (artRef.current) artRef.current.notice.show = "Pi에 저장된 이 회차 자막을 삭제했습니다.";
  };

  // On-demand creator subtitle loader
  const handleLoadCreatorSub = async (creator: CreatorInfo) => {
    if (!creator.website || loadingCreatorName) return;

    const isErusha = creator.name.includes("에루샤") || (creator.website && creator.website.includes("erulabo.com"));
    if (isErusha) {
      if (artRef.current) {
        artRef.current.notice.show = "에루샤 님의 배포처는 Cloudflare 보안 캡차가 적용되어 있어 블로그에서 직접 다운로드해야 합니다.";
      }
      window.open(creator.website, "_blank");
      return;
    }

    const creatorKey = creatorIdentity(creator);
    setLoadingCreatorName(creatorKey);
    if (artRef.current) {
      artRef.current.notice.show = `${creator.name} 자막 다운로드 중...`;
    }

    try {
      const res = await fetch("/api/anime/subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorName: creator.name,
          website: creator.website,
          title: animeTitle,
          episodeNumber: currentEpRef.current,
        }),
      });
      const data = await res.json();
      if (data.success && data.subtitle) {
        const newSub: SubtitleItem = {
          name: `${data.subtitle.name} (${data.subtitle.format})`,
          format: data.subtitle.format,
          is_ass: data.subtitle.is_ass,
          content: data.subtitle.content,
          sourceCreatorWebsite: creator.website,
          sourceMatchedTitle: creator.matchedTitle,
        };

        const isAss = !!data.subtitle.is_ass;
        const currentSub = selectedSubIndex >= 0 ? subs[selectedSubIndex] : null;
        const isSameSub = currentSub && (
          currentSub.name.includes(creator.name) ||
          (creator.name.includes("카이란") && currentSub.name.includes("카이란")) ||
          currentSub.name === newSub.name
        );

        if (isAss) {
          // 🌟 ASS 자막인 경우: 즉시 화면 자막을 이 ASS 자막으로 교체 적용!
          setSubs((prev) => {
            const nextSubs = [newSub, ...prev.filter((s) => s.name !== newSub.name)];
            setSelectedSubIndex(0);
            applySubtitle(newSub, currentSyncOffset);
            setTimeout(() => refreshSubtitleSettings(nextSubs, 0), 100);
            return nextSubs;
          });

          if (artRef.current) {
            artRef.current.notice.show = `✅ ${creator.name} ASS 자막 등록 및 적용 완료!`;
Warning: truncated output (original token count: 26759)
Total output lines: 2386

          }
        } else {
          // 🌟 ASS가 아닌 일반 자막인 경우:
          if (isSameSub) {
            // 현재 자막과 동일한 경우: 교체하지 않고 목록에 보장 및 알림
            setSubs((prev) => {
              const existingIdx = prev.findIndex((s) => s.name === newSub.name);
              const nextSubs = existingIdx === -1 ? [...prev, newSub] : prev;
              setTimeout(() => refreshSubtitleSettings(nextSubs, selectedSubIndex), 100);
              return nextSubs;
            });
            if (artRef.current) {
              artRef.current.notice.show = "현재 적용 중인 자막과 동일한 자막입니다.";
            }
          } else {
            // 다른 일반 자막인 경우: 목록에 추가하되 현재 자막 유지 (자막 적용 버튼으로 선택 가능)
            setSubs((prev) => {
              const nextSubs = [newSub, ...prev.filter((s) => s.name !== newSub.name)];
              const currentName = currentSub ? currentSub.name : "";
              const newCurrentIdx = nextSubs.findIndex((s) => s.name === currentName);
              const keepIdx = newCurrentIdx !== -1 ? newCurrentIdx : Math.max(0, selectedSubIndex);
              setSelectedSubIndex(keepIdx);
              setTimeout(() => refreshSubtitleSettings(nextSubs, keepIdx), 100);
              return nextSubs;
            });
            if (artRef.current) {
              artRef.current.notice.show = `새 자막 등록: ${creator.name}`;
            }
          }
        }
      } else {
        if (artRef.current) {
          artRef.current.notice.show = data.message || "자막을 추출하지 못했습니다.";
        }
      }
    } catch (e) {
      console.error("[Load Creator Sub error]:", e);
      if (artRef.current) {
        artRef.current.notice.show = "자막 추출 중 오류가 발생했습니다.";
      }
    } finally {
      setLoadingCreatorName(null);
    }
  };

  const autoNextRef = useRef(autoNextEnabled);
  useEffect(() => {
    autoNextRef.current = autoNextEnabled;
  }, [autoNextEnabled]);

  // Helper to format seconds as mm:ss
  const formatTimeStr = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const remS = s % 60;
    return `${m}:${remS < 10 ? "0" : ""}${remS}`;
  };

  // Helper to extract OP/ED label summary (e.g., OP/ED, OP, ED)
  const getSkipLabelDesc = (intervals: SkipInterval[]) => {
    const hasOp = intervals.some((i) => i.type === "op" || (i.label && i.label.includes("오프닝")));
    const hasEd = intervals.some((i) => i.type === "ed" || (i.label && i.label.includes("엔딩")));
    if (hasOp && hasEd) return "OP/ED";
    if (hasOp) return "OP";
    if (hasEd) return "ED";
    return "";
  };

  const skipIntervalsRef = useRef<SkipInterval[]>(skipIntervals);
  useEffect(() => {
    skipIntervalsRef.current = skipIntervals;
  }, [skipIntervals]);

  // Apply timeline highlight markers / range bars to Artplayer progress bar
  const applyTimelineHighlight = useCallback((intervals: SkipInterval[]) => {
    skipIntervalsRef.current = intervals;
    if (!artRef.current) return;
    const art = artRef.current;

    const render = () => {
      if (!art || art.isDestroy) return false;
      const progressEl = art.template?.$progress;
      if (!progressEl) return false;
      const highlightContainer = progressEl.querySelector(".art-progress-highlight") as HTMLElement | null;
      if (!highlightContainer) return false;

      const currentIntervals = skipIntervalsRef.current;
      if (!currentIntervals || currentIntervals.length === 0) {
        highlightContainer.innerHTML = "";
        return true;
      }

      const duration = art.duration || art.template?.$video?.duration || 0;
      if (!duration || isNaN(duration) || duration <= 0) {
        return false;
      }

      highlightContainer.innerHTML = "";

      currentIntervals.forEach((item) => {
        const start = Math.max(0, item.start);
        const end = Math.min(duration, item.end);
        if (end <= start) return;

        const leftPercent = Math.max(0, Math.min(100, (start / duration) * 100));
        const widthPercent = Math.max(0.4, Math.min(100 - leftPercent, ((end - start) / duration) * 100));

        const span = document.createElement("span");
        const isEd = item.type === "ed" || (item.label && item.label.includes("엔딩"));
        span.className = `art-highlight-range ${isEd ? "art-highlight-ed" : "art-highlight-op"}`;
        span.dataset.text = `${item.label} (${formatTimeStr(start)} ~ ${formatTimeStr(end)})`;
        span.dataset.time = String(start);

        span.style.setProperty("left", `${leftPercent}%`, "important");
        span.style.setProperty("width", `${widthPercent}%`, "important");
        span.style.setProperty("position", "absolute", "important");
        span.style.setProperty("top", "0", "important");
        span.style.setProperty("bottom", "0", "important");
        span.style.setProperty("height", "100%", "important");
        span.style.setProperty("transform", "none", "important");
        span.style.setProperty("pointer-events", "auto", "important");
        span.style.setProperty("cursor", "pointer", "important");
        span.style.setProperty("display", "block", "important");

        highlightContainer.appendChild(span);
      });

      console.log(`[SkipHighlight] Successfully rendered ${currentIntervals.length} ranges (duration: ${duration.toFixed(1)}s)`);
      return true;
    };

    art.__renderHighlights = render;
    render();

    // Duration 및 Loadedmetadata 갱신 시 안전 재렌더링
    const scheduleRetry = () => {
      setTimeout(render, 50);
      setTimeout(render, 300);
      setTimeout(render, 1000);
    };

    art.on("video:loadedmetadata", scheduleRetry);
    art.on("video:durationchange", scheduleRetry);
    art.on("video:canplay", scheduleRetry);
    art.on("video:play", scheduleRetry);

    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (render() || attempts >= 25 || !artRef.current) {
        clearInterval(timer);
      }
    }, 300);
  }, []);

  // Initialize Player
  useEffect(() => {
    let isMounted = true;
    let cleanupDoubleTap: (() => void) | null = null;
    let cleanupUnload: (() => void) | null = null;

    async function init() {
      try {
        await Promise.all([
          loadScript("/js/hls.min.js"),
          loadScript("/js/artplayer.js"),
          loadScript("/libass/subtitles-octopus.js"),
        ]);

        if (!isMounted || !containerRef.current) return;

        if (artRef.current) {
          stopPlayerImmediately();
          try {
            artRef.current.destroy(true);
          } catch {}
          artRef.current = null;
        }

        const Artplayer = window.Artplayer;
        const Hls = window.Hls;

        const art = new Artplayer({
          container: containerRef.current,
          url: currentM3u8UrlRef.current || m3u8Url,
          type: "m3u8",
          customType: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            m3u8: function (video: HTMLVideoElement, url: string, artInstance: any) {
              if (Hls && Hls.isSupported()) {
                if (artInstance.hls) {
                  // 이미 Hls 인스턴스가 존재하면 destroy/detach하지 않고 소스만 교체
                  // (미디어 분리로 인한 비디오 초기화 및 전체화면 풀림 방지)
                  try {
                    artInstance.hls.stopLoad();
                    artInstance.hls.loadSource(url);
                    artInstance.hls.startLoad();
                    return;
                  } catch (e) {
                    console.warn("[HLS loadSource error, recreating]:", e);
                    try {
                      artInstance.hls.destroy();
                    } catch {}
                    artInstance.hls = null;
                  }
                }
                const hls = new Hls({
                  enableWorker: true,
                  lowLatencyMode: true,
                });

                // HLS 에러 복구: fatal 에러 시 무한 정지 대신 제한 재시도 + 사용자 알림
                let networkRetry = 0;
                let mediaRetry = 0;
                hls.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
                  if (!data || !data.fatal) return;
                  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    if (networkRetry < 2) {
                      networkRetry += 1;
                      artInstance.notice.show = "네트워크가 불안정합니다. 다시 시도합니다...";
                      hls.startLoad();
                    } else {
                      artInstance.notice.show = "영상 스트림을 불러오지 못했습니다. 네트워크를 확인 후 새로고침해 주세요.";
                    }
                  } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    if (mediaRetry < 2) {
                      mediaRetry += 1;
                      artInstance.notice.show = "재생 오류가 발생했습니다. 복구 중입니다...";
                      hls.recoverMediaError();
                    } else {
                      artInstance.notice.show = "재생 오류가 발생했습니다. 페이지를 새로고침해 주세요.";
                    }
                  } else {
                    artInstance.notice.show = "영상 스트림을 불러오지 못했습니다.";
                  }
                });
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                  networkRetry = 0;
                  mediaRetry = 0;
                });

                hls.loadSource(url);
                hls.attachMedia(video);
                artInstance.hls = hls;
              } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
                video.src = url;
              } else {
                artInstance.notice.show = "HLS 재생이 지원되지 않는 브라우저입니다.";
              }
            },
          },
          theme: "#a855f7",
          autoplay: true,
          autoSize: false,
          playbackRate: true,
          aspectRatio: true,
          setting: true,
          hotkey: playerSettings.hotkey,
          gesture: true,
          pip: false,
          fullscreen: playerSettings.fullscreenBtn,
          fullscreenWeb: playerSettings.fullscreenWebBtn,
          subtitleOffset: true,
          miniProgressBar: playerSettings.miniProgressBar,
          autoPlayback: false,
          playsInline: true,
          lang: "ko",
          i18n: {
            ko: {
              Play: "재생",
              Pause: "일시정지",
              Mute: "음소거",
              Volume: "음량",
              "Playback Rate": "재생 속도",
              "Aspect Ratio": "화면 비율",
              Subtitle: "자막",
              "Subtitle Offset": "자막 싱크",
              Setting: "설정",
              Pip: "PIP 모드",
              Fullscreen: "전체화면",
              "Web Fullscreen": "웹 전체화면",
              "Mini Player": "미니 플레이어",
              Screenshot: "화면 캡처",
              Normal: "기본(1.0x)",
              Default: "기본",
              Auto: "자동",
              Close: "닫기",
              "About ArtPlayer": "ArtPlayer 정보",
              "Video Info": "영상 정보",
            },
          },
          subtitle: {
            url: defaultVttUrl || "",
            type: "vtt",
            escape: false,
            style: {
              color: "#ffffff",
              fontSize: `${currentSubSize}px`,
              fontWeight: "700",
              background: "transparent",
              backgroundColor: "transparent",
              textShadow:
                "2px 2px 0px #000, -2px -2px 0px #000, 2px 2px 0px #000, -2px 2px 0px #000, 0px 2px 0px #000, 0px -2px 0px #000, 2px 0px 0px #000, -2px 0px 0px #000, 0 0 10px rgba(0, 0, 0, 0.95)",
            },
          },
          controls: [
            {
              name: "skip85s",
              position: "left",
              index: 35,
              html: '<button type="button" class="art-icon skip-85s-btn art-control-skip85s" title="오프닝 +85초 즉시 건너뛰기" style="display:inline-flex;align-items:center;justify-content:center;height:100%;padding:0 8px;margin-left:6px;font-size:11px;font-weight:700;color:#fff;background:none;border:none;cursor:pointer;border-radius:4px;transition:all 0.2s;"><span class="skip-85s-label" style="background:rgba(255,255,255,0.12);color:#ffffff;padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.25);font-size:11px;font-weight:800;line-height:1.2;transition:all 0.2s;">85s</span></button>',
              tooltip: "+85초 건너뛰기",
              click: function () {
                if (art && art.video) {
                  art.seek = Math.min(art.duration || 9999, art.currentTime + 85);
                  art.notice.show = "⏩ +85초 건너뛰기 완료";
                }
              },
            },
            {
              name: "speed2x",
              position: "right",
              index: 25,
              html: '<button type="button" class="art-icon speed-2x-btn art-control-speed2x" title="배속 순환 (1x ➔ 1.3x ➔ 1.5x ➔ 2x)" style="display:inline-flex;align-items:center;justify-content:center;height:100%;padding:0 6px;font-size:12px;font-weight:700;color:#fff;background:none;border:none;cursor:pointer;border-radius:4px;transition:all 0.2s;"><span class="speed-2x-label speed-rate-label" style="background:rgba(255,255,255,0.12);color:#ffffff;padding:2px 7px;border-radius:4px;border:1px solid rgba(255,255,255,0.25);font-size:12px;font-weight:700;line-height:1.2;transition:all 0.2s;">1x</span></button>',
              tooltip: "배속 조절 (1x ➔ 1.3x ➔ 1.5x ➔ 2x)",
              click: function () {
                const currentRate = (art && art.playbackRate) ? art.playbackRate : 1.0;
                let nextIdx = 0;
                const foundIdx = SPEED_CYCLE_RATES.findIndex((r) => Math.abs(r - currentRate) < 0.05);
                if (foundIdx !== -1) {
                  nextIdx = (foundIdx + 1) % SPEED_CYCLE_RATES.length;
                } else {
                  nextIdx = 1;
                }
                const newRate = SPEED_CYCLE_RATES[nextIdx];
                if (art) {
                  art.playbackRate = newRate;
                  art.notice.show = `재생 속도: ${newRate}x`;
                }
                // PIP 문서에서 동작하도록 플레이어 소유 문서를 전달
                updateSpeed2xButton(newRate, (art?.template?.$player as HTMLElement | undefined)?.ownerDocument);
              },
            },
            {
              name: "hybridPip",
              position: "right",
              index: 38,
              html: '<button type="button" class="art-icon hybrid-pip-btn art-control-hybrid-pip" title="화면 속 화면 (PIP)" style="display:inline-flex;align-items:center;justify-content:center;height:100%;padding:0 6px;color:#fff;background:none;border:none;cursor:pointer;border-radius:4px;transition:all 0.2s;"><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" style="vertical-align:middle;"><path d="M844.8 219.648h-665.6c-6.144 0-10.24 4.608-10.24 10.752v563.2c0 5.632 4.096 10.24 10.24 10.24h256v92.16h-256a102.4 102.4 0 0 1-102.4-102.4v-563.2c0-56.832 45.568-102.4 102.4-102.4h665.6a102.4 102.4 0 0 1 102.4 102.4v204.8h-92.16v-204.8c0-6.144-4.608-10.752-10.24-10.752zM614.4 588.8c-28.672 0-51.2 22.528-51.2 51.2v204.8c0 28.16 22.528 51.2 51.2 51.2h281.6c28.16 0 51.2-23.04 51.2-51.2v-204.8c0-28.672-23.04-51.2-51.2-51.2H614.4z"></path></svg></button>',
              tooltip: "화면 속 화면 (PIP)",
              click: function () {
                toggleHybridPip();
              },
            },
          ],
          settings: [
            {
              name: "subtitleSelector",
              width: 240,
              html: "자막 선택",
              tooltip: defaultVttUrl ? "기본 내장" : "자막 없음",
              selector: [
                ...(defaultVttUrl
                  ? [
                      {
                        html: "⚪ 기본 내장",
                        subData: { name: "기본 내장", format: "VTT", is_ass: false, url: defaultVttUrl },
                        default: true,
                      },
                    ]
                  : []),
                {
                  html: "🚫 자막 끄기",
                  subData: { name: "자막 끄기", format: "VTT", is_ass: false, url: "" },
                  default: !defaultVttUrl,
                },
              ],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onSelect: function (item: any) {
                if (item.subData.name === "자막 끄기" || (!item.subData.url && !item.subData.content)) {
                  setSelectedSubIndex(-1);
                  currentSubRef.current = null;
                  currentAssContentRef.current = null;
                  updateNativeTrackElement("");
                  hideAllNativeVideoTracks();
                  if (nativePipTextTrackRef.current) {
                    nativePipTextTrackRef.current.mode = "hidden";
                    if (nativePipTextTrackRef.current.cues) {
                      Array.from(nativePipTextTrackRef.current.cues).forEach((c) => {
                        try {
                          nativePipTextTrackRef.current?.removeCue(c);
                        } catch {}
                      });
                    }
                  }
                  if (octopusRef.current) {
                    try {
                      octopusRef.current.dispose();
                    } catch {}
                    octopusRef.current = null;
                  }
                  if (containerRef.current) {
                    containerRef.current
                      .querySelectorAll(".libassjs-canvas-parent, canvas.libassjs-canvas")
                      .forEach((el) => el.remove());
                  }
                  if (artRef.current) {
                    artRef.current.subtitle.show = false;
                    // VTT 자막 영역의 인라인 display가 남아 자막이 꺼지지 않는 문제 방지
                    if (artRef.current.template?.$subtitle) {
                      artRef.current.template.$subtitle.style.display = "none";
                    }
                    artRef.current.notice.show = "자막 꺼짐";
                  }
                } else {
                  applySubtitle(item.subData, currentSyncOffset);
                }
                return item.html;
              },
            },
            {
              name: "subtitleSync",
              width: 220,
              html: "자막 싱크",
              tooltip: "0.0 초",
              selector: [
                { html: "-1.0 초", value: -1.0 },
                { html: "-0.5 초", value: -0.5 },
                { html: "-0.2 초", value: -0.2 },
                { html: "0.0 초 (기본)", value: 0.0, default: true },
                { html: "+0.2 초", value: 0.2 },
                { html: "+0.5 초", value: 0.5 },
                { html: "+1.0 초", value: 1.0 },
              ],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onSelect: function (item: any) {
                setSubtitleSyncOffset(item.value);
                return item.html;
              },
            },
            {
              name: "subtitleSize",
              width: 230,
              html: "자막 크기",
              tooltip: `${currentSubSize}px`,
              selector: [
                { html: "아주 작게 (16px)", value: 16, default: currentSubSize === 16 },
                { html: "작게 (19px)", value: 19, default: currentSubSize === 19 },
                { html: "보통 (22px - 추천)", value: 22, default: currentSubSize === 22 },
                { html: "약간 크게 (25px)", value: 25, default: currentSubSize === 25 },
                { html: "크게 (28px)", value: 28, default: currentSubSize === 28 },
                { html: "아주 크게 (34px)", value: 34, default: currentSubSize === 34 },
                { html: "특대 (40px)", value: 40, default: currentSubSize === 40 },
              ],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onSelect: function (item: any) {
                setSubtitleFontSize(item.value);
                return item.html;
              },
            },
          ],
          highlight: [],
          layers: [
            {
              name: "doubleTapOverlay",
              html: `
                <div class="art-double-tap-overlay">
                  <div class="art-double-tap-ripple art-double-tap-left" id="dt-ripple-left">
                    <div class="art-double-tap-content">
                      <div class="art-double-tap-arrows">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M11 19V5l-8.5 7 8.5 7zm.5-7l8.5 7V5l-8.5 7z"/></svg>
                      </div>
                      <div class="art-double-tap-label" id="dt-label-left">-${playerSettings.doubleTouchDuration || 10}초</div>
                    </div>
                  </div>
                  <div class="art-double-tap-ripple art-double-tap-right" id="dt-ripple-right">
                    <div class="art-double-tap-content">
                      <div class="art-double-tap-arrows">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M4 19l8.5-7L4 5v14zm9-14v14l8.5-7L13 5z"/></svg>
                      </div>
                      <div class="art-double-tap-label" id="dt-label-right">+${playerSettings.doubleTouchDuration || 10}초</div>
                    </div>
                  </div>
                </div>
              `,
              style: {
                position: "absolute",
                top: "0",
                left: "0",
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                zIndex: "35",
              },
            },
            {
              name: "mobileCenterControls",
              html: `
                <div class="art-mobile-center-controls">
                  <button type="button" class="art-mobile-center-btn art-mobile-seek-backward" id="mobile-seek-backward" aria-label="뒤로 탐색">
                    <div class="art-mobile-seek-inner">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M11 19V5l-8.5 7 8.5 7zm.5-7l8.5 7V5l-8.5 7z"/>
                      </svg>
                      <span class="art-mobile-seek-sec" id="mobile-seek-sec-back">${playerSettings.doubleTouchDuration || 10}</span>
                    </div>
                  </button>
                  <button type="button" class="art-mobile-center-btn art-mobile-center-play" id="mobile-center-play" aria-label="재생 또는 일시정지">
                    <svg class="art-mobile-play-icon" id="mobile-icon-play" width="38" height="38" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                    <svg class="art-mobile-pause-icon" id="mobile-icon-pause" width="38" height="38" viewBox="0 0 24 24" fill="currentColor" style="display:none;">
                      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                    </svg>
                  </button>
                  <button type="button" class="art-mobile-center-btn art-mobile-seek-forward" id="mobile-seek-forward" aria-label="앞으로 탐색">
                    <div class="art-mobile-seek-inner">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M4 19l8.5-7L4 5v14zm9-14v14l8.5-7L13 5z"/>
                      </svg>
                      <span class="art-mobile-seek-sec" id="mobile-seek-sec-fwd">${playerSettings.doubleTouchDuration || 10}</span>
                    </div>
                  </button>
                </div>
              `,
              style: {
                position: "absolute",
                top: "0",
                left: "0",
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                zIndex: "36",
              },
            },
          ],
        });

        artRef.current = art;

        if (!isMounted) {
          try {
            if (art.hls) {
              art.hls.stopLoad?.();
              art.hls.detachMedia?.();
              art.hls.destroy?.();
            }
            if (art.video) {
              art.video.pause();
              art.video.removeAttribute("src");
              art.video.load();
            }
            art.destroy(true);
          } catch {}
          artRef.current = null;
          return;
        }

        // 🌟 미니 진행바(컨트롤 자동 숨김 = art-mini-progress-bar) 터치 오조작 차단:
        // 컨트롤이 내려간 상태에서는 미니 진행바에 닿는 touchstart/touchmove를 포캐스 단계에서 stopPropagation하여
        // ArtPlayer 내부 시크 핸들러 자체를 실행 불능으로 만든다(제스처 탐색 금지, 이동 불가).
        // 컨트롤바가 완전히 올라온 상태(클래스 제거)에서만 기존과 동일하게 화면 탐색이 허용된다.
        if (art && art.template && art.template.$bottom && art.template.$player) {
            const $miniBottomEl = art.template.$bottom;
            const blockMiniProgressBarTouch = function (evt: TouchEvent) {
                if (art.template.$player.classList.contains("art-mini-progress-bar")) {
                    evt.stopPropagation();
                }
            };
            art.events.proxy($miniBottomEl, "touchstart", blockMiniProgressBarTouch, { capture: true });
            art.events.proxy($miniBottomEl, "touchmove", blockMiniProgressBarTouch, { capture: true });
        }

        // 🌟 모바일 화면 꾹 누르고 스와이프 탐색 (mobileGesture) 온/오프 제어:
        // mobileGesture가 false일 때, 영상 화면 영역에서의 touchmove를 캡처 단계에서 stopPropagation하여
        // Artplayer 내부의 제스처 시크 핸들러(좌우 스와이프 탐색)로 이벤트가 전파되는 것을 원천 차단한다.
        // 하단 진행바 및 컨트롤 UI는 제외하여 일반적인 버튼 조작 및 진행바 탐색은 정상 유지된다.
        if (art && art.template && art.template.$player) {
          const blockScreenGestureTouchMove = function (evt: TouchEvent) {
            if (playerSettingsRef.current.mobileGesture) return;
            const target = evt.target as HTMLElement | null;
            if (
              target &&
              target.closest(
                ".art-bottom, .art-controls, .art-progress, .art-settings, .art-contextmenus, button, input, a, .player-settings-modal-root"
              )
            ) {
              return;
            }
            evt.stopPropagation();
          };
          art.events.proxy(art.template.$player, "touchmove", blockScreenGestureTouchMove, { capture: true });
        }

        // 데스크톱 더블클릭 및 모바일 클릭/더블클릭 오작동 방지 플래그
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((window as any).Artplayer) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).Artp…12759 tokens truncated…     }
                    if (skipSource === "db") {
                      return `스킵 감지${descSuffix} · DB`;
                    }
                    return descSuffix ? `스킵 감지${descSuffix}` : audioAnalysisText;
                  })()}
                </span>
              </div>

              {/* AniSkip 데이터인 경우 싱크 불일치 대비 수동 재분석 버튼 */}
              {skipSource === "aniskip" && (
                <button
                  type="button"
                  onClick={() => triggerManualAudioSkip(false)}
                  title="AniSkip 타임스탬프가 맞지 않을 경우 오디오를 직접 AI 분석하여 재검출합니다"
                  className="inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs font-semibold border border-purple-500/30 bg-slate-800/90 text-purple-300 hover:bg-purple-900/40 hover:text-white transition cursor-pointer"
                >
                  <RotateCw className="h-3 w-3 text-purple-400" />
                  <span>AI 재분석</span>
                </button>
              )}
            </div>
          ) : (
            /* 2-3) 스킵 데이터 없음 (idle 또는 none): 수동 오디오 분석 버튼 */
            <button
              type="button"
              id="manualAudioSkipBtn"
              onClick={() => triggerManualAudioSkip(false)}
              title="영상 오디오를 직접 AI 분석하여 오프닝/엔딩 구간을 감지합니다"
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-bold transition border border-purple-500/40 bg-purple-500/10 text-purple-300 hover:bg-purple-600/20 cursor-pointer"
            >
              <Sparkles className="h-3.5 w-3.5 text-purple-400" />
              <span>{audioAnalysisText}</span>
            </button>
          )}

          {/* 3) 다음 화 자동재생 토글 */}
          <label
            htmlFor="autoNextToggle"
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-semibold transition border cursor-pointer select-none ${
              autoNextEnabled
                ? "bg-indigo-600/20 text-indigo-200 border-indigo-500/50 shadow-sm"
                : "bg-slate-800/80 text-slate-400 border-slate-700"
            }`}
          >
            <input
              type="checkbox"
              id="autoNextToggle"
              checked={autoNextEnabled}
              onChange={toggleAutoNext}
              className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-indigo-600 accent-indigo-600 cursor-pointer"
            />
            <span>다음 화 자동재생</span>
          </label>

          {/* 4) ⚙️ 플레이어 환경설정 버튼 */}
          <button
            type="button"
            onClick={() => setIsSettingsModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-purple-500/40 bg-purple-600/20 px-3 py-1.5 font-bold text-purple-200 transition hover:bg-purple-600 hover:text-white cursor-pointer shadow-sm"
            title="플레이어 환경설정 (세부 기능 ON/OFF)"
          >
            <Settings className="h-3.5 w-3.5 text-purple-400" />
            <span>설정</span>
          </button>
        </div>
      </div>

      {/* Episode Navigator Toolbar (Flask-style in-player ep selector) */}
      {currentEpisodes.length > 0 && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-[#10182c]/80 p-4 backdrop-blur-md shadow-lg">
          {/* Header Row: Sub/Dub Switch & Ep Quick Jump */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/10">
            <div className="flex items-center gap-3">
              {/* 자막 / 더빙 세그먼트 전환 스위치 (더빙판 제공 시) */}
              {dubEpisodes && dubEpisodes.length > 0 && (
                <div className="inline-flex items-center rounded-full bg-slate-950/80 p-1 border border-white/10 text-xs">
                  {(() => {
                    const targetSubEp = subEpisodes?.some((e) => e.number === currentEp)
                      ? currentEp
                      : subEpisodes?.[0]?.number || 1;
                    const targetDubEp = dubEpisodes.some((e) => e.number === currentEp)
                      ? currentEp
                      : dubEpisodes[0]?.number || 1;
                    return (
                      <>
                        <Link
                          href={`/watch/${animeId}/${targetSubEp}`}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold transition ${
                            !isDub
                              ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-sm"
                              : "text-slate-400 hover:text-slate-200"
                          }`}
                        >
                          <Film className="h-3.5 w-3.5" />
                          자막판 ({subEpisodes?.length || 0})
                        </Link>
                        <Link
                          href={`/watch/${animeId}/${targetDubEp}?dub=1`}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold transition ${
                            isDub
                              ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-sm"
                              : "text-slate-400 hover:text-slate-200"
                          }`}
                        >
                          <Mic className="h-3.5 w-3.5" />
                          더빙판 ({dubEpisodes.length})
                        </Link>
                      </>
                    );
                  })()}
                </div>
              )}

              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-400 font-medium">
                <List className="h-3.5 w-3.5 text-purple-400" />
                회차 선택
              </span>
            </div>

            {/* 빠른 회차 점프 입력창 */}
            <form onSubmit={handleJump} className="relative flex items-center gap-1">
              <div className="relative">
                <input
                  type="number"
                  min="1"
                  value={jumpInput}
                  onChange={(e) => setJumpInput(e.target.value)}
                  placeholder="회차 이동"
                  className="w-24 sm:w-28 rounded-xl bg-slate-950/90 px-2.5 py-1 text-xs text-white placeholder-slate-500 border border-white/10 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded-xl bg-purple-600 px-2.5 py-1 text-xs font-semibold text-white shadow hover:bg-purple-500 transition"
              >
                <Search className="h-3 w-3" /> 이동
              </button>
              {jumpError && (
                <span className="absolute right-0 top-8 whitespace-nowrap rounded-lg bg-red-950/90 px-2.5 py-1 text-[11px] font-semibold text-red-300 border border-red-500/40 z-20 shadow-lg">
                  {jumpError}
                </span>
              )}
            </form>
          </div>

          {/* 50화 단위 구간 선택 탭 (50화 초과 시 자동 표시) */}
          {chunkCount > 1 && (
            <div className="flex gap-2 overflow-x-auto py-2.5 scrollbar-thin scrollbar-thumb-purple-500/30">
              {Array.from({ length: chunkCount }).map((_, idx) => {
                const startNum = idx * CHUNK_SIZE + 1;
                const endNum = Math.min((idx + 1) * CHUNK_SIZE, currentEpisodes.length);
                const isActive = selectedChunk === idx;
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setSelectedChunk(idx)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition ${
                      isActive
                        ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md shadow-purple-500/30 font-bold"
                        : "bg-white/5 border border-white/10 text-slate-400 hover:bg-purple-600/20 hover:text-white"
                    }`}
                  >
                    <span>{startNum} - {endNum}화</span>
                    {currentEpisodes.slice(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE).some((e) => {
                      const h = epHistoryMap[e.number];
                      return h && (h.is_completed || h.watch_time > 10);
                    }) && (
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* 회차 알약 가로 스크롤 (ep-pill) with 시청 진행도/완주 표시 */}
          <div
            ref={scrollContainerRef}
            className="mt-2 flex gap-2 overflow-x-auto py-1.5 scrollbar-thin scrollbar-thumb-purple-500/30"
          >
            {displayedEpisodes.map((ep) => {
              const isActive = ep.number === currentEp;
              const watched = epHistoryMap[ep.number];
              let pct = 0;
              let isCompleted = false;

              if (watched) {
                if (watched.is_completed) {
                  isCompleted = true;
                  pct = 100;
                } else if (watched.duration > 0) {
                  pct = Math.min(100, Math.round((watched.watch_time / watched.duration) * 100));
                  if (pct >= 85 || (watched.duration - watched.watch_time < 90 && watched.watch_time > 120)) {
                    isCompleted = true;
                    pct = 100;
                  }
                } else if (watched.watch_time > 10) {
                  pct = 50;
                }
              }

              const hasProgress = watched && (isCompleted || pct > 0);

              return (
                <button
                  type="button"
                  key={ep.number}
                  ref={isActive ? activePillRef : null}
                  disabled={Boolean(isSwitchingEp)}
                  onClick={() => switchEpisode(ep.number)}
                  className={`group relative flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition overflow-hidden ${
                    isSwitchingEp === ep.number
                      ? "bg-purple-900/60 border border-purple-400 text-purple-200 pointer-events-none cursor-wait ring-1 ring-purple-400"
                      : isSwitchingEp
                      ? "opacity-50 pointer-events-none"
                      : isActive
                      ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md shadow-purple-500/30 ring-1 ring-purple-400 scale-105 font-bold cursor-pointer"
                      : isCompleted
                      ? "bg-emerald-950/40 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-900/50 hover:border-emerald-400 cursor-pointer"
                      : hasProgress
                      ? "bg-purple-950/40 border border-purple-500/30 text-purple-200 hover:bg-purple-900/50 cursor-pointer"
                      : "bg-white/5 border border-white/10 text-slate-300 hover:bg-white/15 hover:text-white cursor-pointer"
                  }`}
                >
                  {isSwitchingEp === ep.number ? (
                    <Loader2 className="h-3 w-3 animate-spin text-purple-300 shrink-0" />
                  ) : null}
                  <span>{ep.title}</span>

                  {/* 회차 진행도 뱃지/아이콘 */}
                  {isSwitchingEp === ep.number ? null : isActive ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-white animate-ping" />
                  ) : isCompleted ? (
                    <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
                  ) : pct > 0 ? (
                    <span className="rounded bg-purple-500/30 px-1 py-0.5 text-[9px] font-bold text-purple-200 border border-purple-400/30">
                      {pct}%
                    </span>
                  ) : null}

                  {/* 하단 미니 진행도 프로그레스 바 */}
                  {!isActive && hasProgress && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-slate-950/80">
                      <div
                        className={`h-full ${
                          isCompleted ? "bg-emerald-400" : "bg-purple-400"
                        }`}
                        style={{ width: `${isCompleted ? 100 : Math.max(8, pct)}%` }}
                      />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Subtitles Selection Bar */}
      <div className="mt-4 rounded-2xl border border-purple-500/20 bg-slate-900/60 p-4 backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-purple-500/10">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <MessageSquare className="h-4 w-4 text-purple-400" />
            <span>선택 가능한 자막 목록</span>
            {isLoadingSubs && (
              <span className="text-xs font-normal text-purple-300 animate-pulse">
                (외부 자막 실시간 검색 중...)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 mr-1">총 {subs.length}개 발견</span>
            <input type="file" ref={uploadFileInputRef} accept=".ass,.ssa,.smi,.srt,.vtt,.zip"
              onChange={handleUploadSubFile} className="hidden" />
            <button type="button" disabled={uploadingSub} onClick={() => uploadFileInputRef.current?.click()}
              className="rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-300 hover:bg-sky-600 hover:text-white disabled:opacity-50"
              title="받은 자막 파일을 Pi에 업로드하고 이 회차에 저장">
              {uploadingSub ? "Pi에 저장 중..." : "Pi에 자막 저장"}
            </button>
            {subs.some((sub) => sub.name.startsWith("Pi 저장:")) && (
              <button type="button" onClick={removeUploadedSub} className="text-xs text-rose-300 hover:text-rose-200">저장 삭제</button>
            )}
            {playerSettings.localSubBtn && (
              <>
                <input
                  type="file"
                  ref={localFileInputRef}
                  accept=".ass,.ssa,.smi,.srt,.vtt,.zip"
                  onChange={handleLocalSubFile}
                  className="hidden"
                  disabled={openingLocalSub}
                />
                <button
                  type="button"
                  disabled={openingLocalSub}
                  onClick={() => localFileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-purple-500/40 bg-purple-500/10 px-3 py-1.5 text-xs font-bold text-purple-300 transition hover:bg-purple-600 hover:text-white cursor-pointer disabled:opacity-50"
                  title="자막 파일 또는 ZIP을 Pi에 저장하고 회차별로 열기"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>{openingLocalSub ? "Pi에 분류·저장 중..." : "자막 파일 열기"}</span>
                </button>
              </>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {subs.map((sub, idx) => (
            <button
              key={idx}
              onClick={() => {
                setNeedsManualSubtitleChoice(false);
                setSelectedSubIndex(idx);
                applySubtitle(sub, currentSyncOffset);
                refreshSubtitleSettings(subs, idx);
              }}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                selectedSubIndex === idx
                  ? "bg-purple-600 text-white shadow-md shadow-purple-600/30 ring-2 ring-purple-400"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              <span>{sub.name}</span>
              {sub.is_ass && (
                <span className="rounded bg-purple-950 px-1 py-0.5 text-[10px] font-bold text-purple-300 border border-purple-400/40">
                  ASS 효과
                </span>
              )}
            </button>
          ))}

          {subs.length === 0 && !isLoadingSubs && (
            <span className="text-xs text-slate-500 py-1">자막이 제공되지 않는 회차입니다.</span>
          )}
        </div>
        {needsManualSubtitleChoice && (
          <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            가장 높은 매칭 후보에서 자막을 불러오지 못했어요. 다른 후보는 자동 적용하지 않았으니, 아래 목록에서 직접 골라 주세요.
          </div>
        )}
      </div>

      {/* Anissia Subtitle Creators Status */}
      {playerSettings.anissiaCard && (creators.length > 0 || isLoadingSubs) && (
        <div className="mt-4 rounded-2xl border border-purple-500/20 bg-slate-900/60 p-4 backdrop-blur-md">
          <div className="flex items-center justify-between pb-3 border-b border-purple-500/10">
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <Users className="h-4 w-4 text-purple-400" />
              <span>애니시아 등록 제작자 현황</span>
              {isLoadingSubs && (
                <span className="text-xs font-normal text-purple-300 animate-pulse">
                  (조회 중...)
                </span>
              )}
            </div>
            <span className="text-xs text-slate-400">제작자 {creators.length}명</span>
          </div>

          <div className="mt-3 space-y-2">
            {creators.map((c, idx) => {
              const matchedSub = subs.find((s) =>
                s.sourceCreatorWebsite === c.website && s.sourceMatchedTitle === c.matchedTitle
              );
              const isCurrentlyActive =
                selectedSubIndex >= 0 &&
                subs[selectedSubIndex] &&
                matchedSub && subs[selectedSubIndex].name === matchedSub.name;
              const isAss =
                (matchedSub && matchedSub.is_ass) ||
                c.name.includes("카이란") ||
                c.name.includes("슈퍼소닉");
              const isErusha = Boolean(
                c.name.includes("에루샤") || (c.website && c.website.includes("erulabo.com"))
              );
              const isLoading = loadingCreatorName === creatorIdentity(c);

              return (
                <div
                  key={idx}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 transition ${
                    isErusha
                      ? "border-amber-500/30 bg-amber-500/5 hover:border-amber-500/50"
                      : "border-white/5 bg-slate-950/60 hover:border-purple-500/30"
                  }`}
                >
                  <div className="flex flex-col gap-0.5 max-w-full sm:max-w-[65%]">
                    <div className="flex items-center gap-1.5">
                      {isAss ? (
                        <Wand2 className="h-3.5 w-3.5 text-purple-400 shrink-0" />
                      ) : isErusha ? (
                        <AlertCircle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      ) : (
                        <UserPen className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                      )}
                      <span className="font-bold text-sm text-white">{c.name}</span>
                      {isAss && (
                        <span className="rounded bg-purple-950/80 px-1.5 py-0.5 text-[10px] font-bold text-purple-300 border border-purple-500/40">
                          ASS
                        </span>
                      )}
                      {isErusha && (
                        <span className="rounded bg-amber-950/80 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/40">
                          보안 캡차
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      {isErusha ? (
                        <span className="text-amber-400/90 flex items-center gap-1 font-medium">
                          <AlertCircle className="h-3 w-3 shrink-0" />
                          Cloudflare 보안 캡차 보호 사이트 (자동 추출 불가 · 직접 방문 다운로드 필요)
                        </span>
                      ) : matchedSub ? (
                        <span className="text-emerald-400 flex items-center gap-1 font-medium">
                          <CheckCircle2 className="h-3 w-3" />
                          현재 {currentEp}화 자막 매칭 완료
                        </span>
                      ) : c.is_current_ep ? (
                        <span className="text-purple-300 flex items-center gap-1 font-medium">
                          <CheckCircle2 className="h-3 w-3 text-purple-400" />
                          현재 {currentEp}화 자막 제공
                        </span>
                      ) : (
                        <span>
                          블로그 등록 회차: {c.episode || "-"}화 {c.update_date ? `(${c.update_date})` : ""}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {matchedSub ? (
                      isCurrentlyActive ? (
                        matchedSub.is_ass ? (
                          <button
                            disabled
                            type="button"
                            className="inline-flex items-center gap-1 rounded-xl bg-emerald-600/20 border border-emerald-500/50 px-3 py-1.5 text-xs font-bold text-emerald-300 cursor-default"
                            title="현재 화면에 적용 중인 ASS 자막입니다"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>적용 중</span>
                          </button>
                        ) : (
                          <button
                            disabled
                            type="button"
                            className="inline-flex items-center gap-1 rounded-xl bg-slate-800/90 border border-slate-700 px-3 py-1.5 text-xs font-bold text-slate-300 cursor-default"
                            title="현재 화면에 적용 중인 자막과 동일합니다"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 text-slate-400" />
                            <span>동일 자막</span>
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            const foundIdx = subs.findIndex((s) => s.name === matchedSub.name);
                            if (foundIdx !== -1) {
                              setNeedsManualSubtitleChoice(false);
                              setSelectedSubIndex(foundIdx);
                              applySubtitle(matchedSub, currentSyncOffset);
                              refreshSubtitleSettings(subs, foundIdx);
                            }
                          }}
                          className="inline-flex items-center gap-1 rounded-xl border border-purple-500/40 bg-slate-800 px-3 py-1.5 text-xs font-bold text-purple-200 transition hover:bg-purple-600 hover:text-white cursor-pointer"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>자막 적용</span>
                        </button>
                      )
                    ) : isErusha ? (
                      c.website && (
                        <a
                          href={c.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/50 bg-amber-600/20 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-600 hover:text-white transition shadow-sm"
                          title="Cloudflare 캡차가 적용되어 있어 블로그에서 직접 다운로드해야 합니다"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          <span>블로그에서 직접 받기</span>
                        </a>
                      )
                    ) : (
                      c.website && (
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => handleLoadCreatorSub(c)}
                          className={`inline-flex items-center gap-1 rounded-xl border border-purple-500/50 px-3 py-1.5 text-xs font-bold transition ${
                            isLoading
                              ? "bg-slate-800 text-slate-400 cursor-wait"
                              : "bg-purple-600/20 text-purple-200 hover:bg-purple-600 hover:text-white cursor-pointer"
                          }`}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" />
                              <span>추출 중...</span>
                            </>
                          ) : (
                            <>
                              <Download className="h-3.5 w-3.5" />
                              <span>자막 등록</span>
                            </>
                          )}
                        </button>
                      )
                    )}

                    {!isErusha && c.website && (
                      <a
                        href={c.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center h-7 w-7 rounded-xl border border-white/10 bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition"
                        title="제작자 블로그 방문"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}

            {creators.length === 0 && !isLoadingSubs && (
              <div className="text-slate-500 text-xs py-2 px-1">
                등록된 제작자 정보가 없습니다.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Player Settings Modal */}
      <PlayerSettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={playerSettings}
        onUpdateSettings={handleUpdateSettings}
      />
    </div>
  );
}
