"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

const SOURCES = [
  { id: "rean", label: "ReAnime", hint: "고화질" },
  { id: "anikoto", label: "Anikoto", hint: "해외" },
  { id: "linkkf", label: "Linkani", hint: "자체자막" },
  { id: "ohli24", label: "Ohli24", hint: "국내" },
] as const;

export default function AnissiaVideoSourceSelect({
  animeId,
  episodeNumber,
  selectedSource,
  creator,
  subUrl,
  isDub = false,
}: {
  animeId: string;
  episodeNumber: number;
  selectedSource: string;
  creator?: string;
  subUrl?: string;
  isDub?: boolean;
}) {
  const router = useRouter();
  const chooseSource = async (source: string, href: string) => {
    try {
      // This is an explicit user choice, not an automatic provider fallback.
      // Await a short account save before client-side navigation; the query
      // itself still works even if the preference endpoint is unavailable.
      await fetch("/api/settings/work-video-source", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ animeId, source }),
        signal: AbortSignal.timeout(1800),
      });
    } catch (error) {
      console.warn("[Work video source preference] Could not sync", error);
    } finally {
      router.push(href);
    }
  };
  return (
    <section className="mb-4 rounded-2xl border border-slate-700/70 bg-slate-900/70 p-4">
      <div className="mb-3">
        <h2 className="text-sm font-bold text-white">영상 제공처</h2>
        <p className="mt-1 text-xs text-slate-400">회차 목록은 재생 중인 영상 제공처에 맞춰 표시돼요. 추가 회차나 OVA 자막은 자막 선택에서 연결하거나 회차별 예외로 지정할 수 있어요.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {SOURCES.map((source) => {
          const query = new URLSearchParams({ video_source: source.id });
          if (creator) query.set("creator", creator);
          if (subUrl) query.set("sub_url", subUrl);
          if (isDub) query.set("dub", "1");
          const active = selectedSource === source.id;
          const href = `/watch/${animeId}/${episodeNumber}?${query.toString()}`;
          return (
            <Link
              prefetch={false}
              key={source.id}
              href={href}
              onClick={event => {
                if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                void chooseSource(source.id, href);
              }}
              aria-current={active ? "page" : undefined}
              className={`rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${
                active
                  ? "border-purple-400 bg-purple-600/30 text-purple-100"
                  : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500 hover:text-white"
              }`}
            >
              {source.label}<span className="ml-1.5 text-[10px] opacity-70">{source.hint}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
