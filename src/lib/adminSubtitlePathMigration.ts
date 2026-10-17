import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseBundleScope, bundleScopeKey, parseLocalFileKey, localFileKey } from "@/lib/subtitleLocalIdentity";

/** Change only an exact physical work-folder prefix; hashes and track IDs survive. */
export function renamedSubtitleReference(key: string, former: string, next: string): string {
  const [source,work]=former.split("/"),newWork=next.split("/")[1];
  const scope=parseBundleScope(key);
  if(scope && scope.type!=="reviewed") {
    if(scope.provider+"_subtitles"!==source || scope.work!==work)return key;
    const changed=bundleScopeKey({...scope,work:newWork});
    if(!parseBundleScope(changed))throw new Error("변경할 폴더명이 저장된 자막 지정에 비해 너무 깁니다. 이름 유지로 저장해 주세요.");
    return changed;
  }
  const file=parseLocalFileKey(key);
  if(file) {
    if(file.relative!==former && !file.relative.startsWith(former+"/"))return key;
    const changed=localFileKey(next+file.relative.slice(former.length),file.member,file.sha256);
    if(!parseLocalFileKey(changed))throw new Error("변경할 경로가 회차별 자막 지정에 비해 너무 깁니다. 이름 유지로 저장해 주세요.");
    return changed;
  }
  if(key.includes(former) || key.includes(encodeURIComponent(former)) ||
      (key.startsWith("b") && (key.includes(work) || key.includes(encodeURIComponent(work)))))
    throw new Error("이 폴더를 참조하는 옛 자막 지정 형식을 확인해야 합니다. 이름 유지로 저장해 주세요.");
  return key;
}

/** Run in the same DB transaction as the renamed admin link. */
export async function migrateSavedSubtitlePaths(sql: any, former: string, next: string) {
  const provider=former.split("/")[0].replace("_subtitles","");
  const bundles=await sql`SELECT user_id,anime_id,bundle_key FROM subtitle_bundle_assignments
    WHERE provider=${provider} FOR UPDATE`;
  for(const row of bundles) {
    const key=renamedSubtitleReference(String(row.bundle_key),former,next);
    if(key!==row.bundle_key)await sql`UPDATE subtitle_bundle_assignments SET bundle_key=${key},updated_at=CURRENT_TIMESTAMP
      WHERE user_id=${row.user_id} AND anime_id=${row.anime_id}`;
  }
  const episodes=await sql`SELECT user_id,anime_id,episode_number,file_id FROM subtitle_episode_overrides
    WHERE provider=${provider} FOR UPDATE`;
  for(const row of episodes) {
    const key=renamedSubtitleReference(String(row.file_id),former,next);
    if(key!==row.file_id)await sql`UPDATE subtitle_episode_overrides SET file_id=${key},updated_at=CURRENT_TIMESTAMP
      WHERE user_id=${row.user_id} AND anime_id=${row.anime_id} AND episode_number=${row.episode_number}`;
  }
  const choices=await sql`SELECT id,subtitle_url FROM reanime_subtitle_settings WHERE subtitle_url IS NOT NULL FOR UPDATE`;
  for(const row of choices) {
    const key=renamedSubtitleReference(String(row.subtitle_url),former,next);
    if(key!==row.subtitle_url)await sql`UPDATE reanime_subtitle_settings SET subtitle_url=${key},updated_at=CURRENT_TIMESTAMP
      WHERE id=${row.id}`;
  }
  const rejectionTable=await sql`SELECT to_regclass('public.anime_subtitle_rejections') AS name`;
  if(rejectionTable[0]?.name) {
    const rejected=await sql`SELECT anime_id,provider,source_key_hash,source_key FROM anime_subtitle_rejections FOR UPDATE`;
    for(const row of rejected) {
      const key=renamedSubtitleReference(String(row.source_key),former,next);
      if(key!==row.source_key)await sql`UPDATE anime_subtitle_rejections SET source_key=${key},
        source_key_hash=${createHash('sha256').update(key).digest('hex')}
        WHERE anime_id=${row.anime_id} AND provider=${row.provider} AND source_key_hash=${row.source_key_hash}`;
    }
  }
  // Nested ZIP links keep their own work IDs; FK updates their member paths.
  await sql`UPDATE anime_admin_subtitle_links SET relative_path=${next}||substring(relative_path from ${former.length+1})
    WHERE left(relative_path,${former.length+1})=${former+"/"}`;
}

/** Merging can change individual filenames. Only folders without saved pointers
 * may use that older upload path; renaming a whole folder can migrate them. */
export async function assertMergeHasNoSavedPaths(sql: any, former: string, next: string) {
  const provider=former.split("/")[0].replace("_subtitles","");
  const rows=await sql`SELECT bundle_key AS key FROM subtitle_bundle_assignments WHERE provider=${provider}
    UNION ALL SELECT file_id AS key FROM subtitle_episode_overrides WHERE provider=${provider}
    UNION ALL SELECT subtitle_url AS key FROM reanime_subtitle_settings WHERE subtitle_url IS NOT NULL`;
  if(rows.some((row:any)=>renamedSubtitleReference(String(row.key),former,next)!==row.key))
    throw new Error("저장된 자막 지정이 있는 폴더는 병합할 수 없습니다. 이름 유지로 DB를 연결해 주세요.");
  const nested=await sql`SELECT 1 FROM anime_admin_subtitle_links
    WHERE left(relative_path,${former.length+1})=${former+"/"} LIMIT 1`;
  if(nested.length)throw new Error("하위 ZIP 연결이 있는 폴더는 병합할 수 없습니다. 이름 유지로 연결해 주세요.");
}

/** Keep weekly provenance attached to the same bytes after a folder rename.
 * A DB failure restores this file too, without overwriting a concurrent edit. */
export async function migrateSubtitleSourcePaths(root: string, former: string, next: string) {
  const file=path.join(root,".weekly-subtitle-sources.json");
  let original:string;
  try {
    if((await stat(file)).size>32*1024*1024)throw new Error("자막 출처 목록이 너무 큽니다.");
    original=await readFile(file,"utf8");
  } catch(error:any) {if(error?.code==="ENOENT")return null;throw error;}
  const value=JSON.parse(original);
  if(value.version!==1 || !value.files || typeof value.files!=="object" || Array.isArray(value.files))
    throw new Error("자막 출처 목록을 확인해 주세요.");
  let changed=false;
  for(const key of Object.keys(value.files)) {
    if(key!==former && !key.startsWith(former+"/"))continue;
    const target=next+key.slice(former.length);
    if(Object.hasOwn(value.files,target))throw new Error("새 폴더 경로에 다른 자막 출처 기록이 있습니다.");
    value.files[target]=value.files[key];delete value.files[key];changed=true;
  }
  if(!changed)return null;
  const updated=JSON.stringify(value);
  async function replace(expected:string,replacement:string) {
    if(await readFile(file,"utf8")!==expected)throw new Error("자막 수집이 출처 목록을 변경했습니다. 잠시 후 다시 시도해 주세요.");
    const temporary=file+".rename-"+randomUUID();
    try {await writeFile(temporary,replacement,{flag:"wx"});await rename(temporary,file);}
    finally {await rm(temporary,{force:true}).catch(()=>{});}
  }
  await replace(original,updated);
  return ()=>replace(updated,original);
}
