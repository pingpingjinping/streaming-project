"use client";

import Link from "next/link";
import { useState, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Film, Search, Loader2, LogIn, LogOut, User, Globe, Settings, Users, ChevronDown, RefreshCw, Link2, FolderOpen } from "lucide-react";
import BaseUrlSettingsModal from "./BaseUrlSettingsModal";
import SourceSelectModal, { StreamingSource } from "./SourceSelectModal";
import { resolveAnimeSearchMode, type AnimeSearchMode } from "@/lib/animeSearchMode";

interface CurrentUser {
  id: number;
  username: string;
  nickname: string;
  isAdmin: boolean;
}

export default function Navbar() {
  const [keyword, setKeyword] = useState("");
  const [searchScope, setSearchScope] = useState<"current" | "all">("current");
  const [searchMode, setSearchMode] = useState<AnimeSearchMode>("db");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSourceModalOpen, setIsSourceModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [domainStatus, setDomainStatus] = useState<"healthy" | "unhealthy" | "loading">("loading");
  const [activeSource, setActiveSource] = useState<StreamingSource>("anissia");
  const [isNavHidden, setIsNavHidden] = useState(false);
  const [isSearching, startSearchTransition] = useTransition();

  const menuRef = useRef<HTMLDivElement>(null);
  const lastScrollYRef = useRef(0);
  const router = useRouter();

  // 쿠키에서 현재 active source 확인
  useEffect(() => {
    const match = document.cookie.match(/anime_source=([^;]+)/);
    if (match && (match[1] === "anissia" || match[1] === "ohli24" || match[1] === "linkkf" || match[1] === "reanime" || match[1] === "anikoto")) {
      setActiveSource(match[1] as StreamingSource);
    }
    const params = new URLSearchParams(window.location.search);
    setSearchScope(params.get("scope") === "all" ? "all" : "current");
    setSearchMode(params.get("search_mode") === "page" ? "page" : "db");
  }, []);

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 모바일에서는 아래로 스크롤할 때 상단바를 숨기고 위로 올리면 다시 표시한다.
  // 가로/세로 방향 모두 적용하되, 메뉴/모달/검색 입력 중에는 상단바를 유지한다.
  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 1023px)");
    lastScrollYRef.current = Math.max(0, window.scrollY);
    if (isMenuOpen || isSettingsOpen || isSourceModalOpen) {
      setIsNavHidden(false);
    }

    const keepVisible = () => {
      const active = document.activeElement;
      return (
        isMenuOpen ||
        isSettingsOpen ||
        isSourceModalOpen ||
        active instanceof HTMLInputElement ||
        active instanceof HTMLSelectElement
      );
    };

    const handleScroll = () => {
      if (!mobileQuery.matches) {
        setIsNavHidden(false);
        lastScrollYRef.current = Math.max(0, window.scrollY);
        return;
      }

      const currentY = Math.max(0, window.scrollY);
      const delta = currentY - lastScrollYRef.current;

      if (keepVisible() || currentY <= 24) {
        setIsNavHidden(false);
      } else if (delta > 14 && currentY > 72) {
        setIsNavHidden(true);
      } else if (delta < -10) {
        setIsNavHidden(false);
      }

      lastScrollYRef.current = currentY;
    };

    const handleViewportChange = () => {
      if (!mobileQuery.matches) setIsNavHidden(false);
      lastScrollYRef.current = Math.max(0, window.scrollY);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleViewportChange);
    mobileQuery.addEventListener?.("change", handleViewportChange);

    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleViewportChange);
      mobileQuery.removeEventListener?.("change", handleViewportChange);
    };
  }, [isMenuOpen, isSettingsOpen, isSourceModalOpen]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated && data.user) {
          setCurrentUser(data.user);
        }
      })
      .catch(() => {})
      .finally(() => setIsLoadingAuth(false));

    const match = typeof document !== "undefined" ? document.cookie.match(/anime_source=([^;]+)/) : null;
    const currentSrc = match ? match[1] : "anissia";

    if (currentSrc === "anissia") {
      fetch("https://api.anissia.net/anime/schedule/1", { signal: AbortSignal.timeout(3000) })
        .then((r) => setDomainStatus(r.ok ? "healthy" : "unhealthy"))
        .catch(() => setDomainStatus("unhealthy"));
      return;
    }

    fetch(`/api/settings/base-url?provider=${currentSrc}`)
      .then((res) => res.json())
      .then(async (data) => {
        if (data.success) {
          if (data.isHealthy) {
            setDomainStatus("healthy");
          } else if (currentSrc === "reanime") {
            try {
              const direct = await fetch(`${data.baseUrl || "https://reanime.to"}/api/v1/home`, {
                headers: { Accept: "application/json" },
              });
              setDomainStatus(direct.ok ? "healthy" : "unhealthy");
            } catch {
              setDomainStatus("unhealthy");
            }
          } else {
            setDomainStatus("unhealthy");
          }
        }
      })
      .catch(() => setDomainStatus("unhealthy"));
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSearching) return;

    const query = keyword.trim();
    if (!query) return;

    const scopeParam = searchScope === "all" ? "&scope=all" : "";
    const linkedParam=activeSource==='reanime' && searchScope!=='all'
      && new URLSearchParams(window.location.search).get('linked')==='1'?'&linked=1':'';
    const mode = resolveAnimeSearchMode(activeSource, searchScope, searchMode);
    const modeParam = activeSource === "anissia" && searchScope === "current"
      ? `&search_mode=${mode}` : "";
    const target = `/?tab=search&q=${encodeURIComponent(query)}${scopeParam}${linkedParam}${modeParam}`;

    // Next keeps the transition pending until the result commits, including
    // slow searches and refreshes of the same search URL.
    startSearchTransition(() => {
      if (target === window.location.pathname + window.location.search) router.refresh();
      else router.push(target);
    });
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setCurrentUser(null);
      window.location.href = "/login";
    } catch (err) {
      console.error("Logout failed:", err);
    }
  };

  return (
    <>
      <header
        className={`sticky top-0 z-40 w-full border-b border-purple-500/20 bg-[#0b0f19]/95 backdrop-blur-md safe-top transition-transform duration-200 ease-out ${isNavHidden ? "-translate-y-full" : "translate-y-0"}`}
      >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8 gap-3 safe-x">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 font-bold text-lg text-white shrink-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-purple-600 to-indigo-500 text-white shadow-lg shadow-purple-500/25">
            <Film className="h-5 w-5" />
          </div>
          <span className="hidden sm:inline bg-gradient-to-r from-purple-400 via-pink-400 to-indigo-400 bg-clip-text text-transparent font-extrabold text-xl">
            Anihub
          </span>
        </Link>

        {/* Search Input */}
        <form
          onSubmit={handleSearch}
          aria-busy={isSearching}
          className="flex flex-1 max-w-sm sm:max-w-lg mx-auto sm:mx-4 gap-1.5 min-w-0"
        >
          {activeSource === "anissia" ? (
            <select
              aria-label="애니시아 검색 방식"
              value={searchScope === "all" ? "all" : searchMode}
              disabled={isSearching}
              onChange={(e) => {
                const value = e.target.value;
                if (value === "all") {
                  setSearchScope("all");
                } else {
                  setSearchScope("current");
                  setSearchMode(value as AnimeSearchMode);
                }
              }}
              className="max-w-[108px] shrink-0 rounded-full border border-purple-500/30 bg-slate-900/80 px-1.5 py-1.5 text-[10px] font-semibold text-purple-200 outline-none focus:border-purple-500 sm:text-xs"
            >
              <option value="db">DB 검색</option>
              <option value="page">페이지 검색</option>
              <option value="all">전체 사이트</option>
            </select>
          ) : (
            <select
              aria-label="검색 사이트 범위"
              value={searchScope}
              disabled={isSearching}
              onChange={(e) => setSearchScope(e.target.value as "current" | "all")}
              className="max-w-[92px] shrink-0 rounded-full border border-purple-500/20 bg-slate-900/80 px-2 py-1.5 text-[10px] text-slate-300 outline-none focus:border-purple-500 sm:text-xs"
            >
              <option value="current">현재 사이트</option>
              <option value="all">전체 사이트</option>
            </select>
          )}
          <div className="relative min-w-0 flex-1">
            <input
              type="text"
              placeholder={isSearching ? "검색 중..." : "애니 제목 검색..."}
              value={keyword}
              disabled={isSearching}
              onChange={(e) => setKeyword(e.target.value)}
              className={`w-full rounded-full border bg-slate-900/80 px-4 py-1.5 pl-9 text-xs sm:text-sm text-slate-200 placeholder-slate-400 outline-none transition ${
                isSearching
                  ? "cursor-wait border-purple-400 ring-1 ring-purple-500/60"
                  : "border-purple-500/20 focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
              }`}
            />
            {isSearching ? (
              <Loader2 className="absolute left-3 top-2 sm:top-2.5 h-3.5 w-3.5 sm:h-4 sm:w-4 animate-spin text-purple-300 pointer-events-none" />
            ) : (
              <Search className="absolute left-3 top-2 sm:top-2.5 h-3.5 w-3.5 sm:h-4 sm:w-4 text-slate-400 pointer-events-none" />
            )}
          </div>
        </form>

        <Link href="/catalog" className="hidden shrink-0 text-xs font-semibold text-purple-300 hover:text-white lg:inline-flex">한글 DB</Link>
        <Link href="/unmatched" className="hidden shrink-0 items-center gap-1.5 text-xs font-semibold text-amber-300 hover:text-white xl:inline-flex">
          <Link2 className="h-4 w-4" /> 미연결 작품
        </Link>

        {/* Right Auth & Settings Controls (Integrated Menu) */}
        <div className="relative flex items-center gap-2 shrink-0" ref={menuRef}>
          {/* 스트리밍 사이트 스위처 버튼 */}
          <button
            type="button"
            onClick={() => setIsSourceModalOpen(true)}
            title="스트리밍 소스 사이트 변경 (애니시아 허브 / ReAnime / Anikoto / Linkani / Ohli24)"
            className="flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-slate-900/80 px-2.5 sm:px-3 py-1.5 text-xs text-white hover:border-purple-500/60 hover:bg-slate-800 transition shadow-sm"
          >
            <RefreshCw className="h-3.5 w-3.5 text-purple-400" />
            <span className="mobile-portrait-nav-label font-bold text-[11px] text-purple-300">
              {activeSource === "anissia" ? "애니시아" : activeSource === "reanime" ? "ReAnime" : activeSource === "anikoto" ? "Anikoto" : activeSource === "ohli24" ? "Ohli24" : "Linkani"}
            </span>
          </button>

          {/* 도메인 설정 버튼 */}
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            title="스트리밍 도메인(베이스 URL) 주소 설정"
            className="relative flex h-8 w-8 items-center justify-center rounded-full border border-purple-500/30 bg-slate-900/80 text-slate-300 hover:text-white hover:border-purple-500/60 hover:bg-slate-800 transition shadow-sm"
          >
            <Globe className="h-4 w-4 text-sky-400" />
            <span
              className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[#0b0f19] ${
                domainStatus === "healthy"
                  ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                  : domainStatus === "unhealthy"
                  ? "bg-rose-500 animate-pulse"
                  : "bg-slate-500"
              }`}
            />
          </button>

          {!isLoadingAuth && (
            <>
              {currentUser ? (
                <>
                  {/* 통합 닉네임/메뉴 트리거 버튼 */}
                  <button
                    type="button"
                    onClick={() => setIsMenuOpen((prev) => !prev)}
                    className="flex items-center gap-2 rounded-full border border-purple-500/30 bg-slate-900/80 px-3 py-1.5 text-xs text-white hover:border-purple-500/60 hover:bg-slate-800 transition shadow-sm"
                  >
                    <User className="h-3.5 w-3.5 text-purple-400" />
                    <span className="mobile-portrait-nav-label font-semibold max-w-[90px] sm:max-w-[120px] truncate">{currentUser.nickname}</span>
                    {currentUser.isAdmin && (
                      <span className="mobile-portrait-nav-label rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 px-1.5 py-0.2 text-[9px] font-bold text-white">
                        관리자
                      </span>
                    )}
                    <ChevronDown className={`mobile-portrait-nav-label h-3 w-3 text-slate-400 transition-transform ${isMenuOpen ? "rotate-180" : ""}`} />
                  </button>

                  {/* 목록형 드롭다운 메뉴 (Menu Popup) */}
                  {isMenuOpen && (
                    <div className="absolute right-0 top-full mt-2 w-56 rounded-2xl border border-purple-500/30 bg-[#0f172a] p-1.5 shadow-2xl shadow-purple-950/60 backdrop-blur-xl z-50 animate-in fade-in zoom-in-95 duration-150">
                      {/* 1. 스트리밍 사이트 변경 */}
                      <button
                        type="button"
                        onClick={() => {
                          setIsMenuOpen(false);
                          setIsSourceModalOpen(true);
                        }}
                        className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-xs font-medium text-slate-200 hover:bg-purple-600/20 hover:text-white transition"
                      >
                        <div className="flex items-center gap-2.5">
                          <RefreshCw className="h-3.5 w-3.5 text-purple-400" />
                          <span>스트리밍 사이트</span>
                        </div>
                        <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-[10px] font-bold text-purple-300 border border-purple-500/30">
                          {activeSource === "anissia" ? "애니시아" : activeSource === "reanime" ? "ReAnime" : activeSource === "anikoto" ? "Anikoto" : activeSource === "ohli24" ? "Ohli24" : "Linkani"}
                        </span>
                      </button>

                      <div className="my-1 border-t border-white/10" />

                      <Link href="/catalog" onClick={() => setIsMenuOpen(false)}
                        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-medium text-purple-200 hover:bg-purple-600/20">
                        <Film className="h-3.5 w-3.5" /> 한글 애니 DB
                      </Link>

                      {currentUser.isAdmin && (
                        <Link href="/admin/subtitle-links" onClick={() => setIsMenuOpen(false)}
                          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-medium text-emerald-200 hover:bg-emerald-600/20">
                          <FolderOpen className="h-3.5 w-3.5"/> 로컬 자막 DB 연결
                        </Link>
                      )}

                      <Link
                        href="/unmatched"
                        onClick={() => setIsMenuOpen(false)}
                        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-medium text-amber-200 hover:bg-amber-500/10 hover:text-white"
                      >
                        <Link2 className="h-3.5 w-3.5" /> 미연결 작품 · 링크 저장
                      </Link>

                      {/* 2. 도메인 설정 */}
                      <button
                        type="button"
                        onClick={() => {
                          setIsMenuOpen(false);
                          setIsSettingsOpen(true);
                        }}
                        className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs font-medium text-slate-200 hover:bg-purple-600/20 hover:text-white transition"
                      >
                        <div className="flex items-center gap-2.5">
                          <Globe className="h-3.5 w-3.5 text-sky-400" />
                          <span>도메인 주소 설정</span>
                        </div>
                        <span
                          className={`h-2 w-2 rounded-full ${
                            domainStatus === "healthy" ? "bg-emerald-400" : "bg-rose-500"
                          }`}
                        />
                      </button>

                      {/* 3. 프로필 수정 */}
                      <Link
                        href="/profile"
                        onClick={() => setIsMenuOpen(false)}
                        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-slate-200 hover:bg-purple-600/20 hover:text-white transition"
                      >
                        <Settings className="h-3.5 w-3.5 text-slate-400" />
                        <span>프로필 설정</span>
                      </Link>

                      {/* 4. 계정 관리 (관리자) */}
                      {currentUser.isAdmin && (
                        <Link
                          href="/admin"
                          onClick={() => setIsMenuOpen(false)}
                          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 transition"
                        >
                          <Users className="h-3.5 w-3.5 text-emerald-400" />
                          <span>사용자 계정 관리</span>
                        </Link>
                      )}

                      {currentUser.isAdmin && (
                        <Link
                          href="/admin/sites"
                          onClick={() => setIsMenuOpen(false)}
                          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-sky-200 hover:bg-sky-500/10 hover:text-white transition"
                        >
                          <Globe className="h-3.5 w-3.5 text-sky-400" />
                          <span>스트리밍 사이트 관리</span>
                        </Link>
                      )}

                      <div className="my-1 border-t border-white/10" />

                      {/* 5. 로그아웃 */}
                      <button
                        type="button"
                        onClick={handleLogout}
                        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-rose-400 hover:bg-rose-500/10 transition"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        <span>로그아웃</span>
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <Link
                  href="/login"
                  className="flex items-center gap-1.5 rounded-full border border-purple-500/40 bg-purple-600/20 px-3.5 py-1.5 text-xs font-bold text-purple-300 transition hover:bg-purple-600 hover:text-white"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  <span className="mobile-portrait-nav-label">로그인</span>
                </Link>
              )}
            </>
          )}
        </div>
      </div>
    </header>

    {/* 스트리밍 사이트 선택 모달 */}
    <SourceSelectModal
      isOpen={isSourceModalOpen}
      onClose={() => setIsSourceModalOpen(false)}
      currentSource={activeSource}
      onSourceChange={(newSource) => {
        setActiveSource(newSource);
        // A new site starts with its normal page search.
        // Returning to Anissia defaults to the Cloudflare DB index.
        setSearchMode("db");
      }}
    />

    {/* 도메인 설정 모달 */}
    <BaseUrlSettingsModal
      isOpen={isSettingsOpen}
      onClose={() => setIsSettingsOpen(false)}
      onUpdated={() => {
        setDomainStatus("healthy");
      }}
    />
  </>
  );
}
