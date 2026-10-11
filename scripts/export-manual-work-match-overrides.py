#!/usr/bin/env python3
"""Read the administrator's explicit ReAnime/Anissia work overrides for monthly DB.

These are work-to-work ID corrections, NOT subtitle-file attachments. Export no
administrator identities, local paths, episode choices, stream URLs or tokens.
An empty successful query is a valid intentional full snapshot (after resets).
"""
import json
import pathlib
import re
import subprocess

REANIME_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{0,199}$")
QUERY = """
SELECT json_build_object(
  'reanime_id', reanime_id,
  'anissia_no', anissia_no
)::text
FROM anime_work_match_overrides
ORDER BY reanime_id;
"""


def export_rows(project: pathlib.Path, runner=subprocess.run):
    command = [
        "docker", "compose", "exec", "-T", "db", "sh", "-c",
        'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
        "sh", QUERY,
    ]
    result = runner(command, cwd=project, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("Cannot read Pi manual DB work matches: " + result.stderr[:240])
    found = []
    reanime_seen, anissia_seen = set(), set()
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if not isinstance(record, dict) or set(record) != {"reanime_id", "anissia_no"}:
            raise ValueError("Unexpected manual work match row")
        rid, aid = record["reanime_id"], record["anissia_no"]
        if (not isinstance(rid, str) or not REANIME_ID.fullmatch(rid)
                or type(aid) is not int or not 1 <= aid <= 2147483647):
            raise ValueError("Invalid manual ReAnime/Anissia work ID")
        if rid in reanime_seen or aid in anissia_seen:
            raise ValueError("Conflicting manual work matches")
        reanime_seen.add(rid)
        anissia_seen.add(aid)
        found.append({"reanime_id": rid, "anissia_no": aid})
        if len(found) > 20000:
            raise ValueError("Manual work match export limit exceeded")
    return sorted(found, key=lambda item: item["reanime_id"])


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parents[1]
    print(json.dumps(export_rows(root), ensure_ascii=False, separators=(",", ":")))
