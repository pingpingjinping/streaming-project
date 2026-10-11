#!/usr/bin/env python3
"""Build a read-only Work audit snapshot from the Pi. No user/account secrets are exported.

Usage: python3 scripts/prepare-work-audit.py
Requires the existing docker compose db service for the sanitized catalog SQLite.
Only source subtitle folders are inventoried; uploads/private user folders are excluded.
"""
import argparse
import csv
import gzip
import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ("anissia_subtitles", "aniall_subtitles", "naver_subtitles")
# Explicit column allowlist. No users, login/passwords, session tokens or per-user settings.
TABLES = {
    "anime_catalog_entries": "source,source_record_id,payload::text AS payload",
    "anime_korean_catalog": "source,source_record_id,payload::text AS payload",
    "anime_reanime_matches": "reanime_id,korean_title,anissia_no,review_status",
    "anime_monthly_match_candidates": "reanime_id,anissia_no,score,reason,evidence::text AS evidence",
    "anime_unmatched_review": "anime_no,payload::text AS payload",
    "anime_anikoto_catalog": "anikoto_id,payload::text AS payload",
    "anime_anikoto_work_targets": (
        "anikoto_id,target_order,target_source,target_id,link_status,mapping_kind,"
        "anikoto_episode_start,anikoto_episode_end,target_episode_start,target_episode_end"
    ),
    "anime_work_match_overrides": "reanime_id,anissia_no",
    "anime_anikoto_work_overrides": (
        "anissia_no,anikoto_id,mapping_kind,anikoto_episode_start,"
        "anikoto_episode_end,target_episode_start,target_episode_end"
    ),
    "anime_subtitle_archives": "dataset_key,pack_id,source,zip_relative_path,sha256,member_count",
    "anime_subtitle_files": (
        "dataset_key,pid,source,pack_id,zip_relative_path,member_path,sha256,"
        "target_source,target_id,review_status,reason,work_title_ko,season_format,"
        "work_format,reanime_id,content_extension,work_confirmed"
    ),
    "anime_subtitle_file_origins": "dataset_key,pid,file_id",
    "anime_subtitle_confirmed_episodes": (
        "dataset_key,map_id,bundle_id,file_id,target_source,target_id,"
        "source_episode,target_episode,status"
    ),
    "anime_subtitle_work_reanime_links": (
        "dataset_key,target_source,target_id,reanime_id,link_status,automatic_eligible"
    ),
    "anime_release_reviewed_work_groups": "group_id,reviewed_month,title,kind,season",
    "anime_release_reviewed_work_group_members": "member_id,group_id",
}


def postgres_csv(table, columns, destination):
    sql = f"COPY (SELECT {columns} FROM {table}) TO STDOUT WITH (FORMAT CSV, HEADER)"
    cmd = ["docker", "compose", "exec", "-T", "db", "sh", "-c",
           'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -c "$1"',
           "sh", sql]
    with destination.open("wb") as output:
        completed = subprocess.run(cmd, cwd=ROOT, stdout=output, stderr=subprocess.PIPE, check=False)
    if completed.returncode:
        raise RuntimeError(f"Failed to export {table}: {completed.stderr.decode('utf8', 'replace')[-1500:]}")


def export_catalog_sqlite(destination):
    temporary = destination.with_suffix(".tmp")
    temporary.unlink(missing_ok=True)
    counts = {}
    try:
        with sqlite3.connect(temporary) as db, tempfile.TemporaryDirectory(prefix="work-audit-csv-") as td:
            for table, columns in TABLES.items():
                csv_file = Path(td) / f"{table}.csv"
                postgres_csv(table, columns, csv_file)
                with csv_file.open(newline="", encoding="utf-8") as stream:
                    rows = csv.DictReader(stream)
                    fields = rows.fieldnames
                    if not fields:
                        raise RuntimeError(f"Empty COPY header: {table}")
                    ddl = ",".join(f'"{name}" TEXT' for name in fields)
                    db.execute(f'CREATE TABLE "{table}" ({ddl})')
                    placeholders = ",".join("?" for _ in fields)
                    insert = f'INSERT INTO "{table}" VALUES ({placeholders})'
                    count = 0
                    batch = []
                    for row in rows:
                        batch.append([row[name] if row[name] != "" else None for name in fields])
                        if len(batch) >= 1000:
                            db.executemany(insert, batch)
                            count += len(batch)
                            batch.clear()
                    if batch:
                        db.executemany(insert, batch)
                        count += len(batch)
                    counts[table] = count
                    print(f"{table}: {count}")
                db.commit()
            db.execute("PRAGMA optimize")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Audit SQLite integrity check failed")
        temporary.replace(destination)
        return counts
    finally:
        temporary.unlink(missing_ok=True)


