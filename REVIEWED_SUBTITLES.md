# Reviewed subtitle registry

`scripts/update-anime-db-release.py` imports the canonical db-v1 catalog and its completed reviewed subtitle registry. Existing catalog digest state alone does not suppress the first registry import; the separate subtitle marker is written only after both importers succeed. Run `python3 scripts/import-reviewed-subtitles.py DATABASE --dry-run` to validate without applying, or run the existing release updater for normal imports into `anime_subtitle_*` tables.

The playback reader now queries current `work_confirmed`, `target_source`, `target_id` and eligible exact ReAnime links. It never promotes historical candidates or held work rows. Confirmed episode rows relevant to the file's current work take priority; unassigned files use the existing filename/season/start-episode algorithm without writing new episode rows. Multiple distinct candidates and unknown episodes require an explicit choice. Source priority remains AniAll/Anissia, with reviewed Naver as a local fallback before web lookup. Existing uploads and Anissia track preferences remain effective.

## Pi storage

Keep each cleaned work ZIP intact. Extract only the outer transfer ZIPs, such as `anime_aniall_part_01.zip`. Recommended host paths under `/home/pi/streaming-project/subtitle-data` are:

- `anissia_subtitles/`: existing folders, loose files and archives.
- `aniall_subtitles/`: cleaned `작품/...zip` and `미확정/...zip` plus ongoing weekly work folders.
- `naver_subtitles/`: cleaned `작품/...zip` and `미확정/...zip`.

`SUBTITLE_STORAGE_DIR` is `/app/data/subtitles` in the current container mount. Original `aniall/...` and `naver/...` layouts and an extra nested source directory also work. Flattened work ZIPs within either source folder can be found by basename and verified archive SHA-256; same-name files must not overwrite each other when copying. Nested-location lookup refreshes every minute. Exact registered paths are checked immediately.

ZIP paths containing `미확정` are physical locations, not current review status. The reader verifies both archive and exact member hashes, and keeps stable dataset/PID identities across moves and display-title changes. It decodes supported subtitle content even when an original suffix was truncated. Unsupported binary SUB files remain registered but do not fabricate playback content. Missing ZIPs or an unimported registry leave the existing readers available.

New weekly subtitles remain in the downloader's existing work folders; they do not need to be repacked into reviewed ZIPs. AniAll lookup now also accepts a loose file with unambiguous episode evidence. Weekly files are not inserted into the completed review registry by a playback request. Multiple loose variants remain unavailable to automatic selection; use the existing upload/manual subtitle workflow to choose an ambiguous new file.

Manual local search includes reviewed work titles and original archive/member names, including work-confirmed files with no ReAnime link. Searching or selecting a file does not assign a ReAnime ID or persist an episode. Native VTT lookup reads a selected reviewed PID only within its exact current work binding; a manually chosen file from an unlinked/different work is available through its embedded subtitle content, but does not gain a native VTT work binding.

Rejections of reviewed files use stable `reviewed:DATASET:PID` keys. Existing website-based AniAll rejections conservatively suppress the reviewed AniAll fallback for that work, because merged cleaned archives do not expose reliable creator URL provenance. Clearing that existing rejection restores the fallback. No existing rejection rows are rewritten.

Manually edited Postgres file rows remain protected by the importer, and confirmed episode rows are imported without reassignment. These code changes do not transfer ZIPs, delete old files, or deploy to the Pi. Copy and test the cleaned folders before removing an old AniAll copy.

## Validation

`npm run test:subtitles` exercises mixed archives, archive/member hashes, flattened paths, PID rejection, confirmed episodes, episode offsets, ambiguity, missing files, native VTT and loose weekly files. GitHub Actions additionally runs the reader's actual SQL against an isolated PostgreSQL service to exclude held files, ineligible links and unrelated historical episode mappings. The existing importer checks and production build also run in the same workflow.
