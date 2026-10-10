#!/usr/bin/env python3
"""Produce a private-path-free snapshot of explicitly saved Pi subtitle work links.

The only data written to stdout is a JSON array containing source IDs,
reviewed title, kind and season. It must never emit local filenames, usernames
or account information. This is a *read-only* operation.
"""
import json
import pathlib
import subprocess
import sys

QUERY = """
SELECT json_build_object(
  'members', array_prepend(l.anime_id,
    COALESCE((SELECT array_agg(m.anime_id ORDER BY m.anime_id)
      FROM anime_admin_subtitle_link_members m
      WHERE m.relative_path=l.relative_path), ARRAY[]::text[])),
  'title', l.work_title, 'kind', l.subtitle_kind, 'season', l.season
)::text
FROM anime_admin_subtitle_links l
ORDER BY l.anime_id, l.relative_path;
"""


def export_rows(project: pathlib.Path, runner=subprocess.run):
    command = [
        "docker", "compose", "exec", "-T", "db", "sh", "-c",
        'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
        "sh", QUERY,
    ]
    result = runner(command, cwd=project, text=True, capture_output=True)
    if result.returncode:
        # No silent empty export on database or schema failures.
        raise RuntimeError("Cannot read reviewed Pi subtitle DB links: " + result.stderr[:280])
    output = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict) or set(row) != {"members", "title", "kind", "season"}:
            raise ValueError("Unexpected reviewed link query shape")
        members = row["members"]
        if not isinstance(members, list) or any(not isinstance(m, str) for m in members):
            raise ValueError("Invalid reviewed work IDs")
        if not isinstance(row["title"], str):
            raise ValueError("Invalid reviewed work title")
        if not isinstance(row["season"], int) or isinstance(row["season"], bool):
            raise ValueError("Invalid reviewed season")
        output.append(row)
    return output


def main():
    root = pathlib.Path(__file__).resolve().parents[1]
    print(json.dumps(export_rows(root), ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
