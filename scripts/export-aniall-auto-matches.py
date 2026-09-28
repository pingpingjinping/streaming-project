#!/usr/bin/env python3
"""Export new, unambiguous AniAll posts from a complete monthly audit."""
import argparse
import json
from pathlib import Path


def export(audit, reviewed):
    previous = {int(item["postId"]) for item in reviewed if str(item.get("postId", "")).isdigit()}
    boundary = max(previous, default=0)
    rows = []
    for post in audit:
        post_id = str(post.get("post_id", ""))
        title = str(post.get("matched_title") or "").strip()
        if (not post_id.isdigit() or int(post_id) <= boundary or
                post.get("match_kind") != "exact" or not title or
                post.get("post_season_range")):
            continue
        rows.append({"postId": post_id, "blogTitle": post["title"],
                     "postUrl": post["post_url"], "confidence": 100,
                     "reviewStatus": "auto_exact", "candidateTitle": title,
                     "evidence": "Monthly full crawl: exact title and compatible season/year/format",
                     "source": "", "sourceId": ""})
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audit", type=Path)
    parser.add_argument("reviewed", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    rows = export(json.loads(args.audit.read_text(encoding="utf-8")),
                  json.loads(args.reviewed.read_text(encoding="utf-8")))
    args.output.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Exported {len(rows)} new exact AniAll matches; ambiguous posts remain in audit artifact.")


if __name__ == "__main__":
    main()
