import { getDb } from "@/lib/db";
import type { AnimeListItem } from "@/lib/providers/types";

const isAniList = (id: string) => /^db_AniList_[A-Za-z0-9_-]+$/.test(id);
const isWork = (id: string) => /^(?:ani_[1-9]\d*|(?:re_|ak_|db_AniList_|db_Onnada_)[A-Za-z0-9_-]+)$/.test(id);
const isVideo = (id: string) => /^(?:re_|ak_)[A-Za-z0-9_-]+$/.test(id);
const workId = (source: string, id: string) =>
  ({ Anissia: "ani_", ReAnime: "re_", Anikoto: "ak_" }[source] || "db_" + source + "_") + id;
const ref = (id: string) => id.replace(/^ani_/, "Anissia:").replace(/^re_/, "ReAnime:")
  .replace(/^ak_/, "Anikoto:").replace(/^db_(AniList|Onnada)_/, "$1:");

type Links = { videos: Set<string>; segments: Set<string>; ambiguous: boolean };
const emptyLinks = (): Links => ({ videos: new Set(), segments: new Set(), ambiguous: false });

/** Compare the complete provider sets, never a title or one shared video edge.
 * Unknown lookups, empty sets and unspecified multi-season ranges cannot merge. */
export function mergeCatalogVideoDuplicates(items: AnimeListItem[], links: Map<string, Links>): AnimeListItem[] {
  const seen = new Map<string, AnimeListItem>();
  const result: AnimeListItem[] = [];
  for (const item of items) {
    const link = links.get(item.id);
    const key = link?.videos.size && !link.ambiguous
      ? JSON.stringify([[...link.videos].sort(), [...link.segments].sort()]) : "";
    const previous = key ? seen.get(key) : undefined;
    if (!previous) {
      const copy = { ...item };
      result.push(copy);
      if (key) seen.set(key, copy);
      continue;
    }
    // Preserve the first result's stable destination and registered title.
    if (!previous.poster && item.poster) previous.poster = item.poster;
    previous.source_name = [...new Set([previous.source_name, item.source_name]
      .flatMap(value => (value || "").split(" · ")).filter(Boolean))].join(" · ");
  }
  return result;
}

/** Stored link availability, not a live playback test. A /catalog URL may
 * already offer several video choices. Read current-page identities in batches. */
