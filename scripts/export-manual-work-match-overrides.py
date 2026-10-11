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
REANIME_QUERY = """
SELECT json_build_object(
  'reanime_id', reanime_id,
  'anissia_no', anissia_no
)::text
FROM anime_work_match_overrides
ORDER BY reanime_id;
"""
ANIKOTO_QUERY = """
SELECT json_build_object(
  'anikoto_id', anikoto_id,
  'anissia_no', anissia_no,
  'mapping_kind', mapping_kind,
  'anikoto_episode_start', anikoto_episode_start,
  'anikoto_episode_end', anikoto_episode_end,
  'target_episode_start', target_episode_start,
  'target_episode_end', target_episode_end
)::text
FROM anime_anikoto_work_overrides
ORDER BY anissia_no;
"""


def query_rows(project, query, runner):
    command = [
        "docker", "compose", "exec", "-T", "db", "sh", "-c",
        'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
        "sh", query,
    ]
    result = runner(command, cwd=project, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("Cannot read Pi manual DB work matches: " + result.stderr[:240])
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def export_rows(project: pathlib.Path, runner=subprocess.run):
    records = query_rows(project, REANIME_QUERY, runner)
    found = []
    reanime_seen, anissia_seen = set(), set()
    for record in records:
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
    anikoto = query_rows(project, ANIKOTO_QUERY, runner)
    used_ani, used_ak = set(), set()
    validated_ak = []
    for row in anikoto:
        cols = {"anikoto_id", "anissia_no", "mapping_kind",
                "anikoto_episode_start", "anikoto_episode_end",
                "target_episode_start", "target_episode_end"}
        if not isinstance(row, dict) or set(row) != cols:
            raise ValueError("Unexpected manual Anikoto work match row")
        aid, akid = row["anissia_no"], row["anikoto_id"]
        if (type(aid) is not int or not 1 <= aid <= 2147483647
                or not isinstance(akid, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,199}", akid)
                or aid in used_ani or akid in used_ak):
            raise ValueError("Invalid or conflicting manual Anikoto work IDs")
        used_ani.add(aid); used_ak.add(akid)
        kind = row["mapping_kind"]
        values = [row[k] for k in ("anikoto_episode_start", "anikoto_episode_end",
                                   "target_episode_start", "target_episode_end")]
        if kind == "whole":
            if any(v is not None for v in values):
                raise ValueError("Whole Anikoto match must not assign episode ranges")
        elif kind == "range":
            if (any(type(v) is not int or not 1 <= v <= 10000 for v in values)
                    or values[1] < values[0] or values[3] < values[2]
                    or values[1] - values[0] != values[3] - values[2]):
                raise ValueError("Invalid Anikoto season range")
        else:
            raise ValueError("Unknown Anikoto season mapping kind")
        validated_ak.append(row)
        if len(validated_ak) > 20000:
            raise ValueError("Manual Anikoto match export limit exceeded")
    return {"reanime": sorted(found, key=lambda item: item["reanime_id"]),
            "anikoto": sorted(validated_ak, key=lambda item: item["anissia_no"])}


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parents[1]
    print(json.dumps(export_rows(root), ensure_ascii=False, separators=(",", ":")))
