#!/usr/bin/env python3
"""Export reviewed AniAll workbook decisions as importable catalog matches.

This does not perform fuzzy matching. It carries only a reviewer decision from
the workbook and keeps explicit multi-work decisions as multiple mappings.
"""
import json
import re
import sqlite3
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

if len(sys.argv) != 5:
    raise SystemExit("Usage: build-aniall-reviewed-matches.py reviewed.xlsx four-source.db preconfirmed.json output.json")

NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

def cell_text(cell, shared):
    value = cell.find("a:v", NS)
    if value is not None:
        return shared[int(value.text)] if cell.attrib.get("t") == "s" else value.text or ""
    inline = cell.find("a:is", NS)
    return "".join(t.text or "" for t in inline.findall(".//a:t", NS)) if inline is not None else ""

def column_number(reference):
    letters = re.match(r"[A-Z]+", reference).group()
    number = 0
    for char in letters:
        number = number * 26 + ord(char) - 64
    return number - 1

def segments(candidate_text):
    # Each DB candidate starts with a four digit year. Text between candidate
    # starts contains the multilingual titles and source identifiers.
    starts = list(re.finditer(r"(?:^|[.;\n])\s*((?:19|20)\d{2})(?=\s|[:：])", candidate_text))
    found = []
    for i, match in enumerate(starts):
        start = match.start(1)
        end = starts[i + 1].start(1) if i + 1 < len(starts) else len(candidate_text)
        raw = candidate_text[start:end].strip(" \n.;")
        title = raw[4:].lstrip(" :：").strip()
        title = re.sub(r"^(?:TV\s+Season\s*\d+|Season\s*\d+|TV|ONA|OVA|MOVIE|Movie)\s*[:：]?\s*", "", title, flags=re.I)
        title = re.split(r"\s+(?:/|—|–|\(Onnada\b|\(AniList\b|\(ReAnime\b|\(Anissia\b)", title, maxsplit=1)[0].strip(" :：-–—")
        if not title:
            continue
        source, source_id = "", ""
        for label, src in (("AniList", "AniList"), ("Onnada", "Onnada"), ("Anissia", "Anissia")):
            m = re.search(rf"\b{label}\s+(\d+)\b", raw, re.I)
            if m:
                source, source_id = src, m.group(1)
                break
        if not source:
            m = re.search(r"\bReAnime\s+([a-z0-9-]+)", raw, re.I)
            if m:
                source, source_id = "ReAnime", m.group(1)
        found.append({"year": match.group(1), "candidateTitle": title, "source": source, "sourceId": source_id, "raw": raw})
    if not found:
        raw = candidate_text.strip()
        title = re.split(r"\s+(?:/|—|–|\(Onnada\b|\(AniList\b|\(ReAnime\b|\(Anissia\b)", raw, maxsplit=1)[0].strip(" :：-–—")
        source, source_id = "", ""
        for label in ("AniList", "Onnada", "Anissia"):
            match = re.search(rf"\b{label}\s+(\d+)\b", raw, re.I)
            if match:
                source, source_id = label, match.group(1)
                break
        if not source:
            match = re.search(r"\bReAnime\s+([a-z0-9-]+)", raw, re.I)
            if match:
                source, source_id = "ReAnime", match.group(1)
        if title or source_id:
            found.append({"year": "", "candidateTitle": title, "source": source, "sourceId": source_id, "raw": raw})
    return found

def key(value):
    return " ".join(unicodedata.normalize("NFKC", value).strip().lower().split())

def source_refs(raw):
    refs = []
    for label in ("AniList", "Onnada", "Anissia"):
        for match in re.finditer(rf"\b{label}\s+(\d+(?:\s*[,;]\s*\d+)*)", raw, re.I):
            for source_id in re.findall(r"\d+", match.group(1)):
                refs.append((label, source_id))
    refs.extend(("ReAnime", value) for value in re.findall(r"\bReAnime\s+([a-z0-9-]+)", raw, re.I))
    return list(dict.fromkeys(refs))

catalog_db = sqlite3.connect(sys.argv[2])
catalog_db.row_factory = sqlite3.Row
if catalog_db.execute("PRAGMA schema_version").fetchone() is None:
    raise SystemExit("The supplied catalog database is not readable.")

