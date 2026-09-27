#!/usr/bin/env python3
"""Audit aniall Tistory subtitle posts against the reviewed four-source anime DB.

This script does NOT change the app or Postgres. It only:
1) crawls the aniall subtitle-category index,
2) extracts post titles/URLs,
3) compares them with the existing reviewed four-source catalog/aliases,
4) writes JSON + CSV audit reports.

Run from repository root:
  python3 scripts/audit-aniall-subtitles.py ./anime_four_sources_multilingual_prepared.db

Optional:
  python3 scripts/audit-aniall-subtitles.py ./anime_four_sources_multilingual_prepared.db --delay 0.2
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import math
import re
import sqlite3
import sys
import time
import unicodedata
from collections import defaultdict
from difflib import SequenceMatcher
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from catalog_core import build_catalog

BASE = "https://aniall.tistory.com"
CATEGORY_NAME = "자막자료실"
CATEGORY_URL = BASE + "/category/" + quote(CATEGORY_NAME)
UA = "Mozilla/5.0 (compatible; streaming-project subtitle audit/1.0)"

TECH_WORDS = (
    "1080p", "720p", "2160p", "480p", "x264", "x265", "hevc", "avc",
    "aac", "flac", "webrip", "web-dl", "web.", "bdrip", "bd ", "bluray",
    "blu-ray", "remux", "10bit", "8bit", "10-bit", "8-bit", "dual-audio",
    "multi-subs", "batch", "at-x", "bs11", "tx ", "cs", "uhd", "hdr",
    "dts", "mkv", "h264", "h265", "yuv", "raws", "subplease",
)


def norm_space(s: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", s or "").strip().lower().split())


def compact_key(s: str) -> str:
    s = norm_space(s)
    return "".join(ch for ch in s if ch.isalnum() or ("가" <= ch <= "힣"))


def strip_release_prefix(s: str) -> str:
    s = html.unescape(unicodedata.normalize("NFKC", s or "")).strip()
    # Repeated release-group prefixes such as [Ohys-Raws] [UQW]
    while True:
        n = re.sub(r"^\s*\[[^\]]{1,80}\]\s*", "", s, count=1)
        if n == s:
            return s
        s = n


def looks_technical(chunk: str) -> bool:
    low = norm_space(chunk)
    if any(x in low for x in TECH_WORDS):
        return True
    if re.search(r"\b(?:tv|ova|ona|sp|movie)\s*(?:\+|$)", low):
        return True
    if re.search(r"\b(?:s\d{1,2}|season\s*\d+)\b", low) and len(low) < 40:
        # Keep season text available as another variant, but allow a stripped fallback.
        return True
    return False


def title_variants(raw: str) -> list[str]:
    s = strip_release_prefix(raw)
    s = re.sub(r"_?자막\s*$", "", s, flags=re.I).strip()
    s = re.sub(r"\s+_?subtitle\s*$", "", s, flags=re.I).strip()
    if not s:
        return []

    out: list[str] = []

    def add(x: str):
        x = x.strip(" -_[]()")
        if len(compact_key(x)) >= 2 and x not in out:
            out.append(x)

    add(s)

    # Remove only bracket/paren groups that look like release/encoding metadata.
    stripped = re.sub(
        r"([\[(])([^\])]{1,120})([\])])",
        lambda m: " " if looks_technical(m.group(2)) else m.group(0),
        s,
    )
    stripped = re.sub(r"\s+", " ", stripped).strip()
    add(stripped)

    # Cut at first technical bracket if it starts the metadata tail.
    m = re.search(r"\s+[\[(]([^\])]{1,120})[\])]", s)
    if m and looks_technical(m.group(1)):
        add(s[: m.start()])

    # Common format: Korean title (year) - Romaji/English title (release metadata)
    for part in re.split(r"\s+-\s+", stripped):
        add(part)

    # Parenthesized alternate title/year can be useful.
    for inner in re.findall(r"\(([^()]{2,100})\)", stripped):
        if not looks_technical(inner):
            add(inner)

    # Season-free fallback, only after season-aware variants.
    seasonless = re.sub(r"\b(?:season\s*0*\d+|s\s*-?\s*0*\d+)\b", " ", stripped, flags=re.I)
    seasonless = re.sub(r"\s+", " ", seasonless).strip()
    add(seasonless)

    # Release suffixes that frequently remain after removing brackets.
    simple = re.sub(
        r"\b(?:tv|ova|ona|sp|movie)\s*(?:\+\s*(?:tv|ova|ona|sp|movie))*\b",
        " ",
        seasonless,
        flags=re.I,
    )
    simple = re.sub(r"\s+", " ", simple).strip(" -")
    add(simple)
    return out


class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._parts: list[str] = []
        self.text_parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "a":
            d = dict(attrs)
            self._href = d.get("href")
            self._parts = []

    def handle_data(self, data):
        if data:
            self.text_parts.append(data)
            if self._href is not None:
                self._parts.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "a" and self._href is not None:
            text = " ".join(" ".join(self._parts).split())
            self.links.append((self._href, text))
            self._href = None
            self._parts = []


def fetch(url: str, retries: int = 3) -> str:
    err = None
    for attempt in range(retries):
        try:
            req = Request(url, headers={"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7"})
            with urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", errors="replace")
        except (HTTPError, URLError, TimeoutError) as exc:
            err = exc
            if attempt + 1 < retries:
                time.sleep(1.0 + attempt)
    raise RuntimeError(f"Failed to fetch {url}: {err}")


def numeric_post_id(href: str) -> str | None:
    href = html.unescape(href or "")
    m = re.match(r"^(?:https?://aniall\.tistory\.com)?/(\d+)(?:[/?#].*)?$", href)
    return m.group(1) if m else None


def expected_count_and_pages(first_html: str) -> tuple[int | None, int | None]:
    parser = LinkParser()
    parser.feed(first_html)
    text = " ".join(parser.text_parts)
    m = re.search(r"'?자막자료실'?\s*에\s*해당되는\s*글\s*([\d,]+)건", text)
    if not m:
        m = re.search(r"자막자료실[^\d]{0,80}([\d,]+)건", text)
    if not m:
        return None, None
    count = int(m.group(1).replace(",", ""))
    return count, math.ceil(count / 10)


def extract_page_posts(page_html: str, limit: int = 10) -> list[dict]:
    parser = LinkParser()
    parser.feed(page_html)
    found: list[dict] = []
    seen = set()

    # The category page begins with a 10-item post index. Taking the first
    # ten unique numeric post links avoids later "other posts" duplicates.
    for href, text in parser.links:
        pid = numeric_post_id(href)
        if not pid or pid in seen:
            continue
        title = html.unescape(text).strip()
        if len(compact_key(title)) < 2 or title.isdigit():
            continue
        seen.add(pid)
        found.append({
            "post_id": pid,
            "post_url": f"{BASE}/{pid}",
            "title": title,
        })
        if len(found) >= limit:
            break
    return found


def build_reference_index(db: sqlite3.Connection):
    catalog, aliases = build_catalog(db)
    exact = defaultdict(set)
    display_alias = {}

    def add(alias: str, korean: str):
        k = compact_key(alias)
        if len(k) < 2:
            return
        exact[k].add(korean)
        display_alias.setdefault((k, korean), alias)

    for row in catalog:
        ko = row["title"]
        add(ko, ko)
        add(row.get("nativeTitle") or "", ko)
        add(row.get("englishTitle") or "", ko)
    for _normalized, alias, korean in aliases:
        add(alias, korean)

    # Trigram inverted index for fuzzy review candidates.
    trigram = defaultdict(set)
    keys = list(exact)
    for i, k in enumerate(keys):
        grams = {k[j:j+3] for j in range(max(1, len(k)-2))} if len(k) >= 3 else {k}
        for g in grams:
            trigram[g].add(i)
    return catalog, exact, display_alias, keys, trigram


def fuzzy_best(query: str, exact, display_alias, keys, trigram):
    q = compact_key(query)
    if len(q) < 3:
        return None
    grams = {q[j:j+3] for j in range(len(q)-2)}
    counts = defaultdict(int)
    for g in grams:
        for idx in trigram.get(g, ()):
            counts[idx] += 1
    if not counts:
        return None

    # Only score the most overlapping aliases.
    candidates = sorted(counts, key=counts.get, reverse=True)[:100]
    ranked = []
    for idx in candidates:
        k = keys[idx]
        ratio = SequenceMatcher(None, q, k).ratio()
        # Mild containment bonus for titles with release/season residue.
        if q in k or k in q:
            ratio = min(1.0, ratio + 0.04)
        for korean in exact[k]:
            ranked.append((ratio, korean, display_alias.get((k, korean), k)))
    ranked.sort(reverse=True)
    if not ranked:
        return None
    best = ranked[0]
    second_score = next((x[0] for x in ranked[1:] if x[1] != best[1]), 0.0)
    return {
        "score": round(best[0] * 100, 1),
        "matched_title": best[1],
        "matched_alias": best[2],
        "margin": round((best[0] - second_score) * 100, 1),
    }


def match_post(title: str, exact, display_alias, keys, trigram):
    variants = title_variants(title)

    ambiguous = []
    for v in variants:
        k = compact_key(v)
        hits = exact.get(k)
        if not hits:
            continue
        if len(hits) == 1:
            korean = next(iter(hits))
            return {
                "match_kind": "exact",
                "matched_title": korean,
                "matched_alias": display_alias.get((k, korean), v),
                "score": 100.0,
                "variant": v,
            }
        ambiguous.append((v, sorted(hits)))

    best = None
    for v in variants:
        f = fuzzy_best(v, exact, display_alias, keys, trigram)
        if f and (best is None or f["score"] > best["score"]):
            best = dict(f, variant=v)

    if best and best["score"] >= 90 and best["margin"] >= 4:
        best["match_kind"] = "fuzzy_high"
        return best
    if best and best["score"] >= 82:
        best["match_kind"] = "fuzzy_review"
        return best
    if ambiguous:
        return {
            "match_kind": "ambiguous_exact",
            "matched_title": " / ".join(ambiguous[0][1][:5]),
            "matched_alias": ambiguous[0][0],
            "score": 100.0,
            "variant": ambiguous[0][0],
        }
    return {
        "match_kind": "unmatched",
        "matched_title": "",
        "matched_alias": "",
        "score": best["score"] if best else 0.0,
        "variant": best["variant"] if best else (variants[0] if variants else title),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db", help="anime_four_sources_multilingual_prepared.db")
    ap.add_argument("--delay", type=float, default=0.12, help="delay between category page requests")
    ap.add_argument("--max-pages", type=int, default=0, help="0 = auto-detect/all")
    ap.add_argument("--out-dir", default="tmp/aniall-audit")
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_path = out_dir / "aniall_posts.json"
    json_path = out_dir / "aniall_match_report.json"
    csv_path = out_dir / "aniall_match_report.csv"

    print("[1/3] Reading reviewed four-source DB...")
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    catalog, exact, display_alias, keys, trigram = build_reference_index(db)
    print(f"      catalog={len(catalog):,}, alias_keys={len(keys):,}")

    print("[2/3] Crawling aniall subtitle category...")
    first = fetch(CATEGORY_URL)
    expected, auto_pages = expected_count_and_pages(first)
    pages = args.max_pages or auto_pages or 300
    if expected:
        print(f"      site reports {expected:,} subtitle posts / {pages} pages")
    else:
        print(f"      count auto-detect failed; scanning up to {pages} pages")

    posts = {}
    empty_streak = 0
    for page in range(1, pages + 1):
        body = first if page == 1 else fetch(f"{CATEGORY_URL}?page={page}")
        rows = extract_page_posts(body)
        before = len(posts)
        for row in rows:
            posts[row["post_id"]] = row
        added = len(posts) - before

        if page == 1 or page % 20 == 0 or page == pages:
            print(f"      page {page}/{pages}: unique posts={len(posts):,} (+{added})")

        if not rows or added == 0:
            empty_streak += 1
        else:
            empty_streak = 0
        if empty_streak >= 3 and not expected:
            break
        if args.delay and page < pages:
            time.sleep(args.delay)

    ordered = sorted(posts.values(), key=lambda x: int(x["post_id"]), reverse=True)
    raw_path.write_text(json.dumps(ordered, ensure_ascii=False, indent=2), encoding="utf-8")

    print("[3/3] Matching titles...")
    report = []
    counts = defaultdict(int)
    unique_matched = set()
    for post in ordered:
        m = match_post(post["title"], exact, display_alias, keys, trigram)
        row = {**post, **m}
        report.append(row)
        counts[m["match_kind"]] += 1
        if m["matched_title"]:
            unique_matched.add(m["matched_title"])

    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        cols = [
            "post_id", "post_url", "title", "match_kind", "matched_title",
            "matched_alias", "score", "margin", "variant",
        ]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(report)

    total = len(report)
    strong = counts["exact"] + counts["fuzzy_high"]
    print()
    print("=== aniall subtitle match audit ===")
    print(f"crawled posts : {total:,}" + (f" / expected {expected:,}" if expected else ""))
    print(f"exact         : {counts['exact']:,} ({counts['exact']/total*100:.1f}%)" if total else "exact         : 0")
    print(f"fuzzy high    : {counts['fuzzy_high']:,} ({counts['fuzzy_high']/total*100:.1f}%)" if total else "fuzzy high    : 0")
    print(f"fuzzy review  : {counts['fuzzy_review']:,} ({counts['fuzzy_review']/total*100:.1f}%)" if total else "fuzzy review  : 0")
    print(f"ambiguous     : {counts['ambiguous_exact']:,} ({counts['ambiguous_exact']/total*100:.1f}%)" if total else "ambiguous     : 0")
    print(f"unmatched     : {counts['unmatched']:,} ({counts['unmatched']/total*100:.1f}%)" if total else "unmatched     : 0")
    print(f"strong total  : {strong:,} ({strong/total*100:.1f}%)" if total else "strong total  : 0")
    print(f"unique mapped : {len(unique_matched):,} Korean titles")
    if expected and total != expected:
        print(f"WARNING: crawl count differs from site's reported count by {total-expected:+,}.")
        print("         Inspect aniall_posts.json before using this as a production source.")
    print(f"raw index     : {raw_path}")
    print(f"JSON report   : {json_path}")
    print(f"CSV report    : {csv_path}")


if __name__ == "__main__":
    main()