def scan_source_files(source_root, output, zip_output, include_zip_members=True):
    out_tmp = output.with_suffix(output.suffix + ".tmp")
    zip_tmp = zip_output.with_suffix(zip_output.suffix + ".tmp")
    totals = {"file_count": 0, "zip_count": 0, "zip_member_count": 0, "bytes": 0, "zip_errors": 0}
    try:
        with gzip.open(out_tmp, "wt", encoding="utf-8", newline="") as fp, \
             gzip.open(zip_tmp, "wt", encoding="utf-8", newline="") as zp:
            # JSON Lines for server-side search; CSV for archive members.
            zw = csv.writer(zp)
            zw.writerow(["archive_path", "member_path", "uncompressed_bytes"])
            for name in SOURCES:
                root = source_root / name
                if not root.is_dir() or root.is_symlink():
                    print(f"Skipping missing source directory: {root}")
                    continue
                for dirpath, dirs, filenames in os.walk(root, followlinks=False):
                    dirs[:] = sorted(d for d in dirs if not d.startswith(".") and
                                     d != "__MACOSX" and not (Path(dirpath) / d).is_symlink())
                    for filename in sorted(filenames):
                        if filename.startswith("."):
                            continue
                        physical = Path(dirpath) / filename
                        if physical.is_symlink() or not physical.is_file():
                            continue
                        rel = physical.relative_to(source_root).as_posix()
                        info = physical.stat()
                        item = {
                            "path": rel, "provider": name.removesuffix("_subtitles"),
                            "size": info.st_size,
                            "mtime": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(),
                        }
                        fp.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
                        totals["file_count"] += 1
                        totals["bytes"] += info.st_size
                        if filename.lower().endswith(".zip"):
                            totals["zip_count"] += 1
                            if include_zip_members:
                                try:
                                    with zipfile.ZipFile(physical) as archive:
                                        for idx, member in enumerate(archive.infolist()):
                                            if idx >= 20000:
                                                totals["zip_errors"] += 1
                                                break
                                            if not member.is_dir():
                                                zw.writerow([rel, member.filename, member.file_size])
                                                totals["zip_member_count"] += 1
                                except (OSError, zipfile.BadZipFile, RuntimeError):
                                    totals["zip_errors"] += 1
        out_tmp.replace(output)
        zip_tmp.replace(zip_output)
        return totals
    finally:
        out_tmp.unlink(missing_ok=True)
        zip_tmp.unlink(missing_ok=True)


def sha256_file(file):
    digest = hashlib.sha256()
    with file.open("rb") as fp:
        for chunk in iter(lambda: fp.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subtitles", type=Path, default=ROOT / "subtitle-data")
    parser.add_argument("--output", type=Path, default=ROOT / "work-audit")
    parser.add_argument("--skip-db", action="store_true",
                        help="Refresh file inventory only; keep the existing DB snapshot unchanged")
    parser.add_argument("--skip-zip-members", action="store_true",
                        help="List physical files without reading ZIP central directories")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    existing_db = output / "catalog_snapshot.sqlite"
    if args.skip_db and not existing_db.is_file():
        raise SystemExit("--skip-db requires an existing catalog_snapshot.sqlite")
    db_counts = None if args.skip_db else export_catalog_sqlite(existing_db)
    inventory = output / "subtitle_files.jsonl.gz"
    members = output / "subtitle_zip_members.csv.gz"
    totals = scan_source_files(args.subtitles.resolve(), inventory, members,
                               not args.skip_zip_members)
    files = {}
    for item in (existing_db, inventory, members):
        files[item.name] = {"bytes": item.stat().st_size, "sha256": sha256_file(item)}
    manifest = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "database": {"source": "read-only PostgreSQL SELECT exports",
                     "tables": db_counts, "contains_user_accounts": False},
        "subtitles": totals,
        "files": files,
        "notes": "Archive contents are listed by name only; original subtitle/ZIP bytes are downloaded individually.",
    }
    staged = output / "manifest.json.tmp"
    staged.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    staged.replace(output / "manifest.json")
    print(f"Work audit snapshot: {output}")
    print(f"Subtitle files: {totals['file_count']}, ZIP members: {totals['zip_member_count']}")
    print("No source subtitles or operational DB rows were modified.")


if __name__ == "__main__":
    main()