def resolve_compact_source(candidate):
    if candidate["sourceId"]:
        return
    # Some reviewed rows abbreviate their source IDs as (Onnada ID; AniList ID).
    # Recover those IDs from the exact supplied release DB, never by guessing
    # from similarity. Prefer an exact-year AniList record, then Onnada.
    numeric_ids = [value for value in re.findall(r"\b\d+\b", candidate["raw"]) if value != candidate["year"]]
    records = []
    for source_id in numeric_ids:
        for source in ("AniList", "Onnada", "Anissia"):
            row = catalog_db.execute(
                "SELECT source,source_record_id,year,title_ko FROM entries WHERE source=? AND source_record_id=?",
                (source, source_id),
            ).fetchone()
            if row and str(row["year"] or "") == candidate["year"]:
                records.append(row)
    selected = next((row for row in records if row["source"] == "AniList"), None)
    if selected is None:
        selected = next((row for row in records if row["source"] == "Onnada"), None)
    if selected is None:
        selected = next(iter(records), None)
    if selected:
        candidate["source"] = selected["source"]
        candidate["sourceId"] = selected["source_record_id"]
        if selected["title_ko"]:
            candidate["candidateTitle"] = selected["title_ko"]

with zipfile.ZipFile(sys.argv[1]) as archive:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    relmap = {item.attrib["Id"]: item.attrib["Target"].lstrip("/") for item in rels}
    strings_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    shared = ["".join(t.text or "" for t in si.findall(".//a:t", NS)) for si in strings_root.findall("a:si", NS)]
    sheet_path = next(relmap[s.attrib[f"{{{NS['r']}}}id"]] for s in workbook.find("a:sheets", NS) if s.attrib["name"] == "직접 검색 1차")
    rows = ET.fromstring(archive.read(sheet_path)).findall(".//a:sheetData/a:row", NS)

results = []
seen = set()
reviewed_post_ids = set()
for row in rows[4:]:
    values = [""] * 10
    for cell in row.findall("a:c", NS):
        column = column_number(cell.attrib["r"])
        if column < len(values):
            values[column] = cell_text(cell, shared)
    if len(values) < 10:
        continue
    _, post_id, blog_title, post_url, candidate_text, decision, confidence_text, evidence, sources, attachments = values[:10]
    if post_id.isdigit():
        reviewed_post_ids.add(post_id)
    confidence_match = re.search(r"\d+", confidence_text)
    confidence = int(confidence_match.group()) if confidence_match else 0
    if not post_id.isdigit() or confidence < 40:
        continue
    # Keep reviewer-marked uncertain candidates at 40%+ for manual selection;
    # retain their status and evidence in the DB. Only <40% stays unlinked.
    candidates = segments(candidate_text)
    if not candidates:
        continue
    for candidate in candidates:
        resolve_compact_source(candidate)
    expanded_candidates = []
    for candidate in candidates:
        refs = source_refs(candidate["raw"])
        if refs:
            for source, source_id in refs:
                expanded_candidates.append({**candidate, "source": source, "sourceId": source_id})
        else:
            expanded_candidates.append(candidate)
    candidates = expanded_candidates
    multi = any(token in decision for token in ("복수", "다중", "분리", "각각", " + ", "1·2", "1·3", "2·3"))
    if not multi:
        # Prefer a candidate whose year appears in the explicit review decision.
        decision_year = re.search(r"(?:19|20)\d{2}", decision)
        selected = next((c for c in candidates if decision_year and c["year"] == decision_year.group()), candidates[0])
        candidates = [selected]
    for candidate in candidates:
        identity = (post_id, candidate["source"], candidate["sourceId"] or key(candidate["candidateTitle"]))
        if identity in seen:
            continue
        seen.add(identity)
        results.append({
            "postId": post_id,
            "blogTitle": blog_title,
            "postUrl": post_url,
            "confidence": confidence,
            "reviewStatus": decision,
            "evidence": evidence,
            "year": candidate["year"],
            "candidateTitle": candidate["candidateTitle"],
            "source": candidate["source"],
            "sourceId": candidate["sourceId"],
            "candidateEvidence": candidate["raw"],
            "attachmentEvidence": attachments,
        })

with open(sys.argv[3], encoding="utf-8") as base_file:
    preconfirmed = json.load(base_file)
for item in preconfirmed:
    if item["postId"] in reviewed_post_ids:
        continue
    identity = (item["postId"], "preconfirmed", key(item["candidateTitle"]))
    if identity in seen:
        continue
    seen.add(identity)
    results.append(item)

with open(sys.argv[4], "w", encoding="utf-8") as output:
    json.dump(results, output, ensure_ascii=False, indent=2)
print(f"Exported {len(results)} AniAll mappings across {len({r['postId'] for r in results})} posts, including preconfirmed posts outside the current review sheet.")
