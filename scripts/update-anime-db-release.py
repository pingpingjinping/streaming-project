#!/usr/bin/env python3
"""Download and import the private anime DB Release assets on the Pi."""
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
CATALOG_ASSET_NAME = "anime_four_sources_multilingual_prepared.zip"
REGISTRY_ASSET_NAME = "anime_reviewed_subtitle_registry_v1.zip"
MAX_ASSET_SIZE = 128 * 1024 * 1024
EXPECTED_SOURCES = {"AniList", "ReAnime", "Onnada", "Anissia"}
STATE_FILE = Path.home() / ".local/state/streaming-project/anime-db-release.sha256"
REGISTRY_STATE_FILE = Path.home() / ".local/state/streaming-project/anime-db-reviewed-subtitles-v1.sha256"
CATALOG_SCHEMA_STATE_FILE = Path.home() / ".local/state/streaming-project/anime-db-catalog-import-schema-version"
REGISTRY_SCHEMA_STATE_FILE = Path.home() / ".local/state/streaming-project/anime-db-registry-import-schema-version"
IMPORT_SCHEMA_VERSION = "3"


def has_reviewed_registry(db_path):
    with sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True) as db:
        exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='subtitle_runtime_metadata'"
        ).fetchone()
        if not exists:
            return False
        metadata = {
            key: json.loads(value)
            for key, value in db.execute("SELECT key,value FROM subtitle_runtime_metadata")
        }
        if metadata.get("format_version") != 1 or metadata.get("completed_bundles") != 1109:
            raise RuntimeError("Unsupported or incomplete reviewed subtitle registry")
        return True


def run_catalog_importer(db_path, repo):
    subprocess.run(
        ["python3", str(Path(repo) / "scripts/import-anime-db.py"), str(db_path)],
        check=True,
        cwd=repo,
    )
    refresher = Path(repo) / "scripts/refresh-reviewed-subtitle-links.py"
    if refresher.is_file():
        subprocess.run(["python3", str(refresher), str(db_path)], check=True, cwd=repo)


def run_registry_importer(db_path, repo):
    if not has_reviewed_registry(db_path):
        raise RuntimeError("Release asset does not contain the reviewed subtitle registry")
    subtitle_importer = Path(repo) / "scripts/import-reviewed-subtitles.py"
    if not subtitle_importer.is_file():
        raise RuntimeError(
            "Release contains reviewed subtitles; update the repository to install import-reviewed-subtitles.py"
        )
    subprocess.run(["python3", str(subtitle_importer), str(db_path)], check=True, cwd=repo)


def run_importers(db_path, repo, catalog_current=False):
    """Backward-compatible helper for tests and legacy callers.

    A combined legacy database imports the catalog unless already current and imports
    the embedded registry when present.
    """
    reviewed = has_reviewed_registry(db_path)
    if not catalog_current:
        run_catalog_importer(db_path, repo)
    if reviewed:
        run_registry_importer(db_path, repo)
    return reviewed


def write_state(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(value + "\n", encoding="ascii")
    temporary.replace(path)


def read_state(path):
    return path.read_text(encoding="ascii").strip() if path.exists() else ""


def api_json(url, token):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "streaming-project-anime-db-updater/2.0",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download_asset(asset_url, token):
    request = urllib.request.Request(
        asset_url,
        headers={
            "Accept": "application/octet-stream",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "streaming-project-anime-db-updater/2.0",
        },
    )
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
            parsed.hostname == "github.com"
            or (parsed.hostname or "").endswith(".githubusercontent.com")
        ):
            raise RuntimeError("GitHub returned an unexpected asset download host")
        # The redirected URL is signed; never forward the GitHub token to that host.
        with urllib.request.urlopen(location, timeout=120) as response:
            payload = response.read(MAX_ASSET_SIZE + 1)
    if len(payload) > MAX_ASSET_SIZE:
        raise RuntimeError(f"Release asset exceeds {MAX_ASSET_SIZE} bytes")
    return payload


