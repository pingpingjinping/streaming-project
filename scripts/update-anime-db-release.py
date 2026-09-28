#!/usr/bin/env python3
"""Download and import the latest private anime DB Release asset on the Pi."""
import argparse
import gzip
import hashlib
import hmac
import io
import json
import os
import sqlite3
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

RELEASE_API = "https://api.github.com/repos/pingpingjinping/anime-db-download/releases/tags/db-v1"
ASSET_NAME = "anime_four_sources_multilingual_prepared.zip"
MAX_ASSET_SIZE = 128 * 1024 * 1024
EXPECTED_SOURCES = {"AniList", "ReAnime", "Onnada", "Anissia"}
STATE_FILE = Path.home() / ".local/state/streaming-project/anime-db-release.sha256"


def api_json(url, token):
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "streaming-project-anime-db-updater/1.0",
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download_asset(asset_url, token):
    request = urllib.request.Request(asset_url, headers={
        "Accept": "application/octet-stream",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "streaming-project-anime-db-updater/1.0",
    })
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=60) as response:
            payload = response.read(MAX_ASSET_SIZE + 1)
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            raise
        location = error.headers.get("Location")
        parsed = urllib.parse.urlparse(location or "")
        if parsed.scheme != "https" or not (
            parsed.hostname == "github.com" or
            (parsed.hostname or "").endswith(".githubusercontent.com")
        ):
            raise RuntimeError("GitHub returned an unexpected asset download host")
        # The redirected URL is signed; never forward the GitHub token to that host.
        with urllib.request.urlopen(location, timeout=120) as response:
            payload = response.read(MAX_ASSET_SIZE + 1)
    if len(payload) > MAX_ASSET_SIZE:
        raise RuntimeError(f"Release asset exceeds {MAX_ASSET_SIZE} bytes")
    return payload


def extract_database(payload, destination):
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            candidates = [item for item in archive.infolist()
                          if not item.is_dir() and item.filename.lower().endswith((".db", ".db.gz"))]
            if len(candidates) != 1:
                raise RuntimeError(f"Expected one SQLite DB in Release ZIP, found {len(candidates)}")
            contents = archive.read(candidates[0])
    except zipfile.BadZipFile as error:
        raise RuntimeError("Release asset is not a valid ZIP file") from error

    source = gzip.GzipFile(fileobj=io.BytesIO(contents)) if contents.startswith(b"\x1f\x8b") else io.BytesIO(contents)
    with source, open(destination, "wb") as output:
        while chunk := source.read(1024 * 1024):
            output.write(chunk)

    db = sqlite3.connect(destination)
    try:
        result = db.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {result}")
        sources = {row[0] for row in db.execute("SELECT DISTINCT source FROM entries")}
        missing = EXPECTED_SOURCES - sources
        if missing:
            raise RuntimeError(f"Database is missing expected sources: {sorted(missing)}")
        count = db.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        if count <= 0:
            raise RuntimeError("Database contains no source records")
    finally:
        db.close()
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Download and validate the Release asset without importing it")
    args = parser.parse_args()
    token = os.environ.get("ANIME_DB_GITHUB_TOKEN", "").strip()
    if not token:
        raise SystemExit("ANIME_DB_GITHUB_TOKEN is not set")

    release = api_json(RELEASE_API, token)
    assets = [asset for asset in release.get("assets", []) if asset.get("name") == ASSET_NAME]
    if len(assets) != 1:
        raise SystemExit(f"Expected exactly one {ASSET_NAME} asset in db-v1, found {len(assets)}")
    asset = assets[0]
    if asset.get("state") != "uploaded":
        raise SystemExit(f"Release asset is not ready: {asset.get('state')}")

    digest = asset.get("digest") or ""
    if digest.startswith("sha256:"):
        digest = digest.removeprefix("sha256:")
        previous = STATE_FILE.read_text(encoding="ascii").strip() if STATE_FILE.exists() else ""
        if previous and hmac.compare_digest(previous, digest):
            print(f"Anime DB is already current (Release updated {asset.get('updated_at')}).")
            return

    payload = download_asset(asset["url"], token)
    actual_digest = hashlib.sha256(payload).hexdigest()
    if digest and not hmac.compare_digest(actual_digest, digest):
        raise SystemExit("Release asset SHA-256 does not match GitHub metadata")
    with tempfile.TemporaryDirectory(prefix="anime-db-update-") as tmp:
        db_path = Path(tmp) / "anime_four_sources_multilingual_prepared.db"
        row_count = extract_database(payload, db_path)
        print(f"Validated Release DB: {row_count} source records; SHA-256 {actual_digest}")
        if args.dry_run:
            print("Dry run: PostgreSQL was not changed.")
            return

        repo = Path(__file__).resolve().parents[1]
        subprocess.run(["docker", "compose", "up", "-d", "db"], check=True, cwd=repo)
        importer = Path(__file__).resolve().with_name("import-anime-db.py")
        subprocess.run(["python3", str(importer), str(db_path)], check=True, cwd=repo)

    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary_state = STATE_FILE.with_suffix(".tmp")
    temporary_state.write_text(actual_digest + "\n", encoding="ascii")
    temporary_state.replace(STATE_FILE)
    print(f"Imported Release DB updated {asset.get('updated_at')}.")


if __name__ == "__main__":
    main()
