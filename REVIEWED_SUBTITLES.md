# Reviewed subtitle registry

## Weekly downloads

New Anissia downloads use `title/episode/creator` and reuse the existing exact title folder. File-level work IDs and original hashes are recorded in `.weekly-subtitle-sources.json`, including history backfill and Erulabo downloads. The reader accepts those IDs without requiring `finish.txt`. Existing plain-title and numbered folders remain readable.

New AniAll downloads use `blogTitle` and reuse that work folder. Post IDs and original file hashes remain in the same metadata file, so two posts with identical titles cannot select each other's files. Different same-name attachment bytes are preserved as separate variants; identical bytes reuse the existing file. An unresolved new post requires manual selection. Old numbered folders, untouched title-only corpus files and reviewed archive IDs remain supported.

The Pi weekly wrapper imports published AniAll mappings, then runs `scripts/match-weekly-aniall.py` against the current PostgreSQL catalog. Only successfully downloaded posts with exact file provenance (or the legacy numbered layout) that are absent from `subtitle-data/aniall-weekly-matching.json` are processed. The existing monthly matcher and protected importers decide exact matches and review candidates. Fuzzy scores never become automatic confirmations. The checkpoint includes unresolved decisions and is committed only after both imports succeed. Unresolved posts can still be reviewed by the monthly pipeline. No reviewed registry or confirmed episode row is changed.

For a preview: `python3 scripts/match-weekly-aniall.py --dry-run`. Both repositories must be updated before enabling the weekly service.

## Viewing cache cleanup

The 60-second viewing cache remains under `subtitle-data/verified`. The player skips local and already-cached subtitles. The cache endpoint also skips explicit local/cached flags. New web caches store source work identity, the configured source episode, season, and a digest of the decoded content and format.

When automatic playback finds a local subtitle, only caches for that same site work and episode with identical decoded content and format are deleted. Already-decoded playback content is reused, including legacy caches without digest metadata. Different variants, other works/episodes, and unconfirmed reviewed episodes remain untouched. Cached bytes are checked again before removal, and a short per-entry filesystem lock protects concurrent saves. No local subtitle, ZIP, reviewed registry, or episode DB row is changed.

Each new successful Pi download writes its exact paths to `.cache-cleanup-pending`. After weekly matching, the low-priority CLI checks only those files against cache metadata. It reuses the production decoder and episode parser; historical source directories are never scanned. ZIPs with no relevant cached work are not opened. Only hashes are retained while decoding. AniAll cleanup requires an exact current weekly work match; ambiguous/manual and legacy caches without source context are retained for playback cleanup. Failed jobs remain pending; successful outcomes are logged in `cache-cleanup-results.jsonl`.

The CLI is compiled during `npm run build` and copied into the image. Once the updated image is running, pending jobs can be resumed with `docker compose exec -T anime nice -n 15 node scripts/subtitle-cache/cleanup.cjs`. It needs no network requests or full DB import. Source directories, cache files, and migration backups are excluded from Docker build context.

`scripts/update-anime-db-release.py` imports the canonical db-v1 catalog and its completed reviewed subtitle registry. Existing catalog digest state alone does not suppress the first registry import; the separate subtitle marker is written only after both importers succeed. Run `python3 scripts/import-reviewed-subtitles.py DATABASE --dry-run` to validate without applying, or run the existing release updater for normal imports into `anime_subtitle_*` tables.

The playback reader now queries current `work_confirmed`, `target_source`, `target_id` and eligible exact ReAnime links. It never promotes historical candidates or held work rows. Confirmed episode rows relevant to the file's current work take priority; unassigned files use the existing filename/season/start-episode algorithm without writing new episode rows. Multiple distinct candidates and unknown episodes require an explicit choice. Source priority remains AniAll/Anissia, with reviewed Naver as a local fallback before web lookup. Existing uploads and Anissia track preferences remain effective.

## Pi storage

Keep each cleaned work ZIP intact. Extract only the outer transfer ZIPs, such as `anime_aniall_part_01.zip`. Recommended host paths under `/home/pi/streaming-project/subtitle-data` are:

- `anissia_subtitles/`: existing folders, loose files and archives.
- `aniall_subtitles/`: cleaned `작품/...zip` and `미확정/...zip` plus ongoing weekly work folders.
- `naver_subtitles/`: cleaned `작품/...zip` and `미확정/...zip`.

`SUBTITLE_STORAGE_DIR` is `/app/data/subtitles` in the current container mount. Original `aniall/...` and `naver/...` layouts and an extra nested source directory also work. Flattened work ZIPs within either source folder can be found by basename and verified archive SHA-256; same-name files must not overwrite each other when copying. Nested-location lookup refreshes every minute. Exact registered paths are checked immediately.