def extract_sqlite(payload, destination):
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            candidates = [
                item
                for item in archive.infolist()
                if not item.is_dir()
                and item.filename.lower().endswith((".db", ".db.gz", ".sqlite"))
            ]
            if len(candidates) != 1:
                raise RuntimeError(
                    f"Expected one SQLite DB in Release ZIP, found {len(candidates)}"
                )
            contents = archive.read(candidates[0])
    except zipfile.BadZipFile as error:
        raise RuntimeError("Release asset is not a valid ZIP file") from error

    source = (
        gzip.GzipFile(fileobj=io.BytesIO(contents))
        if contents.startswith(b"\x1f\x8b")
        else io.BytesIO(contents)
    )
    with source, open(destination, "wb") as output:
        while chunk := source.read(1024 * 1024):
            output.write(chunk)

    with sqlite3.connect(destination) as db:
        result = db.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {result}")


def validate_catalog_database(db_path):
    with sqlite3.connect(db_path) as db:
        sources = {row[0] for row in db.execute("SELECT DISTINCT source FROM entries")}
        missing = EXPECTED_SOURCES - sources
        if missing:
            raise RuntimeError(f"Database is missing expected sources: {sorted(missing)}")
        count = db.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        if count <= 0:
            raise RuntimeError("Database contains no source records")
    return count


def validate_registry_database(db_path):
    if not has_reviewed_registry(db_path):
        raise RuntimeError("Reviewed subtitle registry metadata is missing")
    with sqlite3.connect(db_path) as db:
        runtime = db.execute(
            """SELECT 1 FROM sqlite_master
               WHERE name IN ('subtitle_runtime_files','subtitle_runtime_files_export')
                 AND type IN ('table','view') LIMIT 1"""
        ).fetchone()
        if not runtime:
            raise RuntimeError("Reviewed subtitle registry has no runtime file export")
    return True


def release_asset(release, name, required=True):
    matches = [asset for asset in release.get("assets", []) if asset.get("name") == name]
    if len(matches) == 1:
        asset = matches[0]
        if asset.get("state") != "uploaded":
            raise RuntimeError(f"Release asset is not ready: {name}: {asset.get('state')}")
        return asset
    if not matches and not required:
        return None
    raise RuntimeError(f"Expected exactly one {name} asset in db-v1, found {len(matches)}")


def metadata_digest(asset):
    value = (asset.get("digest") or "").strip()
    return value.removeprefix("sha256:") if value.startswith("sha256:") else ""


def is_current(asset, digest_state, schema_state):
    digest = metadata_digest(asset)
    previous = read_state(digest_state)
    schema_previous = read_state(schema_state)
    return bool(
        digest
        and previous
        and hmac.compare_digest(previous, digest)
        and hmac.compare_digest(schema_previous, IMPORT_SCHEMA_VERSION)
    )


