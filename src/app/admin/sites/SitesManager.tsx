"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Globe, Loader2, Plus, Trash2 } from "lucide-react";

type Provider = { key: "anissia" | "reanime" | "ohli24" | "linkkf"; name: string; enabled: boolean };

export default function SitesManager() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = async () => {
    try {
      const response = await fetch("/api/settings/providers", { cache: "no-store" });
      const data = await response.json();
      if (data.success) setProviders(data.providers);
      else setMessage(data.message || "사이트 목록을 불러오지 못했습니다.");
    } catch {
      setMessage("사이트 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const setEnabled = async (provider: Provider, enabled: boolean) => {
    setBusy(provider.key);
    setMessage("");
    try {
      const response = await fetch("/api/settings/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.key, enabled }),
      });
      const data = await response.json();
      if (!data.success) setMessage(data.message || "사이트 설정을 변경하지 못했습니다.");
      else setProviders(data.providers);
    } catch {
      setMessage("사이트 설정을 변경하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#0b0f19] px-4 py-8 text-white sm:px-6">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="mb-6 inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white">
          <ArrowLeft className="h-4 w-4" /> 홈으로
        </Link>
        <section className="rounded-3xl border border-purple-500/20 bg-slate-900/60 p-5 sm:p-7">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/15 text-purple-300">
              <Globe className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold">스트리밍 사이트 관리</h1>
              <p className="mt-1 text-xs text-slate-400">사용 목록에서 빼거나 다시 추가할 사이트를 관리합니다.</p>
            </div>
          </div>

          {message && <p className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">{message}</p>}

          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-purple-300" /></div>
          ) : (
            <div className="mt-6 space-y-3">
              {providers.map((provider) => (
                <div key={provider.key} className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                  <div>
                    <div className="font-semibold">{provider.name}</div>
                    <div className="mt-1 text-xs text-slate-500">{provider.enabled ? "검색 및 사이트 선택에 표시됨" : "검색 및 사이트 선택에서 제외됨"}</div>
                  </div>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void setEnabled(provider, !provider.enabled)}
                    className={`inline-flex min-w-24 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition disabled:opacity-50 ${provider.enabled ? "border border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20" : "bg-emerald-600 text-white hover:bg-emerald-500"}`}
                  >
                    {busy === provider.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : provider.enabled ? <><Trash2 className="h-3.5 w-3.5" /> 목록에서 제거</> : <><Plus className="h-3.5 w-3.5" /> 다시 추가</>}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 rounded-2xl border border-sky-500/15 bg-sky-500/5 p-4 text-xs leading-relaxed text-slate-300">
            여기서 지원 중인 제공처를 검색·선택 목록에 추가하거나 제거할 수 있습니다. 제공처 주소 변경은 상단 메뉴의 도메인 설정에서 합니다. 새 사이트의 페이지 구조가 기존 제공처와 다르면 검색·회차·재생을 연결할 어댑터 지원이 먼저 필요합니다.
          </div>
        </section>
      </div>
    </main>
  );
}
