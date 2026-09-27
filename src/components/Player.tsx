Warning: truncated output (original token count: 45928)
Total output lines: 4386

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
      artRef.current.notice.show = `다음 화 자동재생: ${nextVal ? "활성화(ON)" : "비활성화(OFF)"}`;
    }
  };

  // Script Loader Helper
  const loadScript = (src: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  };

  // ==========================================
  // 🌟 하이브리드 PIP (Document PiP + 브라우저 네이티브 TextTrack 연동)
  // ==========================================

  // 절대 URL 변환 헬퍼 (iOS 네이티브 및 ArtPlayer 공용)
  const toAbsoluteUrl = useCallback((url: string) => {
    if (!url) return "";
    if (
      url.startsWith("http://") ||
      url.startsWith("https://") ||
      url.startsWith("blob:") ||
      url.startsWith("data:")
    ) {
      return url;
    }
    if (typeof window !== "undefined") {
      return window.location.origin + (url.startsWith("/") ? "" : "/") + url;
    }
    return url;
  }, []);

  // 1. ASS 자막 Dialogue 라인 파싱
  const parseAssDialogues = useCallback((assText: string) => {
    if (!assText) return [];
    const cues: Array<{ start: number; end: number; text: string }> = [];
    const pattern =
      /^Dialogue:\s*[^,]+,(\d+:\d{2}:\d{2}(?:\.\d+)?),(\d+:\d{2}:\d{2}(?:\.\d+)?),([^,]*),([^,]*),(?:[^,]*,){4}(.*)$/gim;

    const toSeconds = (tStr: string) => {
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
      const startSec = toSeconds(match[1]);
      const endSec = toSeconds(match[2]);
      const rawText = match[5];
      const cleanText = rawText
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\N/gi, "\n")
        .replace(/\\n/gi, "\n")
        .trim();
      if (cleanText && endSec > startSec) {
        cues.push({ start: startSec, end: endSec, text: cleanText });
      }
    }
    return cues;
  }, []);

  // 2. WebVTT 텍스트 파싱 (라인 기반 신뢰성 100% 파서)
  const parseVttToCues = useCallback((vttText: string) => {
    if (!vttText) return [];
    const cues: Array<{ start: number; end: number; text: string }> = [];
    const lines = vttText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    let currentStart: number | null = null;
    let currentEnd: number | null = null;
    let currentTexts: string[] = [];

    const toSeconds = (tStr: string) => {
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

    const timeArrowPattern = /((?:\d{1,2}:)?\d{2}:\d{2}[\.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[\.,]\d{1,3})/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const timeMatch = timeArrowPattern.exec(line);
      if (timeMatch) {
        if (currentStart !== null && currentEnd !== null && currentTexts.length > 0) {
          const text = currentTexts.join("\n").trim();
          if (text && currentEnd > currentStart) {
            cues.push({ start: currentStart, end: currentEnd, text });
          }
        }
        currentStart = toSeconds(timeMatch[1]);
        currentEnd = toSeconds(timeMatch[2]);
        currentTexts = [];
      } else if (currentStart !== null && currentEnd !== null) {
        if (line === "") {
          if (currentTexts.length > 0) {
            const text = currentTexts.join("\n").trim();
            if (text && currentEnd > currentStart) {
              cues.push({ start: currentStart, end: currentEnd, text });
            }
            currentStart = null;
            currentEnd = null;
            currentTexts = [];
          }
        } else if (/^\d+$/.test(line) && currentTexts.length === 0) {
          continue;
        } else {
          const clean = line
            .replace(/\{[^}]*\}/g, "")
            .replace(/<(?!\/?(font|b|i|u|span)\b)[^>]*>/gi, "")
            .trim();
          if (clean) currentTexts.push(clean);
        }
      }
    }
    if (currentStart !== null && currentEnd !== null && currentTexts.length > 0) {
      const text = currentTexts.join("\n").trim();
      if (text && currentEnd > currentStart) {
        cues.push({ start: currentStart, end: currentEnd, text });
      }
    }
    return cues;
  }, []);

  // 3. WebVTT 포맷 문자열 빌더
  const buildVttFromCues = useCallback((cues: Array<{ start: number; end: number; text: string }>, offset = 0) => {
    let vtt = "WEBVTT\n\n";
    const formatVttTime = (sec: number) => {
      const s = Math.max(0, sec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const rem = s % 60;
      let wholeSec = Math.floor(rem);
      let ms = Math.floor(Math.round((rem - wholeSec) * 1000));
      if (ms >= 1000) {
        wholeSec += 1;
        ms -= 1000;
      }
      const safeMs = Math.min(ms, 999);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(wholeSec).padStart(2, "0")}.${String(safeMs).padStart(3, "0")}`;
    };

    cues.forEach((c, idx) => {
      const start = c.start + offset;
      const end = c.end + offset;
      if (end > start && start >= 0) {
        vtt += `${idx + 1}\n${formatVttTime(start)} --> ${formatVttTime(end)}\n${c.text}\n\n`;
      }
    });
    return vtt;
  }, []);

  // 4. 네이티브 PiP 활성 여부 확인
  const isNativePipActive = useCallback(() => {
    const art = artRef.current;
    return Boolean(
      (document.pictureInPictureElement && document.pictureInPictureElement === art?.video) ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (art?.video && (art.video as any).webkitPresentationMode === "picture-in-picture")
    );
  }, []);

  // 5. 자막 객체로부터 실제 서버 HTTP WebVTT URL 생성 (Safari AVPlayer 연동용)
  const getHttpVttUrlForSubtitle = useCallback(
    (subData: SubtitleItem | null, offset = 0) => {
      if (!subData || (!subData.url && !subData.content) || subData.name === "자막 끄기") {
        return "";
      }
      const offsetVal = parseFloat(String(offset)) || 0;
      const rawUrl = subData.url;

      if (rawUrl && !rawUrl.startsWith("blob:") && !rawUrl.startsWith("data:")) {
        if (rawUrl.startsWith("/api/anime/stream/vtt")) {
          const sep = rawUrl.includes("?") ? "&" : "?";
          return `${rawUrl}${sep}offset=${offsetVal}&_t=${Date.now()}`;
        }
        if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
          return `/api/anime/stream/vtt?url=${encodeURIComponent(rawUrl)}&offset=${offsetVal}&_t=${Date.now()}`;
        }
        const sep = rawUrl.includes("?") ? "&" : "?";
        return `${rawUrl}${sep}offset=${offsetVal}&_t=${Date.now()}`;
      }

      // ASS 또는 인메모리 자막인 경우: 실시간 WebVTT 변환 엔드포인트 HTTP URL 반환
      // currentEpRef.current를 사용하여 useCallback deps에서 currentEp를 제거
      // → syncCuesToPipTrack → applySubtitle → ArtPlayer init effect 연쇄 재생성 방지 (전체화면 유지)
      const ep = currentEpRef.current;
      if (animeTitle && ep) {
        return `/api/anime/subtitles/vtt?title=${encodeURIComponent(animeTitle)}&ep=${ep}&name=${encodeURIComponent(subData.name)}&offset=${of…27928 tokens truncated…</Link>
          <span className="text-slate-600">/</span>
          <span className="font-extrabold text-purple-300">
            {currentEpTitle} {isDub && "(더빙)"}
          </span>
        </div>
      </div>

      {/* Player Wrapper */}
      <div className="artplayer-wrapper rounded-2xl relative">
        <div ref={containerRef} className="w-full h-full" />

        {/* Floating AniSkip / Manual Skip Button */}
        {floatingSkip.show && playerSettings.floatingSkipBtn && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (artRef.current) {
                artRef.current.seek = Math.min(
                  artRef.current.duration || 99999,
                  floatingSkip.targetTime
                );
                artRef.current.notice.show = `⏩ ${floatingSkip.label} 완료!`;
              }
              setFloatingSkip({ show: false, label: "", targetTime: 0 });
            }}
            className="absolute bottom-16 right-5 z-30 flex items-center gap-2 rounded-full bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-600 px-4 py-2.5 text-xs sm:text-sm font-extrabold text-white shadow-2xl shadow-purple-900/60 border border-purple-300/40 backdrop-blur-md animate-pulse transition hover:scale-105 active:scale-95 cursor-pointer"
          >
            <Sparkles className="h-4 w-4 fill-white" />
            <span>{floatingSkip.label}</span>
          </button>
        )}
      </div>

      {/* Episode Navigation & Controls */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-purple-500/20 bg-slate-900/80 p-4 backdrop-blur-md">
        {/* Navigation Buttons */}
        <div className="flex items-center gap-2">
          {currentPreEp ? (
            <button
              type="button"
              disabled={Boolean(isSwitchingEp)}
              onClick={() => switchEpisode(currentPreEp)}
              className={`flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold transition ${
                isSwitchingEp === currentPreEp
                  ? "bg-purple-900/50 text-purple-200 border border-purple-500/50 pointer-events-none cursor-wait"
                  : "bg-slate-800 text-slate-200 hover:bg-purple-600 hover:text-white cursor-pointer"
              } ${isSwitchingEp && isSwitchingEp !== currentPreEp ? "opacity-60 pointer-events-none" : ""}`}
            >
              {isSwitchingEp === currentPreEp ? (
                <Loader2 className="h-4 w-4 animate-spin text-purple-300" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
              {isSwitchingEp === currentPreEp ? `로딩 중... (${currentPreEp}화)` : `이전 화 (${currentPreEp}화)`}
            </button>
          ) : (
            <span className="rounded-xl bg-slate-950 px-3 py-2 text-xs text-slate-600 cursor-not-allowed">
              첫 번째 화
            </span>
          )}

          <Link
            href={`/anime/${animeId}`}
            onClick={() => setNavigatingTarget("list")}
            className={`flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold transition ${
              navigatingTarget === "list"
                ? "bg-purple-900/50 text-purple-200 border border-purple-500/50 pointer-events-none cursor-wait"
                : "bg-slate-800 text-slate-200 hover:bg-slate-700"
            }`}
          >
            {navigatingTarget === "list" ? (
              <Loader2 className="h-4 w-4 animate-spin text-purple-300" />
            ) : (
              <List className="h-4 w-4" />
            )}
            {navigatingTarget === "list" ? "이동 중..." : "회차 목록"}
          </Link>

          {currentNextEp ? (
            <button
              type="button"
              disabled={Boolean(isSwitchingEp)}
              onClick={() => switchEpisode(currentNextEp)}
              className={`flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-bold text-white shadow-lg transition ${
                isSwitchingEp === currentNextEp
                  ? "bg-purple-800 pointer-events-none cursor-wait shadow-purple-950/60"
                  : "bg-purple-600 shadow-purple-600/30 hover:bg-purple-500 cursor-pointer"
              } ${isSwitchingEp && isSwitchingEp !== currentNextEp ? "opacity-60 pointer-events-none" : ""}`}
            >
              {isSwitchingEp === currentNextEp ? (
                <Loader2 className="h-4 w-4 animate-spin text-white" />
              ) : null}
              <span>{isSwitchingEp === currentNextEp ? `로딩 중... (${currentNextEp}화)` : `다음 화 (${currentNextEp}화)`}</span>
              {isSwitchingEp !== currentNextEp && <ChevronRight className="h-4 w-4" />}
            </button>
          ) : (
            <span className="rounded-xl bg-slate-950 px-3 py-2 text-xs text-slate-600 cursor-not-allowed">
              마지막 화
            </span>
          )}
        </div>

        {/* 3 Controls matching Flask: 1) OP/ED 자동 스킵, 2) 오디오 분석, 3) 다음 화 자동재생 */}
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          {/* 1) OP/ED 자동 스킵 토글 */}
          <label
            htmlFor="autoSkipToggle"
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-semibold transition border cursor-pointer select-none ${
              autoSkipEnabled
                ? "bg-purple-600/20 text-purple-200 border-purple-500/50 shadow-sm"
                : "bg-slate-800/80 text-slate-400 border-slate-700"
            }`}
          >
            <input
              type="checkbox"
              id="autoSkipToggle"
              checked={autoSkipEnabled}
              onChange={toggleAutoSkip}
              className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-purple-600 accent-purple-600 cursor-pointer"
            />
            <span>OP/ED 자동 스킵</span>
          </label>

          {/* 2) 스킵 분석 상태 보고 뱃지 및 수동 분석/재분석 버튼 */}
          {audioAnalysisStatus === "running" ? (
            /* 2-1) 분석 진행 중: 실시간 단계 안내 뱃지 */
            <div
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-bold border border-purple-500/50 bg-purple-900/30 text-purple-300 animate-pulse cursor-wait select-none"
              title="오디오 AI 분석이 진행 중입니다"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" />
              <span>{audioAnalysisText}</span>
            </div>
          ) : audioAnalysisStatus === "success" ? (
            /* 2-2) 스킵 감지 완료: 선택/클릭되지 않는 상태 보고용 뱃지 */
            <div className="inline-flex items-center gap-1.5">
              <div
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-bold border border-purple-500/40 bg-purple-600/20 text-purple-200 select-none cursor-default"
                title={
                  skipIntervals.length > 0
                    ? skipIntervals
                        .map((i) => `${i.label}: ${formatTimeStr(i.start)} ~ ${formatTimeStr(i.end)}`)
                        .join(" | ")
                    : "스킵 구간이 감지되어 적용되었습니다"
                }
              >
                <CheckCircle2 className="h-3.5 w-3.5 text-purple-400" />
                <span>
                  {(() => {
                    const desc = getSkipLabelDesc(skipIntervals);
                    const descSuffix = desc ? ` (${desc})` : "";
                    if (skipSource === "audio_ai" || skipSource === "chroma") {
                      return `AI 분석 완료${descSuffix}`;
                    }
                    if (skipSource === "aniskip") {
                      return `스킵 감지${descSuffix} · AniSkip`;
                    }
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
