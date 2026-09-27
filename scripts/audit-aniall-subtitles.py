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
from datetime import datetime
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

# Known cross-language title spellings that are present in aniall but are not
# reliably linked by the reviewed four-source aliases yet. These only add
# lookup variants; normal metadata/ambiguity checks still decide the match.
KNOWN_TITLE_VARIANTS = {
    "aitenchimuyou": ["사랑 천지무용"],
    "aitenchimuyo": ["사랑 천지무용"],
    "mobilesuitgundamironbloodedorphans": ["기동전사 건담 철혈의 오펀스"],
    "ijiranaidenagatorosan": ["괴롭히지 말아요, 나가토로 양"],
    "kimetsunoyaibayuukakuhen": ["귀멸의 칼날 : 환락의 거리편", "귀멸의 칼날 유곽 편"],
}

TECH_WORDS = (
    "1080p", "720p", "2160p", "480p", "x264", "x265", "hevc", "avc",
    "aac", "flac", "webrip", "web-dl", "web.", "bdrip", "bd ", "bluray",
    "blu-ray", "remux", "10bit", "8bit", "10-bit", "8-bit", "dual-audio",
    "multi-subs", "batch", "at-x", "bs11", "tx ", "cs", "uhd", "hdr",
    "dts", "mkv", "h264", "h265", "yuv", "raws", "subplease", "bd-box",
    "4k", "ma10p", "dvdrip", "dvd remux", "multi", "dual", "japanese",
    "remaster", "hdリマスター", "tokuten", "rartv",
)


