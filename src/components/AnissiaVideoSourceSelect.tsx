"use client";

import Link from "next/link";

const SOURCES = [
  { id: "rean", label: "ReAnime", hint: "기본" },
  { id: "linkkf", label: "Linkkf", hint: "대체" },
  { id: "ohli24", label: "Ohli24", hint: "대체" },
] as const;

export default function AnissiaVideoSourceSelect({
  animeId,
  episodeNumber,
  selectedSource,
  creator,
  subUrl,
}: {
  animeId: string;
  episodeNumber: number;
  selectedSource: string;
  creator?: string;
  subUrl?: string;
}) {
  return (
    <section className="mb-4 rounded-2xl border border-slate-700/70 bg-slate-900/70 p-4">
      <div className="mb-3">
        <h2 className="text-sm font-bold text-white">영상 제공처</h2>
        <p className="mt-1 text-xs text-slate-400">기본은 ReAnime입니다. 재생이 안 되면 다른 제공처를 선택해 보세요.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {SOURCES.map((source) => {
          const query = new URLSearchParams({ video_source: source.id });
          if (creator) query.set("creator", creator);
          if (subUrl) query.set("sub_url", subUrl);
          const active = selectedSource === source.id;
          return (
            <Link
              key={source.id}
              href={`/watch/${animeId}/${episodeNumber}?${query.toString()}`}
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
