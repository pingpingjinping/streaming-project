#!/usr/bin/env python3
"""Match only new, successfully downloaded AniAll posts against the Pi catalog.

No crawl, catalog download, reviewed registry write, or episode assignment.
Existing monthly match criteria and protected importers are reused unchanged.
"""
import argparse
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = load_module("aniall_audit", "audit-aniall-subtitles.py")
exporter = load_module("aniall_export", "export-aniall-auto-matches.py")


def pending_posts(queue_state, checkpoint, target):
    posts = {}
    for entry in queue_state.get("success", {}).values():
        item = entry.get("item") or {}
        post_id = str(item.get("post_id") or "")
        title = str(item.get("title") or "").strip()
        url = str(item.get("source_url") or "")
        if (item.get("source") != "aniall" or not re.fullmatch(r"[1-9]\d*", post_id)
                or not title or url != f"https://aniall.tistory.com/{post_id}"):
            continue
        if post_id in checkpoint.get("posts", {}):
            continue
        files = entry.get("files") or []
        # Old title-only corpus folders belong to the existing monthly/review
        # pipeline. Restrict this checkpoint to the new post-ID layout.
        if not files:
            continue
        eligible = True
        for relative in files:
            path = Path(relative)
            if (path.is_absolute() or ".." in path.parts or len(path.parts) < 3
                    or path.parts[0] != "aniall_subtitles"
                    or not path.parts[1].startswith(f"{post_id}__")
                    or not (target / path).is_file()):
                eligible = False
                break
        if eligible:
            posts[post_id] = {"post_id": post_id, "title": title, "post_url": url}
    return [posts[key] for key in sorted(posts, key=int)]


def catalog_from_postgres(streaming):
    # Read only catalog titles/aliases and protected AniAll post IDs. The
    # reviewed subtitle registry and confirmed episodes are never queried.
    sql = """SELECT json_build_object(
      'catalog', COALESCE((SELECT json_agg(payload) FROM anime_korean_catalog), '[]'::json),
      'aliases', COALESCE((SELECT json_agg(json_build_array(normalized_title, original_title, korean_title))
                          FROM anime_title_aliases), '[]'::json),
      'has_matches', to_regclass('anime_aniall_matches') IS NOT NULL);"""
    cmd = ["docker", "compose", "exec", "-T", "db", "sh", "-c",
           'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"']
    result = subprocess.run(cmd, input=sql, text=True, capture_output=True, cwd=streaming, check=True)
    reference = json.loads(result.stdout)
    reference["protected"] = []
    if reference.pop("has_matches"):
        result = subprocess.run(cmd, input="SELECT COALESCE(json_agg(DISTINCT post_id), '[]'::json) "
                                "FROM anime_aniall_matches WHERE review_status NOT LIKE 'auto_%';",
                                text=True, capture_output=True, cwd=streaming, check=True)
        reference["protected"] = json.loads(result.stdout)
    return reference


def review_posts(posts, reference):
    if not reference["catalog"]:
        raise RuntimeError("No current catalog; refusing to checkpoint incomplete matching")
    _catalog, exact, keys, trigram = audit.build_catalog_reference_index(
        reference["catalog"], reference["aliases"])
    protected = {str(value) for value in reference["protected"]}
    report = []
    for post in posts:
        if post["post_id"] in protected:
            result = {**post, "match_kind": "preserved_human_review"}
        else:
            result = {**post, **audit.match_post(post["title"], exact, keys, trigram)}
        report.append(result)
    reviewed = [{"postId": value} for value in protected]
    matches = exporter.export(report, reviewed)
    for row in matches:
        row["evidence"] = "Weekly successful download: exact alias and compatible season/year/format"
    return report, matches, exporter.candidate_rows(report, reviewed)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue-state", type=Path, default=Path.home() / ".local/state/anime-db-download/subtitle-queue-state.json")
    parser.add_argument("--target", type=Path, default=SCRIPTS.parent / "subtitle-data")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not args.queue_state.exists():
        print("No successful weekly downloads yet.")
        return
    checkpoint_path = args.target / "aniall-weekly-matching.json"
    checkpoint = json.loads(checkpoint_path.read_text()) if checkpoint_path.exists() else {"posts": {}}
    posts = pending_posts(json.loads(args.queue_state.read_text()), checkpoint, args.target)
    if not posts:
        print("No new AniAll downloaded posts to match.")
        return
    report, matches, candidates = review_posts(posts, catalog_from_postgres(SCRIPTS.parent))
    print(f"Weekly AniAll: {len(posts)} posts; {len(matches)} exact links; {len(candidates)} candidate rows.")
    if args.dry_run:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    with tempfile.TemporaryDirectory() as folder:
        for filename, rows, importer in (
                ("matches.json", matches, "import-aniall-matches.py"),
                ("candidates.json", candidates, "import-aniall-candidates.py")):
            if not rows:
                continue
            path = Path(folder) / filename
            atomic_json(path, rows)
            subprocess.run([sys.executable, str(SCRIPTS / importer), str(path)], cwd=SCRIPTS.parent, check=True)
    # Only checkpoint after both DB imports succeeded. Candidate/unmatched
    # decisions remain explicitly unresolved; this is not a confirmation flag.
    for row in report:
        checkpoint["posts"][row["post_id"]] = row
    atomic_json(checkpoint_path, checkpoint)


if __name__ == "__main__":
    main()
