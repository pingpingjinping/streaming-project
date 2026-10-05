import type { AnimeListFilterParams } from "./providers/types";

// Values from Anikoto's /filter form; these are upstream IDs, not search terms.
export const ANIKOTO_GENRES: [string, string][] = [
  ["1", "액션"], ["2344", "액션·모험"], ["2", "모험"], ["2345", "애니메이션"],
  ["2357", "수상작"], ["2330", "보이즈 러브"], ["538", "자동차"], ["8", "코미디"],
  ["453", "실험적"], ["119", "악마"], ["62", "드라마"], ["214", "에치"],
  ["2322", "성인"], ["3", "판타지"], ["180", "게임"], ["2328", "걸즈 러브"],
  ["2326", "미식"], ["215", "하렘"], ["70", "역사"], ["222", "호러"],
  ["74", "이세계"], ["404", "여성향"], ["46", "아동"], ["203", "마법"],
  ["2310", "마법소녀"], ["114", "무술"], ["123", "메카"], ["125", "밀리터리"],
  ["242", "음악"], ["57", "미스터리"], ["162", "패러디"], ["136", "경찰"],
  ["73", "심리"], ["28", "로맨스"], ["163", "사무라이"], ["14", "학원"],
  ["12", "SF"], ["2352", "SF·판타지"], ["50", "청년"], ["252", "소녀"],
  ["235", "소녀애"], ["15", "소년"], ["233", "소년애"], ["35", "일상"],
  ["124", "우주"], ["29", "스포츠"], ["16", "초능력"], ["9", "초자연"],
  ["2316", "서스펜스"], ["54", "스릴러"], ["32", "미분류"], ["58", "흡혈귀"],
];
export const ANIKOTO_TYPES: [string, string][] = [
  ["TV", "TV"], ["Movie", "극장판"], ["OVA", "OVA"], ["ONA", "ONA"],
  ["Special", "스페셜"], ["TV_SHORT", "단편 TV"], ["TV Special", "TV 스페셜"], ["Music", "음악"],
];
export const ANIKOTO_STATUSES: [string, string][] = [
  ["currently-airing", "방영 중"], ["finished-airing", "완결"], ["not-yet-aired", "방영 예정"],
];
export const ANIKOTO_SORTS: [string, string][] = [
  ["default", "기본순"], ["latest-updated", "최근 업데이트순"], ["latest-added", "최근 등록순"],
  ["score", "평점순"], ["name-az", "제목순 A–Z"], ["release-date", "공개일순"],
  ["most-viewed", "조회수순"], ["number_of_episodes", "회차 수순"],
];
export const ANIKOTO_YEARS = Array.from({ length: new Date().getFullYear() - 1979 }, (_, i) => String(new Date().getFullYear() - i));
export type AnikotoCatalogParams = AnimeListFilterParams & { keyword?: string };

export function anikotoCatalogUrl(baseUrl: string, params: AnikotoCatalogParams): string {
  const url = new URL("filter", baseUrl.replace(/\/+$/, "") + "/");
  const keyword = params.keyword?.trim();
  if (keyword && keyword !== "*") url.searchParams.set("keyword", keyword);
  if (ANIKOTO_GENRES.some(([id]) => id === params.genre)) url.searchParams.set("genre[]", params.genre!);
  if (ANIKOTO_YEARS.includes(params.year || "")) url.searchParams.set("year[]", params.year!);
  if (ANIKOTO_TYPES.some(([id]) => id === params.typeLang)) url.searchParams.set("term_type[]", params.typeLang!);
  if (ANIKOTO_STATUSES.some(([id]) => id === params.status)) url.searchParams.set("status[]", params.status!);
  if (ANIKOTO_SORTS.some(([id]) => id === params.sort) && params.sort !== "default") url.searchParams.set("sort", params.sort!);
  const page = Math.max(1, Math.trunc(Number(params.page)) || 1);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}
