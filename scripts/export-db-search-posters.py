#!/usr/bin/env python3
"""Read-only Pi PostgreSQL export of verified artwork URL cache (no user data).

This runs during the existing 1st-day 03:00 Pi DB review preparation.
The output intentionally excludes paths, account data, and cache misses.
"""
import json
import pathlib
import re
import subprocess
from urllib.parse import urlsplit

WORK_ID = re.compile(r"^(?:ani_\d+|re_[A-Za-z0-9_-]+|ak_[A-Za-z0-9_-]+|db_(?:AniList|Onnada)_[A-Za-z0-9_-]+)$")
SOURCES = {"ReAnime", "AniList", "Anikoto"}
QUERY = """
SELECT json_build_object('work_id',work_id,'poster',poster,'source',source)::text
FROM anime_search_poster_cache
WHERE poster <> '' AND expires_at > NOW()
ORDER BY work_id LIMIT 30000;
"""


def sanitize(rows):
    result = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"work_id", "poster", "source"}:
            raise ValueError("Unexpected Pi cached artwork fields")
        work_id, poster, source = row["work_id"], row["poster"], row["source"]
        if not isinstance(work_id, str) or not WORK_ID.fullmatch(work_id) or len(work_id) > 180:
            raise ValueError("Invalid cached work ID")
        if source not in SOURCES:
            raise ValueError("Invalid cached poster source")
        if not isinstance(poster, str) or len(poster) > 2048:
            raise ValueError("Invalid cached poster URL")
        parsed = urlsplit(poster)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Unsafe cached poster URL")
        result.append({"work_id": work_id, "poster": poster, "source": source})
    return result


def export_rows(project, runner=subprocess.run):
    script = 'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"'
    cmd = ["docker", "compose", "exec", "-T", "db", "sh", "-c", script, "sh", QUERY]
    response = runner(cmd, cwd=project, capture_output=True, text=True)
    if response.returncode:
        if 'relation "anime_search_poster_cache" does not exist' in response.stderr:
            return []  # Before any artwork request there is no cache table.
        raise RuntimeError("Failed to export cached artwork: " + response.stderr[:300])
    return sanitize([json.loads(line) for line in response.stdout.splitlines() if line.strip()])


if __name__ == "__main__":
    print(json.dumps(export_rows(pathlib.Path(__file__).resolve().parents[1]), ensure_ascii=False,
                     separators=(",", ":")))