ZIP paths containing `미확정` are physical locations, not current review status. The reader verifies both archive and exact member hashes, and keeps stable dataset/PID identities across moves and display-title changes. It decodes supported subtitle content even when an original suffix was truncated. Unsupported binary SUB files remain registered but do not fabricate playback content. Missing ZIPs or an unimported registry leave the existing readers available.

New weekly subtitles remain in the downloader's existing work folders; they do not need to be repacked into reviewed ZIPs. AniAll lookup now also accepts a loose file with unambiguous episode evidence. Weekly files are not inserted into the completed review registry by a playback request. Multiple loose variants require a manual choice; a folder assignment remembers the selected variant for subsequent episodes.

Manual local search includes reviewed work titles and original archive/member names, including work-confirmed files with no ReAnime link. Searching or selecting a file does not assign a ReAnime ID or change a confirmed episode. Native VTT lookup reads a selected reviewed PID within its current work binding or an explicit user episode exception. A transient selection from another work remains available through its embedded content.

## User assignments and episode exceptions

Work assignments bind one original work/season/format slice, rather than claiming an entire ZIP. TV and OVA members in a mixed ZIP can be assigned independently. Raw download track keys include the physical work folder, so generic creator names and filenames cannot bind another work accidentally. Numbered episodes continue automatically within the selected slice. Different subtitle variants remain choices, and a bound file with unknown episode evidence still requires manual selection.

Unpacked AniAll and Anissia work folders can be assigned directly with `폴더 전체 지정`, without selecting an individual subtitle first. The format and season controls select the original folder slice; nested TV/OVA and season folders remain separate. Only explicit filename or folder episode evidence authorizes automatic playback, never alphabetical order or file count. AniAll scans the chosen folder's supported files and subfolders; Anissia reuses its cached index. Missing, changed, unnumbered or ambiguous files do not silently trigger a different source.

Choosing a raw folder file with `이 버전 계속` or `현재 화 선택 · 다음 화 유지` saves the same track within that folder, including the first selection before a separate folder assignment. `01.srt` follows `02.srt` and `03.srt`; `01__2.srt` follows `02__2.srt` and `03__2.srt`. Collision suffixes are variant labels, not episode numbers. If the chosen track is absent on a later episode, playback asks for reselection instead of switching versions. Assign the folder again to clear its preferred variant; episode exceptions still take priority. Ownership moves only the same user's overlapping original folder/season/format assignments and preserves other users and independent slices. Current-episode recommendations contain only files with confirmed evidence for the requested episode; explicit local search keeps other/unknown episodes available for exceptions. Both players and the open recommendation list refresh when settings are saved. A saved, available numbered track plays automatically across episodes without reopening the choice dialog.

Both the work settings and playback subtitle picker provide `예외 만들기`. Choose an exact file and the target site episode; it overrides the work assignment only on that episode. `예외 해제` restores the normal selection. Raw files use relative path, exact archive member and original content hash; reviewed files retain dataset/PID identity and registry hash checks. Missing or changed assigned files show a reselection notice without silently falling back to another subtitle. Manual search remains available for choosing a replacement.

These settings belong to the signed-in user and are stored in `subtitle_bundle_assignments` and `subtitle_episode_overrides`. Playback does not modify catalog matches, the reviewed registry, confirmed episode rows or source subtitle files. Legacy whole-ZIP/track assignments remain stored, but require one explicit reselection because their work/format scope cannot be inferred safely.

Rejections of reviewed files use stable `reviewed:DATASET:PID` keys. Existing website-based AniAll rejections conservatively suppress the reviewed AniAll fallback for that work, because merged cleaned archives do not expose reliable creator URL provenance. Clearing that existing rejection restores the fallback. No existing rejection rows are rewritten.

Manually edited Postgres file rows remain protected by the importer, and confirmed episode rows are imported without reassignment. These code changes do not transfer ZIPs, delete old files, or deploy to the Pi. Copy and test the cleaned folders before removing an old AniAll copy.

## Validation

`npm run test:subtitles` exercises mixed archives, archive/member hashes, flattened paths, PID rejection, confirmed episodes, episode offsets, ambiguity, missing files, native VTT and loose weekly files. It also checks independent TV/OVA assignments, successive episodes, exact-file exceptions, removal, missing-file notices and user isolation. GitHub Actions runs actual PostgreSQL queries and settings writes, comparing only the fixture rows involved to verify reviewed work links and confirmed episodes remain unchanged. The existing importer checks and production build also run in the same workflow.