export async function applyCatalogVideoLinkStatus(
  items: AnimeListItem[], options: { deduplicate?: boolean } = {},
): Promise<AnimeListItem[]> {
  const candidates = items.filter(item => isWork(item.id));
  if (!candidates.length || (!options.deduplicate && !candidates.some(item => isAniList(item.id)))) return items;
  const members = new Map<string, Set<string>>();
  for (const item of candidates) {
    const ids = members.get(item.id) || new Set([item.id]);
    const direct = /^\/anime\/([^/?#]+)$/.exec(item.detail_url)?.[1];
    if (direct && isWork(direct)) ids.add(direct);
    members.set(item.id, ids);
  }
  const wanted = [...new Set([...members.values()].flatMap(ids => [...ids]))];
  const sql = getDb();
  const links = new Map<string, Links>();
  let checked = false;
  if (sql) {
    try {
      const groups = await sql`WITH memberships AS (
          SELECT 'title:'||canonical_id AS group_id,anime_id AS member_id FROM anime_admin_work_titles
          UNION ALL
          SELECT 'folder:'||relative_path,anime_id FROM anime_admin_subtitle_links
          UNION ALL
          SELECT 'folder:'||relative_path,anime_id FROM anime_admin_subtitle_link_members
          UNION ALL
          SELECT 'release:'||group_id,member_id FROM anime_release_reviewed_work_group_members
        )
        SELECT DISTINCT seed.member_id AS work_id,member.member_id
        FROM memberships seed JOIN memberships member ON member.group_id=seed.group_id
        WHERE seed.member_id=ANY(${wanted}::text[])`;
      // Do not traverse a shared video into other seasons. Only expand explicit
      // reviewed identity groups, then prefer each work's own provider mappings.
      for (const ids of members.values()) {
        const seeds = new Set(ids);
        for (const row of groups) if (seeds.has(String(row.work_id)) && isWork(String(row.member_id)))
          ids.add(String(row.member_id));
      }
      const expanded = [...new Set([...members.values()].flatMap(ids => [...ids]))];
      const references = expanded.map(ref);
      const [korean, subtitle, matches, overrides] = await Promise.all([
        sql`SELECT source,source_record_id,payload->>'anilistId' AS anilist_id,
            payload->>'reanimeId' AS reanime_id FROM anime_korean_catalog
          WHERE payload->>'status' IN ('검토된 사항','자동확정')
            AND ((source||':'||source_record_id)=ANY(${references}::text[])
              OR ('db_AniList_'||(payload->>'anilistId'))=ANY(${expanded}::text[]))`,
        sql`SELECT target_source AS source,target_id AS source_record_id,reanime_id
          FROM anime_subtitle_work_reanime_links
          WHERE automatic_eligible AND (target_source||':'||target_id)=ANY(${references}::text[])`,
        sql`SELECT reanime_id,anissia_no FROM anime_reanime_matches
          WHERE review_status IN ('검토된 사항','자동확정')
            AND ('ani_'||anissia_no::text)=ANY(${expanded}::text[])`,
        sql`SELECT reanime_id,anissia_no FROM anime_work_match_overrides`,
      ]);
      const direct = new Map<string, Links>();
      const get = (id: string) => {
        if (!direct.has(id)) direct.set(id, emptyLinks());
        return direct.get(id)!;
      };
      for (const id of expanded) if (isVideo(id)) get(id).videos.add(id);
      const addRe = (id: string, rid: unknown) => {
        const video = "re_" + String(rid || "");
        if (!isVideo(video)) return;
        // Current Pi corrections take priority over older imported edges.
        if (id.startsWith("ani_") && overrides.some(row =>
          ("ani_" + row.anissia_no === id || "re_" + row.reanime_id === video) &&
          !("ani_" + row.anissia_no === id && "re_" + row.reanime_id === video))) return;
        get(id).videos.add(video);
      };
      for (const row of korean) {
        addRe(workId(row.source, row.source_record_id), row.reanime_id);
        if (row.anilist_id) addRe("db_AniList_" + row.anilist_id, row.reanime_id);
      }
      for (const row of subtitle) addRe(workId(row.source, row.source_record_id), row.reanime_id);
      for (const row of [...matches, ...overrides]) addRe("ani_" + row.anissia_no, row.reanime_id);
      const streamRefs = [...new Set([...references, ...[...direct.values()]
        .flatMap(link => [...link.videos].filter(id => id.startsWith("re_")).map(ref))])];
      const streams = await sql`SELECT source,source_record_id,anikoto_id,link_status,
          anikoto_episode_start,anikoto_episode_end,target_episode_start,target_episode_end
        FROM anime_anikoto_work_lookup
        WHERE (source||':'||source_record_id)=ANY(${streamRefs}::text[])
          AND link_status IN ('automatic','reviewed','multi_reviewed')`;
      for (const row of streams) {
        const video = "ak_" + String(row.anikoto_id || "");
        if (!isVideo(video)) continue;
        const link = get(workId(row.source, row.source_record_id));
        link.videos.add(video);
        const range = [row.anikoto_episode_start, row.anikoto_episode_end,
          row.target_episode_start, row.target_episode_end];
        if (range.some(value => value != null)) link.segments.add(JSON.stringify([video, ...range]));
        if (row.link_status === "multi_reviewed" && range.every(value => value == null)) link.ambiguous = true;
      }
      for (const item of candidates) {
        const own = get(item.id), resolved = emptyLinks();
        // A work's explicit provider split must not be replaced with the union
        // from a broader registered group sharing the other video provider.
        for (const prefix of ["re_", "ak_"]) {
          const ownVideos = [...own.videos].filter(id => id.startsWith(prefix));
          const aliases = [...members.get(item.id)!];
          // Anikoto links may be indexed on a verified ReAnime member only.
          if (prefix === "ak_") aliases.push(...resolved.videos);
          const sources = ownVideos.length ? [own] : aliases.map(get);
          for (const source of sources) {
            for (const id of source.videos) if (id.startsWith(prefix)) resolved.videos.add(id);
            if (prefix === "ak_") {
              for (const segment of source.segments) resolved.segments.add(segment);
              resolved.ambiguous ||= source.ambiguous;
            }
          }
        }
        links.set(item.id, resolved);
      }
      checked = true;
    } catch {
      // Missing tables and temporary DB failures mean unknown, not unlinked.
      console.warn("[Catalog video link status] Lookup unavailable");
    }
  }
  const annotated = items.map(item => {
    if (!isAniList(item.id)) return item;
    const direct = /^\/anime\/(?:re_[A-Za-z0-9_-]+|ak_[A-Za-z0-9_-]+)$/.test(item.detail_url);
    return { ...item, video_link_status: direct || links.get(item.id)?.videos.size
      ? "linked" as const : checked ? "unlinked" as const : undefined };
  });
  return checked && options.deduplicate ? mergeCatalogVideoDuplicates(annotated, links) : annotated;
}
