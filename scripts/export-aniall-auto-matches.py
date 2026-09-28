#!/usr/bin/env python3
"""Match newly published AniAll posts against the refreshed DB each month."""
import argparse
import json
from pathlib import Path

MIN_REVIEW_SCORE = 85


def export(audit, reviewed):
    reviewed_ids = {str(item["postId"]) for item in reviewed if item.get("postId")}
    rows = []
    for post in audit:
        post_id = str(post.get("post_id", ""))
        title = str(post.get("matched_title") or "").strip()
        if (not post_id.isdigit() or post_id in reviewed_ids or
                post.get("match_kind") != "exact" or not title or
                post.get("post_season_range")):
            continue
        rows.append({"postId": post_id, "blogTitle": post["title"],
                     "postUrl": post["post_url"], "confidence": 100,
                     "reviewStatus": "auto_exact", "candidateTitle": title,
                     "evidence": "Monthly full crawl: exact title and compatible season/year/format",
                     "source": "", "sourceId": ""})
    return rows


def candidate_rows(audit, reviewed):
    reviewed_ids = {str(item["postId"]) for item in reviewed if item.get("postId")}
    rows = []
    for post in audit:
        post_id = str(post.get("post_id", ""))
        kind = post.get("match_kind")
        if (not post_id.isdigit() or post_id in reviewed_ids or
                kind not in ("fuzzy_high", "fuzzy_review", "title_exact_review", "unmatched")):
            continue
        options = post.get("candidate_details") or []
        if not options and kind in ("fuzzy_high", "fuzzy_review") and post.get("matched_title"):
            options = [{"title": post["matched_title"], "score": post.get("adjusted_score") or post.get("score") or 0}]
        seen = set()
        for option in options[:8]:
            title = str(option.get("title") or "").strip()
            score = round(float(option.get("adjusted_score") or option.get("score") or 0))
            if score < MIN_REVIEW_SCORE or not title or title in seen:
                continue
            seen.add(title)
            rows.append({"postId": post_id, "blogTitle": post["title"],
                         "postUrl": post["post_url"], "candidateTitle": title,
                         "confidence": min(100, score), "reviewStatus": "auto_candidate",
                         "evidence": f"{kind}; title/year/season/format require review"})
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audit", type=Path)
    parser.add_argument("reviewed", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    audit = json.loads(args.audit.read_text(encoding="utf-8"))
    reviewed = json.loads(args.reviewed.read_text(encoding="utf-8"))
    rows = export(audit, reviewed)
    args.output.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    candidates = candidate_rows(audit, reviewed)
    args.output.with_name("aniall-candidates.json").write_text(
        json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Exported {len(rows)} exact matches and {len(candidates)} scored review candidates.")


if __name__ == "__main__":
    main()
