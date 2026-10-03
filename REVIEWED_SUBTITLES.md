# Reviewed subtitle registry

## Weekly downloads

New Anissia downloads use `animeNo__title/episode/creator`; the reader accepts the work ID without requiring `finish.txt`, and refuses mismatching explicit IDs. Existing plain-title folders remain supported.

New AniAll downloads use `postId__blogTitle`, isolating same-title posts. Numbered folders require the actual matched post URL; an unresolved post cannot bypass review via the title-only fallback. Old title-only folders and reviewed archive IDs remain supported.

The Pi weekly wrapper imports published AniAll mappings, then runs `scripts/match-weekly-aniall.py` against the current PostgreSQL catalog. Only successfully downloaded posts in the new numbered layout that are absent from `subtitle-data/aniall-weekly-matching.json` are processed. The existing monthly matcher and protected importers decide exact matches and review candidates. Fuzzy scores never become automatic confirmations. The checkpoint includes unresolved decisions and is committed only after both imports succeed. Unresolved posts can still be reviewed by the monthly pipeline. No reviewed registry or confirmed episode row is changed.

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

New weekly subtitles remain in the downloader's existing work folders; they do not need to be repacked into reviewed ZIPs. AniAll lookup now also accepts a loose file with unambiguous episode evidence. Weekly files are not inserted into the completed review registry by a playback request. Multiple loose variants remain unavailable to automatic selection; use the existing upload/manual subtitle workflow to choose an ambiguous new file.

Manual local search includes reviewed work titles and original archive/member names, including work-confirmed files with no ReAnime link. Searching or selecting a file does not assign a ReAnime ID or persist an episode. Native VTT lookup reads a selected reviewed PID only within its exact current work binding; a manually chosen file from an unlinked/different work is available through its embedded subtitle content, but does not gain a native VTT work binding.

Rejections of reviewed files use stable `reviewed:DATASET:PID` keys. Existing website-based AniAll rejections conservatively suppress the reviewed AniAll fallback for that work, because merged cleaned archives do not expose reliable creator URL provenance. Clearing that existing rejection restores the fallback. No existing rejection rows are rewritten.

Manually edited Postgres file rows remain protected by the importer, and confirmed episode rows are imported without reassignment. These code changes do not transfer ZIPs, delete old files, or deploy to the Pi. Copy and test the cleaned folders before removing an old AniAll copy.

## Validation

`npm run test:subtitles` exercises mixed archives, archive/member hashes, flattened paths, PID rejection, confirmed episodes, episode offsets, ambiguity, missing files, native VTT and loose weekly files. GitHub Actions additionally runs the reader's actual SQL against an isolated PostgreSQL service to exclude held files, ineligible links and unrelated historical episode mappings. The existing importer checks and production build also run in the same workflow.