def fetch_asset_database(asset, token, destination):
    payload = download_asset(asset["url"], token)
    expected = metadata_digest(asset)
    actual = hashlib.sha256(payload).hexdigest()
    if expected and not hmac.compare_digest(actual, expected):
        raise RuntimeError(f"{asset.get('name')} SHA-256 does not match GitHub metadata")
    extract_sqlite(payload, destination)
    return actual


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument(
        "--catalog-only",
        action="store_true",
        help="Download/import only the catalog asset",
    )
    scope.add_argument(
        "--registry-only",
        action="store_true",
        help="Download/import only the reviewed subtitle registry asset",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Download and validate selected Release assets without importing them",
    )
    args = parser.parse_args()

    token = os.environ.get("ANIME_DB_GITHUB_TOKEN", "").strip()
    if not token:
        raise SystemExit("ANIME_DB_GITHUB_TOKEN is not set")

    release = api_json(RELEASE_API, token)
    catalog_asset = release_asset(release, CATALOG_ASSET_NAME)
    registry_asset = release_asset(release, REGISTRY_ASSET_NAME, required=False)
    want_catalog = not args.registry_only
    want_registry = not args.catalog_only

    catalog_current = is_current(catalog_asset, STATE_FILE, CATALOG_SCHEMA_STATE_FILE)
    registry_source_asset = registry_asset or catalog_asset
    registry_current = is_current(
        registry_source_asset, REGISTRY_STATE_FILE, REGISTRY_SCHEMA_STATE_FILE
    )

    if (
        not args.dry_run
        and (not want_catalog or catalog_current)
        and (not want_registry or registry_current)
    ):
        print(
            f"Selected anime DB assets are already current "
            f"(Release updated {catalog_asset.get('updated_at')})."
        )
        return

    repo = Path(__file__).resolve().parents[1]
    if not args.dry_run:
        subprocess.run(["docker", "compose", "up", "-d", "db"], check=True, cwd=repo)

    with tempfile.TemporaryDirectory(prefix="anime-db-update-") as tmp:
        tmp = Path(tmp)
        catalog_db = tmp / "anime_catalog.db"
        catalog_digest = None

        need_catalog_download = want_catalog and (args.dry_run or not catalog_current)
        legacy_registry_needed = (
            want_registry
            and registry_asset is None
            and (args.dry_run or not registry_current)
        )
        if need_catalog_download or legacy_registry_needed:
            catalog_digest = fetch_asset_database(
                catalog_asset, token, catalog_db
            )
            row_count = validate_catalog_database(catalog_db)
            print(
                f"Validated catalog Release DB: {row_count} source records; "
                f"SHA-256 {catalog_digest}"
            )

        if want_catalog and (args.dry_run or not catalog_current):
            if not args.dry_run:
                run_catalog_importer(catalog_db, repo)
                write_state(STATE_FILE, catalog_digest)
                write_state(CATALOG_SCHEMA_STATE_FILE, IMPORT_SCHEMA_VERSION)
                print(
                    f"Imported catalog asset updated {catalog_asset.get('updated_at')}."
                )

        if want_registry:
            if registry_asset is not None:
                if args.dry_run or not registry_current:
                    registry_db = tmp / "subtitle_registry.db"
                    registry_digest = fetch_asset_database(
                        registry_asset, token, registry_db
                    )
                    validate_registry_database(registry_db)
                    print(
                        f"Validated reviewed subtitle registry; SHA-256 {registry_digest}"
                    )
                    if not args.dry_run:
                        run_registry_importer(registry_db, repo)
                        write_state(REGISTRY_STATE_FILE, registry_digest)
                        write_state(
                            REGISTRY_SCHEMA_STATE_FILE, IMPORT_SCHEMA_VERSION
                        )
                        print(
                            f"Imported registry asset updated "
                            f"{registry_asset.get('updated_at')}."
                        )
                elif not args.catalog_only:
                    print("Reviewed subtitle registry is already current.")
            elif args.dry_run or not registry_current:
                if not catalog_db.exists():
                    catalog_digest = fetch_asset_database(
                        catalog_asset, token, catalog_db
                    )
                    validate_catalog_database(catalog_db)
                if has_reviewed_registry(catalog_db):
                    print(
                        "Separate registry asset is not published yet; "
                        "validated legacy embedded registry."
                    )
                    if not args.dry_run:
                        run_registry_importer(catalog_db, repo)
                        write_state(REGISTRY_STATE_FILE, catalog_digest)
                        write_state(
                            REGISTRY_SCHEMA_STATE_FILE, IMPORT_SCHEMA_VERSION
                        )
                        print("Imported legacy embedded reviewed subtitle registry.")
                else:
                    print(
                        "No reviewed subtitle registry asset is published and "
                        "the catalog does not contain a legacy embedded registry."
                    )

    if args.dry_run:
        print("Dry run: PostgreSQL and updater state were not changed.")


if __name__ == "__main__":
    main()
