#!/usr/bin/env python3
"""Read exact-ID manual Korean names; export no local paths or account details."""
import json
import pathlib
import re
import subprocess

WORK_ID = re.compile(r"^(?:ani_[1-9]\d*|re_[A-Za-z0-9_-]+|ak_[A-Za-z0-9_-]+|db_(?:AniList|Onnada)_[A-Za-z0-9_-]+)$")


def export_rows(project, runner=subprocess.run):
    def query(sql):
        result = runner([
            "docker", "compose", "exec", "-T", "db", "sh", "-c",
            'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
            "sh", sql,
        ], cwd=project, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError("Cannot export manual Korean names: " + result.stderr[:240])
        return result.stdout.strip()
    if not query("SELECT to_regclass('public.anime_admin_work_titles');"):
        return []
    raw = query("SELECT json_build_object('anime_id',anime_id,'canonical_id',canonical_id,'title',korean_title)::text "
                "FROM anime_admin_work_titles ORDER BY anime_id;")
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) not in ({"anime_id", "title"}, {"anime_id", "canonical_id", "title"}):
            raise ValueError("Unexpected manual title export fields")
        aid, title = row["anime_id"], row["title"]
        canonical=row.get("canonical_id",aid)
        if (not isinstance(aid, str) or len(aid) > 150 or not WORK_ID.fullmatch(aid)
                or not isinstance(canonical,str) or len(canonical)>150 or not WORK_ID.fullmatch(canonical)
                or aid in seen or not isinstance(title, str) or not 0 < len(title) <= 300
                or not re.search("[가-힣]", title) or any(ord(c) < 32 or ord(c) == 127 for c in title)):
            raise ValueError("Invalid manual Korean work name")
        seen.add(aid)
    if len(rows) > 30000:
        raise ValueError("Manual title export limit exceeded")
    return rows


if __name__ == "__main__":
    print(json.dumps(export_rows(pathlib.Path(__file__).resolve().parents[1]), ensure_ascii=False))