def norm_space(s: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", s or "").strip().lower().split())


def compact_key(s: str) -> str:
    s = norm_space(s)
    return "".join(ch for ch in s if ch.isalnum() or ("가" <= ch <= "힣"))


def release_group_chunk(chunk: str) -> bool:
    """True for a leading [release-group] tag, not for a bracketed title."""
    x = norm_space(chunk)
    if not x or len(x) > 40:
        return False
    if re.search(r"[가-힣ぁ-んァ-ン一-龯]", chunk):
        return False
    if any(word in x for word in (
        "raw", "reinforce", "moozzi", "judas", "subsplease", "anime land",
        "uqw", "linrip", "dbd", "nanakoraws", "salender", "sandoe",
        "fansub", "bitsub", "subteam", "rip",
    )):
        return True
    # Release-group names often contain &, accented Latin letters, etc.
    # Keep CJK bracketed titles intact, but allow broader non-CJK group names.
    return bool(re.fullmatch(r"[\w ._+\-@&]{2,40}", x, flags=re.UNICODE))


def strip_release_prefix(s: str) -> str:
    s = html.unescape(unicodedata.normalize("NFKC", s or "")).strip()
    while True:
        m = re.match(r"^\s*\[([^\]]{1,80})\]\s*", s)
        if not m or not release_group_chunk(m.group(1)):
            break
        s = s[m.end():].lstrip()

    # Some releases are "[group][Korean title][technical][technical]".
    m = re.match(r"^\[([^\]]{2,160})\]\s*(.*)$", s)
    if m and re.search(r"[가-힣]", m.group(1)):
        s = m.group(1) + (" " + m.group(2) if m.group(2) else "")
    return s


def looks_technical(chunk: str) -> bool:
    low = norm_space(chunk)
    if any(x in low for x in TECH_WORDS):
        return True
    if re.search(r"\b(?:tv|ova|ona|sp|movie)\s*(?:\+|$)", low):
        return True
    if re.search(r"\b(?:s\s*-?\s*\d{1,2}|season\s*\d+)\b", low):
        return True
    if re.fullmatch(r"[0-9a-f]{6,10}", low):
        return True
    if re.search(r"(?:全集|简繁|外挂|双语|第一季|第二季)", chunk):
        return True
    return False


def extract_meta(raw: str) -> dict:
    s = html.unescape(unicodedata.normalize("NFKC", raw or ""))

    years = []
    for m in re.finditer(r"(?<!\d)((?:19|20)\d{2})(?!\d)", s):
        y = int(m.group(1))
        # 1920x1080 is a resolution, not a release year.
        tail = s[m.end():m.end()+6].lower()
        max_year = datetime.now().year + 1
        if 1960 <= y <= max_year and not re.match(r"\s*x\s*\d{3,4}", tail):
            years.append(y)
    year = years[0] if years else None

    season = None
    season_range = None
    range_match = re.search(r"(?<!\d)(\d{1,2})\s*[-~–]\s*(\d{1,2})\s*기\b", s)
    if range_match:
        season_range = [int(range_match.group(1)), int(range_match.group(2))]
    season_patterns = (
        r"\bseason\s*0*(\d{1,2})\b",
        r"\b0*(\d{1,2})(?:st|nd|rd|th)\s+season\b",
        r"\b0*(\d{1,2})(?:st|nd|rd|th)\s+(?:attack|cour|stage)\b",
        r"\b0*(\d{1,2})(?:st|nd|rd|th)\b(?=\s*(?:$|[-\[(]|ep\s*\d|\d{1,3}\b))",
        r"\bs\s*-?\s*0*(\d{1,2})\b",
        r"시즌\s*0*(\d{1,2})",
        r"(?<!\d)(\d{1,2})\s*기\b",
    )
    for pat in (() if season_range else season_patterns):
        m = re.search(pat, s, flags=re.I)
        if m:
            season = int(m.group(1))
            break
    if season is None and season_range is None:
        if "第一季" in s:
            season = 1
        elif "第二季" in s:
            season = 2
        elif "第三季" in s:
            season = 3

    # Roman numerals are common season markers (e.g. Overlord IV, Date A Live V).
    # Require a separator/end after the numeral so ordinary words are not affected.
    if season is None and season_range is None:
        # A roman numeral followed by a subtitle (e.g. "II - Le Film") can
        # be part of a movie's actual title, as in Street Fighter II.
        m = re.search(r"(?:^|\s)(II|III|IV|V|VI)\b(?=\s*(?:$|[\[(]|EP\s*\d|\d{1,3}\b|-\s*(?:EP\s*)?\d))", s, flags=re.I)
        if m:
            season = {"ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6}[m.group(1).lower()]

    low = norm_space(s)
    fmt = None
    if "극장판" in s or re.search(r"\bmovie\b", low):
        fmt = "movie"
    elif re.search(r"\bova\b", low):
        fmt = "ova"
    elif re.search(r"\bona\b", low):
        fmt = "ona"
    elif re.search(r"\bsp\b", low):
        fmt = "sp"

    return {"year": year, "season": season, "season_range": season_range, "format": fmt}


def title_variants(raw: str) -> list[str]:
    """Return title-only variants. Year/season/format are compared separately."""
    meta = extract_meta(raw)
    s = strip_release_prefix(raw)
    bracket_source = s
    s = re.sub(r"_?자막\s*$", "", s, flags=re.I).strip()
    s = re.sub(r"\s+_?subtitle\s*$", "", s, flags=re.I).strip()
    s = re.sub(r"(?:완결|통합)?\s*자막(?:모음|입니다)?\s*$", "", s, flags=re.I).strip()
    s = re.sub(r"구글번역기영문자막과한글자막입니다\s*$", "", s, flags=re.I).strip()
    if not s:
        return []

    # Remove clearly technical bracket/paren chunks while keeping alternate titles.
    s = re.sub(
        r"([\[(])([^\])]{1,160})([\])])",
        lambda m: " " if (
            looks_technical(m.group(2))
            or (m.group(1) == "[" and release_group_chunk(m.group(2)))
        ) else m.group(0),
        s,
    )

    # Extracted metadata should not participate in the title string comparison.
    # Only remove a plausible release year. Numbers such as SAC_2045 / 마왕 2099
    # are part of the title and must survive normalization.
    s = re.sub(r"\(?\b(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}\)?", " ", s)
    if meta["year"]:
        s = re.sub(rf"(?<!\d){meta['year']}(?:년)?(?!\d)", " ", s)
    s = re.sub(r"\bseason\s*0*\d{1,2}\b", " ", s, flags=re.I)
    s = re.sub(r"\b0*\d{1,2}(?:st|nd|rd|th)\s+season\b", " ", s, flags=re.I)
    s = re.sub(r"\b0*\d{1,2}(?:st|nd|rd|th)\s+(?:attack|cour|stage)\b", " ", s, flags=re.I)
    s = re.sub(r"\b0*\d{1,2}(?:st|nd|rd|th)\b(?=\s*(?:$|[-\[(]|ep\s*\d|\d{1,3}\b))", " ", s, flags=re.I)
    s = re.sub(r"\bpart\s*0*\d{1,2}\b", " ", s, flags=re.I)
    s = re.sub(r"\bs\s*-?\s*0*\d{1,2}\b", " ", s, flags=re.I)
    s = re.sub(r"시즌\s*0*\d{1,2}", " ", s)
    s = re.sub(r"(?<!\d)\d{1,2}\s*[-~–]\s*\d{1,2}\s*기\b", " ", s)
    s = re.sub(r"(?<!\d)\d{1,2}\s*기\b", " ", s)
    s = re.sub(r"\(\s*\)|\[\s*\]", " ", s)
    if meta["season"] in (2, 3, 4, 5, 6):
        roman = {2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI"}[meta["season"]]
        s = re.sub(rf"\b{roman}\b(?=\s*(?:$|[-\[(]|EP\s*\d|\d{{1,3}}\b))", " ", s, flags=re.I)
    s = s.replace("第一季", " ").replace("第二季", " ").replace("第三季", " ")

    # Episode ranges belong to subtitle selection, not work-title matching.
    s = re.sub(r"\(?\b(?:e|ep)?\s*\d{1,3}\s*[-~]\s*(?:e|ep)?\s*\d{1,3}\b\)?", " ", s, flags=re.I)
    s = re.sub(r"\bEP\s*\d{1,3}\s*[-~]\s*EP\s*\d{1,3}\b", " ", s, flags=re.I)
    s = re.sub(r"\[\s*\d{1,3}\s*[-~]\s*\d{1,3}\s*(?:tv)?(?:全集)?[^\]]*\]", " ", s, flags=re.I)
    s = re.sub(r"\s+-\s*\d{1,3}(?:\s*(?:END|Fin))?\s*$", " ", s, flags=re.I)
    s = re.sub(r"^\s*\d{1,2}[._]\s*", "", s)

    # Normalize away format words after preserving them in extract_meta().
    s = re.sub(r"\bmovie(?:\s*0*\d+)?\b", " ", s, flags=re.I)
    s = re.sub(r"극장판", " ", s)
    s = re.sub(r"\b(?:tv|ova|ona|sp)\b", " ", s, flags=re.I)

    # Naked encoding/release tail: "1080p x265 FLAC ..." etc.
    s = re.sub(
        r"\b(?:2160p|1080p|720p|480p|uhd|bdrip|bd-box|bluray|blu-ray|remux|webrip|web-dl|"
        r"dvdrip|dvd|x264|x265|h264|h265|hevc|avc|flac|aac|hdr10?|10bit|8bit|4k|"
        r"ma10p|multi|dual|japanese|tokuten|rartv|cr|nf)\b.*$",
        " ",
        s,
        flags=re.I,
    )
    s = re.sub(r"\bHD\s*Remaster\b.*$", " ", s, flags=re.I)
    s = re.sub(r"HDリマスター.*$", " ", s, flags=re.I)
    s = re.sub(r"\b(?:REPACK|PROPER)\b", " ", s, flags=re.I)
    s = re.sub(r"\bv\d+\b(?=\s*(?:$|[-\[(]))", " ", s, flags=re.I)
    s = re.sub(r"\s+-\s*(?:\+\s*)+$", " ", s)
    s = re.sub(r"\s+", " ", s).strip(" -_[]")

    out: list[str] = []

    def add(x: str):
        x = re.sub(r"\s+", " ", x).strip(" -_[]")
        if len(compact_key(x)) >= 2 and x not in out:
            out.append(x)

    add(s)

    # Some posts repeat a shared prefix with Korean + English title forms:
    # "기동전사 건담 SEED 프리덤 기동전사 건담 SEED Freedom".
    tokens = s.split()
    for width in range(min(8, len(tokens) // 2), 1, -1):
        prefix = tokens[:width]
        repeat_at = next(
            (i for i in range(width, len(tokens) - width + 1) if tokens[i:i+width] == prefix),
            None,
        )
        if repeat_at is not None:
            add(" ".join(tokens[:repeat_at]))
            add(" ".join(tokens[repeat_at:]))
            break

    # Split a Korean/Japanese/Chinese title from an English alternate title,
    # but keep English titles whose hyphen is part of the real title
    # (e.g. "Mobile Suit Gundam - Iron-Blooded Orphans").
    m_alt = re.match(r"^(.+?[가-힣ぁ-んァ-ン一-龯][^-]*?)\s+-\s*(.+)$", s)
    if m_alt:
        add(m_alt.group(1))
        add(m_alt.group(2).strip(" -"))

    # Bracketed multilingual posts often carry Japanese / English / Korean
    # titles in separate [] chunks. Add each non-technical title chunk.
    for inner in re.findall(r"\[([^\]]{2,160})\]", bracket_source):
        if not looks_technical(inner) and not release_group_chunk(inner):
            add(inner)

    # Parenthesized alternate titles; also keep the title before them.
    m = re.search(r"\s*\(([^()]{2,120})\)", s)
    if m:
        add(s[:m.start()])
    for inner in re.findall(r"\(([^()]{2,120})\)", s):
        if not looks_technical(inner):
            add(inner)

    # Subtitle-site descriptive suffixes sometimes use "_" as a separator.
    # Do not split identifiers such as SAC_2045.
    if "_" in s:
        left, right = s.split("_", 1)
        if re.search(r"[가-힣]", left) and re.search(r"[가-힣]", right) and not re.match(r"\s*\d", right):
            add(left)

    # Add a few reviewed cross-language spellings without forcing a match.
    for base in list(out):
        for known in KNOWN_TITLE_VARIANTS.get(compact_key(base), ()):
            add(known)

    return out


def title_number_tokens(text: str) -> set[str]:
    variants = title_variants(text)
    if not variants:
        return set()
    return set(re.findall(r"(?<![A-Za-z0-9])\d+(?:\.\d+)?(?![A-Za-z0-9])", variants[0]))


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
            req = Request(
                url,
                headers={
                    "User-Agent": UA,
                    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
                },
            )
            with urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", errors="replace")
        except (HTTPError, URLError, TimeoutError) as exc:
            err = exc
            if attempt + 1 < retries:
                time.sleep(1.0 + attempt)
    raise RuntimeError(f"Failed to fetch {url}: {err}")


def numeric_post_id(href: str) -> str | None:
    href = html.unescape(href or "")
    m = re.match(
        r"^(?:https?://aniall\.tistory\.com)?/(\d+)(?:[/?#].*)?$",
        href,
    )
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

    # Category pages expose the current page's posts first. Keep the first
    # ten unique numeric post links to avoid sidebar/related-post duplicates.
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


def _candidate_meta(row: dict, alias: str) -> dict:
    meta = extract_meta(alias)
    # The reviewed catalog year is more reliable than title text when present.
    year = row.get("year") or meta["year"]
    # Season/format are most often encoded in the Korean title.
    ko_meta = extract_meta(row.get("title") or "")
    return {
        "korean": row["title"],
        "alias": alias,
        "year": int(year) if year else None,
        "season": meta["season"] or ko_meta["season"],
        "format": meta["format"] or ko_meta["format"],
    }


def build_reference_index(db: sqlite3.Connection):
    catalog, aliases = build_catalog(db)
    extra_aliases = defaultdict(list)
    for _normalized, alias, korean in aliases:
        extra_aliases[korean].append(alias)

    exact = defaultdict(list)
    seen = set()

    def add(row: dict, alias: str):
        for variant in title_variants(alias):
            k = compact_key(variant)
            if len(k) < 2:
                continue
            cand = _candidate_meta(row, alias)
            fingerprint = (
                k, cand["korean"], cand["year"], cand["season"], cand["format"], cand["alias"]
            )
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            exact[k].append(cand)

    for row in catalog:
        for alias in (
            row["title"],
            row.get("nativeTitle") or "",
            row.get("englishTitle") or "",
            *extra_aliases.get(row["title"], ()),
        ):
            if alias:
                add(row, alias)

    trigram = defaultdict(set)
    keys = list(exact)
    for i, k in enumerate(keys):
        grams = {k[j:j+3] for j in range(len(k)-2)} if len(k) >= 3 else {k}
        for g in grams:
            trigram[g].add(i)
    return catalog, exact, keys, trigram


def season_matches(post_season, cand_season) -> bool:
    """Season 1 and an omitted season label represent the same base TV work."""
    if post_season == cand_season:
        return True
    return {post_season, cand_season} == {1, None}


def metadata_rank(post_meta: dict, cand: dict) -> tuple[int, bool]:
    """Return (bonus, conflict). Missing metadata is neutral.

    For TV titles, an omitted season is treated as season 1. This lets
    "S01", "Season 1", "1기", and an unsuffixed base title resolve together,
    while season 2+ still requires an explicit matching candidate.
    """
    bonus = 0
    conflict = False
    if post_meta["year"] and cand["year"]:
        if post_meta["year"] == cand["year"]:
            bonus += 12
        else:
            conflict = True

    post_season = post_meta["season"]
    cand_season = cand["season"]
    if post_season is not None and cand_season is not None:
        if post_season == cand_season:
            bonus += 10
        else:
            conflict = True
    elif season_matches(post_season, cand_season):
        # Explicit S01/1기 vs an unsuffixed base title.
        if post_season == 1 or cand_season == 1:
            bonus += 10
        # When neither side says a season, prefer the base/season-1 candidate
        # over season 2+ candidates that normalize to the same title key.
        else:
            bonus += 3

    if post_meta["format"] and cand["format"]:
        if post_meta["format"] == cand["format"]:
            bonus += 6
        else:
            conflict = True
    return bonus, conflict


def choose_exact(candidates: list[dict], post_meta: dict):
    ranked = []
    for cand in candidates:
        bonus, conflict = metadata_rank(post_meta, cand)
        if conflict:
            continue
        ranked.append((bonus, cand))
    if not ranked:
        return None, "conflict", []

    ranked.sort(key=lambda x: x[0], reverse=True)
    best_bonus = ranked[0][0]
    top = [cand for bonus, cand in ranked if bonus == best_bonus]
    # Duplicate source records for the same work are not ambiguity.
    works = {
        (
            compact_key(title_variants(x["korean"])[0] if title_variants(x["korean"]) else x["korean"]),
            x["year"], x["season"], x["format"],
        )
        for x in top
    }
    if len(works) == 1:
        chosen = top[0]
        post_season = post_meta["season"]
        cand_season = chosen["season"]
        underspecified = bool(
            (
                not season_matches(post_season, cand_season)
                and (post_season is not None or cand_season is not None)
            )
            or (chosen["format"] and not post_meta["format"])
            or (post_meta["format"] and not chosen["format"])
        )
        if underspecified:
            return None, "underspecified", top
        return chosen, "exact", top
    return None, "ambiguous", top


def fuzzy_best(query: str, post_meta: dict, exact, keys, trigram):
    q = compact_key(query)
    if len(q) < 3:
        return None
    query_numbers = title_number_tokens(query)
    grams = {q[j:j+3] for j in range(len(q)-2)} if len(q) >= 3 else {q}
    counts = defaultdict(int)
    for g in grams:
        for idx in trigram.get(g, ()):
            counts[idx] += 1
    if not counts:
        return None

    ranked = []
    for idx in sorted(counts, key=counts.get, reverse=True)[:120]:
        k = keys[idx]
        ratio = SequenceMatcher(None, q, k).ratio()
        if q in k or k in q:
            ratio = min(1.0, ratio + 0.04)
        for cand in exact[k]:
            bonus, conflict = metadata_rank(post_meta, cand)
            if conflict:
                continue
            # A sequel/version number that exists only on the DB candidate is
            # a strong warning (e.g. "패트레이버" vs "패트레이버 2").
            candidate_numbers = title_number_tokens(cand["alias"])
            if candidate_numbers - query_numbers:
                continue
            # metadata is a tie-breaker, not a way to rescue a weak title.
            adjusted = ratio + min(0.06, bonus / 200.0)
            ranked.append((adjusted, ratio, cand))

    if not ranked:
        return None
    ranked.sort(key=lambda x: x[0], reverse=True)
    best_adjusted, best_ratio, best = ranked[0]
    second = next(
        (x for x in ranked[1:] if x[2]["korean"] != best["korean"]),
        None,
    )
    second_adjusted = second[0] if second else 0.0

    # A supplied season that the candidate cannot confirm is never auto-high.
    metadata_incomplete = bool(
        (post_meta["year"] and not best["year"])
        or (
            not season_matches(post_meta["season"], best["season"])
            and post_meta["season"] is not None
        )
        or (post_meta["format"] and not best["format"])
    )
    candidate_extra_specific = bool(
        (
            not season_matches(post_meta["season"], best["season"])
            and best["season"] is not None
        )
        or (best["format"] and not post_meta["format"])
    )
    candidate_numbers = title_number_tokens(best["alias"])
    query_extra_numbers = bool(query_numbers - candidate_numbers)
    best_key = compact_key(best["alias"])
    shorter_containment = bool(
        best_key and best_key in q and len(best_key) / max(1, len(q)) < 0.92
    )
    explicit_meta_confirmed = bool(
        (post_meta["year"] and best["year"] == post_meta["year"])
        or (
            post_meta["season"] is not None
            and season_matches(post_meta["season"], best["season"])
        )
        or (post_meta["format"] and best["format"] == post_meta["format"])
    )
    return {
        "score": round(best_ratio * 100, 1),
        "adjusted_score": round(best_adjusted * 100, 1),
        "matched_title": best["korean"],
        "matched_alias": best["alias"],
        "matched_year": best["year"],
        "matched_season": best["season"],
        "matched_format": best["format"],
        "margin": round((best_adjusted - second_adjusted) * 100, 1),
        "metadata_incomplete": metadata_incomplete,
        "candidate_extra_specific": candidate_extra_specific,
        "query_extra_numbers": query_extra_numbers,
        "shorter_containment": shorter_containment,
        "explicit_meta_confirmed": explicit_meta_confirmed,
    }


def fuzzy_review_candidates(variants: list[str], post_meta: dict, exact, keys, trigram, limit=8):
    """Return ranked alternatives for human review; these are never confirmations."""
    best_by_title = {}
    query_numbers = set().union(*(title_number_tokens(v) for v in variants)) if variants else set()
    for query in variants:
        q = compact_key(query)
        if len(q) < 3:
            continue
        grams = {q[j:j+3] for j in range(len(q)-2)}
        counts = defaultdict(int)
        for gram in grams:
            for idx in trigram.get(gram, ()):
                counts[idx] += 1
        for idx in sorted(counts, key=counts.get, reverse=True)[:160]:
            key = keys[idx]
            ratio = SequenceMatcher(None, q, key).ratio()
            if q in key or key in q:
                ratio = min(1.0, ratio + 0.04)
            for cand in exact[key]:
                _, conflict = metadata_rank(post_meta, cand)
                if conflict or title_number_tokens(cand["alias"]) - query_numbers:
                    continue
                adjusted = ratio + min(0.06, metadata_rank(post_meta, cand)[0] / 200.0)
                title = cand["korean"]
                item = {"title": title, "score": round(ratio * 100, 1),
                        "adjusted_score": round(adjusted * 100, 1),
                        "year": cand["year"], "season": cand["season"],
                        "format": cand["format"], "alias": cand["alias"]}
                if title not in best_by_title or adjusted > best_by_title[title]["adjusted_score"] / 100:
                    best_by_title[title] = item
    return sorted(best_by_title.values(), key=lambda x: (-x["adjusted_score"], x["title"]))[:limit]


def match_post(title: str, exact, keys, trigram):
    variants = title_variants(title)
    post_meta = extract_meta(title)
    exact_review_candidates = []
    had_metadata_conflict = False

    for v in variants:
        hits = exact.get(compact_key(v))
        if not hits:
            continue
        cand, state, top = choose_exact(hits, post_meta)
        had_metadata_conflict = had_metadata_conflict or state == "conflict"
        if cand:
            if post_meta["season_range"]:
                exact_review_candidates.append(cand)
                continue
            return {
                "match_kind": "exact",
                "matched_title": cand["korean"],
                "matched_alias": cand["alias"],
                "score": 100.0,
                "adjusted_score": 100.0,
                "margin": 100.0,
                "variant": v,
                "post_year": post_meta["year"],
                "post_season": post_meta["season"],
                "post_season_range": post_meta["season_range"],
                "post_format": post_meta["format"],
                "matched_year": cand["year"],
                "matched_season": cand["season"],
                "matched_format": cand["format"],
                "candidate_titles": "",
            }
        if state in ("ambiguous", "underspecified"):
            exact_review_candidates.extend(top)

    if exact_review_candidates:
        titles = []
        for cand in exact_review_candidates:
            if cand["korean"] not in titles:
                titles.append(cand["korean"])
        return {
            "match_kind": "title_exact_review",
            "matched_title": "",
            "matched_alias": "",
            "score": 100.0,
            "adjusted_score": 100.0,
            "margin": 0.0,
            "variant": variants[0] if variants else title,
            "post_year": post_meta["year"],
            "post_season": post_meta["season"],
            "post_season_range": post_meta["season_range"],
            "post_format": post_meta["format"],
            "matched_year": None,
            "matched_season": None,
            "matched_format": None,
            "candidate_titles": " | ".join(titles[:12]),
            "candidate_details": [],
        }

    best = None
    for v in variants:
        f = fuzzy_best(v, post_meta, exact, keys, trigram)
        if f and (best is None or f["adjusted_score"] > best["adjusted_score"]):
            best = dict(f, variant=v)

    if best:
        kind = "unmatched"
        safe_specificity = (
            not best["metadata_incomplete"]
            and not best["candidate_extra_specific"]
            and not best["query_extra_numbers"]
            and not best["shorter_containment"]
        )
        if not post_meta["season_range"] and (
            safe_specificity
            and best["margin"] >= 4
            and (
                best["score"] >= 94
                or (best["score"] >= 90 and best["explicit_meta_confirmed"])
            )
        ):
            kind = "fuzzy_high"
        elif best["score"] >= 78:
            kind = "fuzzy_review"
        best["match_kind"] = kind
        best["post_year"] = post_meta["year"]
        best["post_season"] = post_meta["season"]
        best["post_season_range"] = post_meta["season_range"]
        best["post_format"] = post_meta["format"]
        best.pop("metadata_incomplete", None)
        best.pop("candidate_extra_specific", None)
        best.pop("query_extra_numbers", None)
        best.pop("shorter_containment", None)
        best.pop("explicit_meta_confirmed", None)
        best["candidate_titles"] = ""
        if kind != "unmatched" and not post_meta["season_range"]:
            return best

    alternatives = fuzzy_review_candidates(variants, post_meta, exact, keys, trigram)
    candidate_text = " | ".join(
        f'{x["title"]} ({x["score"]:.1f}; {x["year"] or "?"}; '
        f'{("S" + str(x["season"])) if x["season"] else "season?"}; {x["format"] or "format?"})'
        for x in alternatives
    )
    if post_meta["season_range"]:
        range_text = f'{post_meta["season_range"][0]}-{post_meta["season_range"][1]}기 묶음'
        candidate_text = (range_text + " → ") + candidate_text

    return {
        "match_kind": "metadata_conflict" if had_metadata_conflict else "unmatched",
        "matched_title": best["matched_title"] if best else "",
        "matched_alias": best["matched_alias"] if best else "",
        "score": best["score"] if best else 0.0,
        "adjusted_score": best["adjusted_score"] if best else 0.0,
        "margin": best["margin"] if best else 0.0,
        "variant": best["variant"] if best else (variants[0] if variants else title),
        "post_year": post_meta["year"],
        "post_season": post_meta["season"],
        "post_format": post_meta["format"],
        "matched_year": best["matched_year"] if best else None,
        "matched_season": best["matched_season"] if best else None,
        "matched_format": best["matched_format"] if best else None,
        "candidate_titles": candidate_text,
        "candidate_details": alternatives,
        "post_season_range": post_meta["season_range"],
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
    unmatched_json_path = out_dir / "aniall_unmatched.json"
    unmatched_csv_path = out_dir / "aniall_unmatched.csv"

    print("[1/3] Reading reviewed four-source DB...")
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    catalog, exact, keys, trigram = build_reference_index(db)
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
        m = match_post(post["title"], exact, keys, trigram)
        row = {**post, **m}
        report.append(row)
        counts[m["match_kind"]] += 1
        if m["matched_title"]:
            unique_matched.add(m["matched_title"])

    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        cols = [
            "post_id", "post_url", "title", "match_kind", "matched_title",
            "matched_alias", "score", "adjusted_score", "margin", "variant",
            "post_year", "post_season", "post_format",
            "matched_year", "matched_season", "matched_format", "post_season_range",
            "candidate_titles", "candidate_details",
        ]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(report)

    unmatched_rows = sorted(
        (row for row in report if row["match_kind"] == "unmatched"),
        key=lambda row: (-(row.get("score") or 0), -(row.get("adjusted_score") or 0), row["title"]),
    )
    unmatched_json_path.write_text(
        json.dumps(unmatched_rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    with unmatched_csv_path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(unmatched_rows)

    total = len(report)
    strong = counts["exact"] + counts["fuzzy_high"]
    title_exact = counts["exact"] + counts["title_exact_review"]
    review_total = counts["title_exact_review"] + counts["fuzzy_review"]
    print()
    print("=== aniall subtitle match audit ===")
    print(f"crawled posts : {total:,}" + (f" / expected {expected:,}" if expected else ""))
    print(f"exact              : {counts['exact']:,} ({counts['exact']/total*100:.1f}%)" if total else "exact              : 0")
    print(f"title exact review : {counts['title_exact_review']:,} ({counts['title_exact_review']/total*100:.1f}%)" if total else "title exact review : 0")
    print(f"fuzzy high         : {counts['fuzzy_high']:,} ({counts['fuzzy_high']/total*100:.1f}%)" if total else "fuzzy high         : 0")
    print(f"fuzzy review       : {counts['fuzzy_review']:,} ({counts['fuzzy_review']/total*100:.1f}%)" if total else "fuzzy review       : 0")
    print(f"meta conflict      : {counts['metadata_conflict']:,} ({counts['metadata_conflict']/total*100:.1f}%)" if total else "meta conflict      : 0")
    print(f"unmatched          : {counts['unmatched']:,} ({counts['unmatched']/total*100:.1f}%)" if total else "unmatched          : 0")
    print(f"title exact total  : {title_exact:,} ({title_exact/total*100:.1f}%)" if total else "title exact total  : 0")
    print(f"strong mapped      : {strong:,} ({strong/total*100:.1f}%)" if total else "strong mapped      : 0")
    print(f"review candidates  : {review_total:,} ({review_total/total*100:.1f}%)" if total else "review candidates  : 0")
    print(f"unique mapped : {len(unique_matched):,} Korean titles")
    if expected and total != expected:
        print(f"WARNING: crawl count differs from site's reported count by {total-expected:+,}.")
        print("         Inspect aniall_posts.json before using this as a production source.")
    print(f"raw index     : {raw_path}")
    print(f"JSON report   : {json_path}")
    print(f"CSV report    : {csv_path}")
    print(f"unmatched JSON: {unmatched_json_path}")
    print(f"unmatched CSV : {unmatched_csv_path}")


if __name__ == "__main__":
    main()
