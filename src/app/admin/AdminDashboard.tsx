"use client";

import { useState, useEffect } from "react";
import { UserPlus, Trash2, RefreshCw, Shield, ShieldOff, KeyRound, Check, AlertCircle, ChevronDown, ChevronUp, Download, Clock3, FileArchive } from "lucide-react";

type User = {
  id: number;
  username: string;
  nickname: string;
  is_admin: boolean;
  is_active: boolean;
  is_first_login: boolean;
  created_at: string;
};

type SubtitleDownload = {
  id: string;
  source: string;
  title: string;
  episode: string;
  creator: string;
  sourceUrl: string;
  files: string[];
  completedAt: string;
};

type SubtitleFailure = {
  id: string;
  source: string;
  title: string;
  episode: string;
  creator: string;
  sourceUrl: string;
  reason: string;
  error: string;
  attemptedAt: string;
};

type SubtitleRun = {
  id: string;
  startedAt: string;
  finishedAt: string;
  status: "success" | "partial" | "failed";
  exitCode: number;
  durationSeconds: number;
  downloadedItems: number;
  downloadedFiles: number;
  failedItems: number;
  retryItems: number;
  waitingUrlItems: number;
  erulaboPendingItems: number;
  downloads: SubtitleDownload[];
  failures: SubtitleFailure[];
};

type SubtitleReport = {
  version: number;
  generatedAt: string;
  schedule?: { label?: string; timezone?: string };
  runs: SubtitleRun[];
};

function CollapseButton({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-slate-800/60 text-slate-400 transition hover:bg-slate-700/80 hover:text-white"
      title={collapsed ? "카드 펼치기" : "카드 접기"}
      aria-label={collapsed ? "카드 펼치기" : "카드 접기"}
    >
      {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
    </button>
  );
}

function formatKstDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(seconds?: number) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${value}초`;
  const minutes = Math.floor(value / 60);
  const remain = value % 60;
  if (minutes < 60) return `${minutes}분 ${remain}초`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 ${minutes % 60}분`;
}

