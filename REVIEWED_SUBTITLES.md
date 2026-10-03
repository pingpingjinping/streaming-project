# Reviewed subtitle registry

`scripts/update-anime-db-release.py` imports the canonical db-v1 catalog and, when present, its completed reviewed subtitle registry. Existing catalog digest state alone does not suppress the first registry import; a separate subtitle marker is written only after both importers succeed.

The registry uses stable `pid`, original file IDs, `pack_id`, `zip_relative_path` and `member_path`. ZIP paths including `미확정` are physical locations, not current review status. Use `work_confirmed`, `target_source`, `target_id` and `reanime_id` to read the current decision. Manually edited Postgres subtitle rows are preserved. Confirmed episode rows are inserted without reassignment.

Run `python3 scripts/import-reviewed-subtitles.py DATABASE --dry-run` to validate without applying. For normal updates, run the existing release updater from this repository root. It imports into `anime_subtitle_*` tables. The local subtitle storage and playback reader must use these tables; this change does not transfer subtitle ZIPs or deploy to a Raspberry Pi.
