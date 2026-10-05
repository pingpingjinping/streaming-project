import Link from "next/link";
import { ANIKOTO_GENRES, ANIKOTO_TYPES, ANIKOTO_STATUSES, ANIKOTO_SORTS, ANIKOTO_YEARS } from "@/lib/anikotoCatalog";
import type { AnimeListFilterParams } from "@/lib/providers/types";

export default function AnikotoCatalogFilters({ params, keyword = "" }: { params: AnimeListFilterParams; keyword?: string }) {
  const fields = [
    { name: "genre", label: "장르", value: params.genre, all: "전체 장르", options: ANIKOTO_GENRES },
    { name: "year", label: "연도", value: params.year, all: "전체 연도", options: ANIKOTO_YEARS.map(year => [year, `${year}년`]) },
    { name: "type", label: "형식", value: params.typeLang, all: "전체 형식", options: ANIKOTO_TYPES },
    { name: "status", label: "방영 상태", value: params.status, all: "전체 상태", options: ANIKOTO_STATUSES },
    { name: "sort", label: "정렬", value: params.sort || "default", options: ANIKOTO_SORTS },
  ];
  return (
    <form method="get" action="/" className="mt-6 flex flex-wrap items-end gap-3 rounded-2xl border border-purple-500/20 bg-slate-900/60 p-4">
      <input type="hidden" name="tab" value="airing" />
      <input type="hidden" name="page" value="1" />
      <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-slate-400">
        작품명
        <input name="q" defaultValue={keyword} placeholder="제목 검색 (선택)" className="w-44 max-w-full rounded-lg border border-purple-500/25 bg-slate-950 px-3 py-2 text-xs text-white" />
      </label>
      {fields.map(field => (
        <label key={field.name} className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-slate-400">
          {field.label}
          <select name={field.name} defaultValue={field.value || ""} className="max-w-full rounded-lg border border-purple-500/25 bg-slate-950 px-3 py-2 text-xs text-white">
            {field.all && <option value="">{field.all}</option>}
            {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      ))}
      <button type="submit" className="rounded-lg bg-purple-600 px-4 py-2 text-xs font-bold text-white hover:bg-purple-500">적용</button>
      <Link href={`/?tab=airing${keyword ? `&q=${encodeURIComponent(keyword)}` : ""}`} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800">필터 초기화</Link>
    </form>
  );
}