export default function AdminDashboard({
  currentUser,
}: {
  currentUser: { id: number; username: string; nickname: string; isAdmin: boolean };
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [collapsedCards, setCollapsedCards] = useState<Record<string, boolean>>({});
  const [subtitleReport, setSubtitleReport] = useState<SubtitleReport | null>(null);
  const [subtitleLoading, setSubtitleLoading] = useState(true);
  const [subtitleError, setSubtitleError] = useState<string | null>(null);
  const [subtitleDetailsOpen, setSubtitleDetailsOpen] = useState(false);
  
  // Create Form State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createUsername, setCreateUsername] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createNickname, setCreateNickname] = useState("");
  const [createdUserMsg, setCreatedUserMsg] = useState<{ user: string; pass: string } | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Row states
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [resetPassId, setResetPassId] = useState<number | null>(null);
  const [tempResetPass, setTempResetPass] = useState("");

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/admin/users");
      const data = await res.json();
      if (data.success) {
        setUsers(data.users);
      } else {
        setError(data.message || "사용자 목록을 불러오지 못했습니다.");
      }
    } catch (err) {
      setError("서버 통신 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const fetchSubtitleReport = async () => {
    try {
      setSubtitleLoading(true);
      setSubtitleError(null);
      const res = await fetch("/api/admin/subtitle-downloads", { cache: "no-store" });
      const data = await res.json();
      if (data.success) {
        setSubtitleReport(data.report || null);
      } else {
        setSubtitleError(data.message || "자막 다운로드 기록을 불러오지 못했습니다.");
      }
    } catch {
      setSubtitleError("자막 다운로드 기록을 불러오지 못했습니다.");
    } finally {
      setSubtitleLoading(false);
    }
  };

  const toggleCard = (key: string) => {
    setCollapsedCards((current) => ({ ...current, [key]: !current[key] }));
  };

  useEffect(() => {
    fetchUsers();
    fetchSubtitleReport();
  }, []);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 5000);
  };
  
  const showError = (msg: string) => {
    setError(msg);
    setTimeout(() => setError(null), 5000);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setCreatedUserMsg(null);

    if (!createUsername || !createPassword) {
      showError("아이디와 임시 비밀번호를 입력해주세요.");
      return;
    }

    setIsCreating(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: createUsername,
          tempPassword: createPassword,
          nickname: createNickname || undefined,
        }),
      });
      const data = await res.json();

      if (data.success) {
        showSuccess("새 계정이 생성되었습니다.");
        setCreatedUserMsg({ user: createUsername, pass: createPassword });
        setCreateUsername("");
        setCreatePassword("");
        setCreateNickname("");
        fetchUsers();
      } else {
        showError(data.message || "계정 생성 실패");
      }
    } catch (err) {
      showError("서버 오류가 발생했습니다.");
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggleActive = async (id: number, currentStatus: boolean) => {
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle_active", isActive: !currentStatus }),
      });
      const data = await res.json();
      if (data.success) {
        showSuccess(`계정이 ${!currentStatus ? '활성화' : '비활성화'} 되었습니다.`);
        setUsers(users.map(u => u.id === id ? { ...u, is_active: !currentStatus } : u));
      } else {
        showError(data.message || "상태 변경 실패");
      }
    } catch (err) {
      showError("상태 변경 중 오류가 발생했습니다.");
    }
  };

  const handleResetPassword = async (id: number) => {
    if (!tempResetPass) {
      showError("임시 비밀번호를 입력해주세요.");
      return;
    }
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_password", tempPassword: tempResetPass }),
      });
      const data = await res.json();
      if (data.success) {
        showSuccess("비밀번호가 초기화되었습니다.");
        setResetPassId(null);
        setTempResetPass("");
      } else {
        showError(data.message || "비밀번호 초기화 실패");
      }
    } catch (err) {
      showError("초기화 중 오류가 발생했습니다.");
    }
  };

  const handleDeleteUser = async (id: number) => {
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.success) {
        showSuccess("계정이 삭제되었습니다.");
        setUsers(users.filter(u => u.id !== id));
        setConfirmDeleteId(null);
      } else {
        showError(data.message || "삭제 실패");
      }
    } catch (err) {
      showError("삭제 중 오류가 발생했습니다.");
    }
  };

  const generateRandomPassword = () => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let pass = "";
    for (let i = 0; i < 10; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
    setCreatePassword(pass);
  };

  const latestRun = subtitleReport?.runs?.[0] || null;
  const subtitleSchedule = subtitleReport?.schedule?.label || "매주 일요일 04:00";
  const statusLabel = latestRun?.status === "success"
    ? "정상"
    : latestRun?.status === "partial"
      ? "일부 실패"
      : latestRun?.status === "failed"
        ? "실패"
        : "기록 없음";
  const statusClass = latestRun?.status === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : latestRun?.status === "partial"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
      : latestRun?.status === "failed"
        ? "border-red-500/30 bg-red-500/10 text-red-300"
        : "border-slate-500/30 bg-slate-500/10 text-slate-300";

  return (
    <div className="min-h-screen bg-[#060913] p-6 pt-24 text-white">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
              관리자 대시보드
            </h1>
            <p className="mt-2 text-sm text-slate-400">자막 자동화 상태와 시스템 사용자들을 관리합니다.</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-950/40 p-4 text-sm text-red-300">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <p>{error}</p>
          </div>
        )}
        
        {successMsg && (
          <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-4 text-sm text-emerald-300">
            <Check className="h-5 w-5 shrink-0" />
            <p>{successMsg}</p>
          </div>
        )}

        <div className="mb-8 rounded-3xl border border-white/10 bg-[#0d1426]/70 p-6 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-300">
                <Download className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-slate-200">주간 자막 자동 다운로드</h2>
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusClass}`}>
                    {statusLabel}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">Pi 주간 다운로드 작업의 실제 실행 기록입니다.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={fetchSubtitleReport}
                disabled={subtitleLoading}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-slate-800/60 text-slate-400 transition hover:bg-slate-700/80 hover:text-white disabled:opacity-50"
                title="새로고침"
              >
                <RefreshCw className={`h-4 w-4 ${subtitleLoading ? "animate-spin" : ""}`} />
              </button>
              <CollapseButton
                collapsed={!!collapsedCards.subtitles}
                onClick={() => toggleCard("subtitles")}
              />
            </div>
          </div>

          {!collapsedCards.subtitles && (
            <div className="mt-6 border-t border-white/10 pt-6">
              {subtitleLoading && !subtitleReport ? (
                <div className="flex items-center justify-center gap-3 py-8 text-sm text-slate-400">
                  <RefreshCw className="h-5 w-5 animate-spin text-indigo-400" />
                  실행 기록을 불러오는 중...
                </div>
              ) : subtitleError ? (
                <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-4 text-sm text-red-300">
                  {subtitleError}
                </div>
              ) : !latestRun ? (
                <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-5 text-sm text-slate-400">
                  아직 저장된 주간 실행 기록이 없습니다. 업데이트 적용 후 다음 자동 실행부터 여기에 기록됩니다.
                </div>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                    <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4">
                      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500"><Clock3 className="h-3.5 w-3.5" />최근 실행</div>
                      <div className="text-sm font-semibold text-slate-200">{formatKstDate(latestRun.finishedAt)}</div>
                    </div>
                    <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4">
                      <div className="mb-2 text-xs text-slate-500">새 다운로드</div>
                      <div className="text-xl font-bold text-indigo-300">{latestRun.downloadedFiles}<span className="ml-1 text-xs font-normal text-slate-500">파일</span></div>
                    </div>
                    <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4">
                      <div className="mb-2 text-xs text-slate-500">실패</div>
                      <div className={`text-xl font-bold ${latestRun.failedItems ? "text-red-300" : "text-emerald-300"}`}>{latestRun.failedItems}<span className="ml-1 text-xs font-normal text-slate-500">건</span></div>
                    </div>
                    <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4">
                      <div className="mb-2 text-xs text-slate-500">실행 시간</div>
                      <div className="text-sm font-semibold text-slate-200">{formatDuration(latestRun.durationSeconds)}</div>
                    </div>
                    <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4">
                      <div className="mb-2 text-xs text-slate-500">다음 실행</div>
                      <div className="text-sm font-semibold text-slate-200">{subtitleSchedule}</div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/5 bg-slate-900/30 px-4 py-3">
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
                      <span>다운로드 항목 <b className="text-slate-200">{latestRun.downloadedItems}</b></span>
                      <span>재시도 대기 <b className="text-slate-200">{latestRun.retryItems}</b></span>
                      <span>URL 대기 <b className="text-slate-200">{latestRun.waitingUrlItems}</b></span>
                      <span>Erulabo 대기 <b className="text-slate-200">{latestRun.erulaboPendingItems}</b></span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSubtitleDetailsOpen((open) => !open)}
                      className="rounded-xl bg-indigo-500/15 px-3.5 py-2 text-xs font-semibold text-indigo-300 transition hover:bg-indigo-500/25"
                    >
                      {subtitleDetailsOpen ? "상세 로그 닫기" : "상세 로그 보기"}
                    </button>
                  </div>

                  {subtitleDetailsOpen && (
                    <div className="mt-4 space-y-4">
                      <div className="rounded-2xl border border-white/5 bg-slate-900/30 p-4">
                        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
                          <FileArchive className="h-4 w-4 text-indigo-300" />
                          이번 실행에서 받은 자막
                        </div>
                        {latestRun.downloads.length === 0 ? (
                          <div className="py-4 text-sm text-slate-500">이번 실행에서 새로 받은 자막이 없습니다.</div>
                        ) : (
                          <div className="space-y-2">
                            {latestRun.downloads.map((item) => (
                              <div key={item.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-md bg-indigo-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-indigo-300">{item.source}</span>
                                  <span className="text-sm font-semibold text-slate-200">{item.title}</span>
                                  {item.episode && <span className="text-xs text-slate-400">{item.episode}화</span>}
                                  {item.creator && <span className="text-xs text-slate-500">{item.creator}</span>}
                                </div>
                                <div className="mt-2 space-y-1 text-xs text-slate-500">
                                  {item.files.map((file) => <div key={file} className="break-all">• {file}</div>)}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {latestRun.failures.length > 0 && (
                        <div className="rounded-2xl border border-red-500/20 bg-red-950/15 p-4">
                          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-300">
                            <AlertCircle className="h-4 w-4" />
                            이번 실행 실패
                          </div>
                          <div className="space-y-2">
                            {latestRun.failures.map((item, index) => (
                              <div key={`${item.id}-${index}`} className="rounded-xl border border-red-500/10 bg-black/20 p-3">
                                <div className="flex flex-wrap items-center gap-2 text-sm">
                                  <span className="font-semibold text-slate-200">{item.title}</span>
                                  {item.episode && <span className="text-xs text-slate-400">{item.episode}화</span>}
                                  <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-[10px] text-red-300">{item.reason}</span>
                                </div>
                                <div className="mt-1 break-all text-xs text-red-300/80">{item.error}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {subtitleReport && subtitleReport.runs.length > 1 && (
                        <div className="rounded-2xl border border-white/5 bg-slate-900/30 p-4">
                          <div className="mb-3 text-sm font-semibold text-slate-200">최근 실행 기록</div>
                          <div className="space-y-2">
                            {subtitleReport.runs.slice(0, 6).map((run) => (
                              <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-black/20 px-3 py-2 text-xs">
                                <span className="text-slate-400">{formatKstDate(run.finishedAt)}</span>
                                <span className="text-slate-300">다운로드 {run.downloadedFiles} · 실패 {run.failedItems} · {formatDuration(run.durationSeconds)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="mb-8 rounded-3xl border border-white/10 bg-[#0d1426]/70 p-6 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-200">사용자 생성</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setCollapsedCards((current) => ({ ...current, create: false }));
                  setIsCreateOpen(!isCreateOpen);
                }}
                className="flex items-center gap-2 rounded-xl bg-purple-600/20 px-4 py-2 text-sm font-medium text-purple-300 transition hover:bg-purple-600/30"
              >
                <UserPlus className="h-4 w-4" />
                {isCreateOpen ? "닫기" : "새 계정 추가"}
              </button>
              <CollapseButton
                collapsed={!!collapsedCards.create}
                onClick={() => toggleCard("create")}
              />
            </div>
          </div>

          {!collapsedCards.create && isCreateOpen && (
            <div className="mt-6 border-t border-white/10 pt-6">
              <form onSubmit={handleCreateUser} className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-300">아이디 *</label>
                  <input
                    type="text"
                    value={createUsername}
                    onChange={(e) => setCreateUsername(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-[#060913]/70 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 transition focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                    placeholder="user123"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-300">임시 비밀번호 *</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={createPassword}
                      onChange={(e) => setCreatePassword(e.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-[#060913]/70 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 transition focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                      placeholder="password"
                    />
                    <button
                      type="button"
                      onClick={generateRandomPassword}
                      className="rounded-xl border border-white/10 bg-slate-800/80 px-3 py-2 text-slate-300 transition hover:bg-slate-700"
                      title="랜덤 생성"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-300">닉네임 (선택)</label>
                  <input
                    type="text"
                    value={createNickname}
                    onChange={(e) => setCreateNickname(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-[#060913]/70 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 transition focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                    placeholder="길동이"
                  />
                </div>
                <div className="col-span-full mt-2">
                  <button
                    type="submit"
                    disabled={isCreating}
                    className="w-full rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 py-3 text-sm font-bold text-white shadow-lg shadow-purple-600/30 transition hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50"
                  >
                    {isCreating ? "생성 중..." : "계정 생성"}
                  </button>
                </div>
              </form>

              {createdUserMsg && (
                <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-4">
                  <p className="text-sm font-medium text-emerald-300 mb-2">계정이 성공적으로 생성되었습니다. 아래 정보를 사용자에게 전달해주세요.</p>
                  <div className="bg-black/50 p-3 rounded-lg flex flex-col gap-1 text-sm font-mono text-emerald-100">
                    <div><span className="text-emerald-500/70">ID:</span> {createdUserMsg.user}</div>
                    <div><span className="text-emerald-500/70">PW:</span> {createdUserMsg.pass}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-white/10 bg-[#0d1426]/70 p-6 shadow-2xl backdrop-blur-xl">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-200">사용자 목록</h2>
            <CollapseButton
              collapsed={!!collapsedCards.users}
              onClick={() => toggleCard("users")}
            />
          </div>
          
          {!collapsedCards.users && (loading ? (
            <div className="py-12 text-center text-slate-400 flex flex-col items-center">
              <RefreshCw className="h-8 w-8 animate-spin mb-4 text-purple-500" />
              불러오는 중...
            </div>
          ) : users.length === 0 ? (
            <div className="py-12 text-center text-slate-400">
              표시할 사용자가 없습니다.
            </div>
          ) : (
            <div className="grid gap-4">
              {users.map((user) => {
                const isMe = user.id === currentUser.id;
                
                return (
                  <div key={user.id} className="flex flex-col gap-4 rounded-2xl border border-white/5 bg-slate-800/30 p-5 md:flex-row md:items-center md:justify-between">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-slate-200">{user.username}</span>
                        {user.nickname && <span className="text-sm text-slate-400">{user.nickname}</span>}
                        {user.is_admin && (
                          <span className="rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 px-2 py-0.5 text-[10px] font-bold text-white">
                            ADMIN
                          </span>
                        )}
                        {!user.is_active && (
                          <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-400 border border-red-500/30">
                            비활성화됨
                          </span>
                        )}
                        {user.is_first_login && (
                          <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-[10px] font-bold text-purple-400 border border-purple-500/30">
                            초기상태
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">
                        가입일: {new Date(user.created_at).toLocaleDateString()}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {resetPassId === user.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={tempResetPass}
                            onChange={(e) => setTempResetPass(e.target.value)}
                            placeholder="새 임시 비밀번호"
                            className="w-32 rounded-lg border border-white/10 bg-[#060913]/70 px-2 py-1.5 text-xs text-white placeholder-slate-500 focus:border-purple-500 focus:outline-none"
                          />
                          <button
                            onClick={() => handleResetPassword(user.id)}
                            className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/30"
                          >
                            저장
                          </button>
                          <button
                            onClick={() => { setResetPassId(null); setTempResetPass(""); }}
                            className="rounded-lg bg-slate-700/50 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700"
                          >
                            취소
                          </button>
                        </div>
                      ) : confirmDeleteId === user.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-red-400 font-medium">정말 삭제하시겠습니까?</span>
                          <button
                            onClick={() => handleDeleteUser(user.id)}
                            className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-bold text-white shadow-lg shadow-red-500/30 hover:bg-red-600"
                          >
                            삭제
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-lg bg-slate-700/50 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700"
                          >
                            취소
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => handleToggleActive(user.id, user.is_active)}
                            disabled={isMe}
                            title={user.is_active ? "계정 비활성화" : "계정 활성화"}
                            className={`flex h-8 w-8 items-center justify-center rounded-xl border border-white/5 transition disabled:opacity-30 disabled:cursor-not-allowed ${
                              user.is_active 
                                ? "bg-slate-800/80 text-slate-400 hover:bg-amber-500/20 hover:text-amber-400 hover:border-amber-500/30" 
                                : "bg-slate-800/80 text-slate-400 hover:bg-emerald-500/20 hover:text-emerald-400 hover:border-emerald-500/30"
                            }`}
                          >
                            {user.is_active ? <ShieldOff className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
                          </button>
                          <button
                            onClick={() => setResetPassId(user.id)}
                            title="비밀번호 초기화"
                            className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/5 bg-slate-800/80 text-slate-400 transition hover:bg-purple-500/20 hover:text-purple-400 hover:border-purple-500/30"
                          >
                            <KeyRound className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(user.id)}
                            disabled={isMe}
                            title="계정 삭제"
                            className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/5 bg-slate-800/80 text-slate-400 transition hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
