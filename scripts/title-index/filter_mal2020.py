#!/usr/bin/env python3
"""Filter the MAL 2020 anime.csv to 2000-2020 anime work records.

The script keeps title/format/episode metadata only, not user-rating fields.
It preserves MAL's Name column as `mal_title` (not assumed to be romaji).
"""
import csv
import re
import sys
from collections import Counter
from pathlib import Path

YEAR_RE = re.compile(r"\b((?:19|20)\d{2})\b")
ALLOWED_TYPES = {"TV", "Movie", "OVA", "ONA", "Special"}
START_YEAR = 2000
END_YEAR = 2026  # current year for this snapshot (2026-09-27)


def get_year(row):
    aired = (row.get("Aired") or "").strip()
    match = YEAR_RE.search(aired)
    if match:
        return int(match.group(1)), "Aired"
    premiered = (row.get("Premiered") or "").strip()
    match = YEAR_RE.search(premiered)
    if match:
        return int(match.group(1)), "Premiered"
    return None, None


def clean(value):
    value = (value or "").strip()
    return None if not value or value.casefold() in {"unknown", "n/a", "none"} else value


def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit("usage: filter_mal2020.py INPUT.csv OUTPUT.csv [UNDATED_REVIEW.csv]")
    source, output = map(Path, sys.argv[1:3])
    kept = []
    undated = []
    counts = Counter()
    with source.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            counts["source_rows"] += 1
            kind = (row.get("Type") or "").strip()
            if kind == "Music":
                counts["excluded_music"] += 1
                continue
            if kind not in ALLOWED_TYPES:
                counts["excluded_unknown_format"] += 1
                continue
            year, year_source = get_year(row)
            if year is None:
                counts["excluded_unknown_year"] += 1
                undated.append({
                    "mal_id": clean(row.get("MAL_ID")), "mal_title": clean(row.get("Name")),
                    "english_title": clean(row.get("English name")), "japanese_title": clean(row.get("Japanese name")),
                    "format": kind, "episodes": clean(row.get("Episodes")),
                    "aired_raw": clean(row.get("Aired")), "premiered_raw": clean(row.get("Premiered")),
                    "source": "Hernan4444/MyAnimeList-Database, anime.csv (2020 snapshot)",
                })
                continue
            if not START_YEAR <= year <= END_YEAR:
                counts["excluded_out_of_range"] += 1
                continue
            kept.append({
                "mal_id": clean(row.get("MAL_ID")),
                "year": year,
                "year_source": year_source,
                "season": clean(row.get("Premiered")),
                "format": kind,
                "episodes": clean(row.get("Episodes")),
                "mal_title": clean(row.get("Name")),
                "english_title": clean(row.get("English name")),
                "japanese_title": clean(row.get("Japanese name")),
                "source": "Hernan4444/MyAnimeList-Database, anime.csv (2020 snapshot)",
            })
    kept.sort(key=lambda r: (int(r["year"]), r["mal_id"] or ""))
    output.parent.mkdir(parents=True, exist_ok=True)
    fields = ["mal_id", "year", "year_source", "season", "format", "episodes", "mal_title", "english_title", "japanese_title", "source"]
    with output.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(kept)
    if len(sys.argv) >= 4:
        review_path = Path(sys.argv[3])
        review_fields = ["mal_id", "mal_title", "english_title", "japanese_title", "format", "episodes", "aired_raw", "premiered_raw", "source"]
        with review_path.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=review_fields)
            writer.writeheader()
            writer.writerows(undated)
        print(f"undated_review_rows={len(undated)} output={review_path}")
    print(f"source_rows={counts['source_rows']}")
    print(f"kept_rows={len(kept)}")
    print(f"year_range={START_YEAR}-{END_YEAR} (inclusive; Aired, Premiered fallback)")
    print(f"excluded_music={counts['excluded_music']}")
    print(f"excluded_unknown_format={counts['excluded_unknown_format']}")
    print(f"excluded_unknown_year={counts['excluded_unknown_year']}")
    print(f"excluded_out_of_range={counts['excluded_out_of_range']}")
    print("formats=" + repr(dict(Counter(r["format"] for r in kept))))
    print(f"english_title_present={sum(bool(r['english_title']) for r in kept)}")
    print(f"japanese_title_present={sum(bool(r['japanese_title']) for r in kept)}")
    print(f"output={output}")


if __name__ == "__main__":
    main()
