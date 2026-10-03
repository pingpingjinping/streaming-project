import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("weekly", Path(__file__).with_name("match-weekly-aniall.py"))
weekly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(weekly)


class WeeklyAniAllTests(unittest.TestCase):
    def reference(self, rows):
        return {"catalog": rows, "aliases": [], "protected": []}

    def work(self, title, english="", year=2026):
        return {"title": title, "englishTitle": english, "nativeTitle": "", "year": year}

    def post(self, title, post_id="100"):
        return {"post_id": post_id, "title": title, "post_url": f"https://aniall.tistory.com/{post_id}"}

    def test_exact_english_alias_and_s01_match_without_fuzzy_promotion(self):
        ref = self.reference([self.work("별빛 마법사", "Starlight Mage")])
        report, matches, _ = weekly.review_posts([self.post("Starlight Mage S01")], ref)
        self.assertEqual(report[0]["match_kind"], "exact")
        self.assertEqual(matches[0]["candidateTitle"], "별빛 마법사")
        _, fuzzy, _ = weekly.review_posts([self.post("Starlight Mag")], ref)
        self.assertEqual(fuzzy, [])

    def test_season_range_format_and_year_conflicts_are_not_auto_confirmed(self):
        ref = self.reference([self.work("별빛 마법사", "Starlight Mage"),
                              self.work("별빛 마법사 2기", "Starlight Mage Season 2")])
        for title in ("Starlight Mage S01-S02", "Starlight Mage Season 1-2",
                      "Starlight Mage Season1-Season2", "별빛 마법사 1기-2기",
                      "별빛 마법사 1~2기", "Starlight Mage OVA", "Starlight Mage (2020)"):
            with self.subTest(title=title):
                self.assertEqual(weekly.review_posts([self.post(title)], ref)[1], [])

    def test_ambiguous_remakes_and_human_review_are_preserved(self):
        ref = self.reference([self.work("별빛 마법사", "Starlight Mage", 2000),
                              self.work("별빛 마법사", "Starlight Mage", 2026)])
        self.assertEqual(weekly.review_posts([self.post("Starlight Mage")], ref)[1], [])
        ref = self.reference([self.work("별빛 마법사", "Starlight Mage")])
        ref["protected"] = ["100"]
        report, matches, candidates = weekly.review_posts([self.post("Starlight Mage")], ref)
        self.assertEqual((matches, candidates), ([], []))
        self.assertEqual(report[0]["match_kind"], "preserved_human_review")

    def test_checkpoint_scope_excludes_old_reviewed_corpus_missing_files_and_completed_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            relative = "aniall_subtitles/100__제목/all.zip"
            file = target / relative
            file.parent.mkdir(parents=True)
            file.write_bytes(b"test")
            item = {"source": "aniall", "post_id": "100", "title": "제목",
                    "source_url": "https://aniall.tistory.com/100"}
            state = {"success": {"aniall:100": {"item": item, "files": [relative]}}}
            self.assertEqual(len(weekly.pending_posts(state, {"posts": {}}, target)), 1)
            self.assertEqual(weekly.pending_posts(state, {"posts": {"100": {}}}, target), [])
            state["success"]["aniall:100"]["files"] = ["aniall_subtitles/제목/all.zip"]
            self.assertEqual(weekly.pending_posts(state, {"posts": {}}, target), [])
            state["success"]["aniall:100"]["files"] = [relative]
            file.unlink()
            self.assertEqual(weekly.pending_posts(state, {"posts": {}}, target), [])

    def test_title_folder_requires_exact_manifest_identity_and_unchanged_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder);relative="aniall_subtitles/제목/all.zip";file=target/relative
            file.parent.mkdir(parents=True);file.write_bytes(b"downloaded")
            item={"source":"aniall","post_id":"100","title":"제목","source_url":"https://aniall.tistory.com/100"}
            state={"success":{"aniall:100":{"item":item,"files":[relative]}}}
            self.assertEqual(weekly.pending_posts(state,{"posts":{}},target),[])
            record={"sha256":hashlib.sha256(b"downloaded").hexdigest(),"sources":[{"source":"aniall","id":"100"}]}
            (target/".weekly-subtitle-sources.json").write_text(json.dumps({"version":1,"files":{relative:record}}))
            self.assertEqual(len(weekly.pending_posts(state,{"posts":{}},target)),1)
            state["success"]["aniall:100"]["item"]={**item,"post_id":"101","source_url":"https://aniall.tistory.com/101"}
            self.assertEqual(weekly.pending_posts(state,{"posts":{}},target),[])
            state["success"]["aniall:100"]["item"]=item;file.write_bytes(b"changed")
            self.assertEqual(weekly.pending_posts(state,{"posts":{}},target),[])

    def test_failed_import_does_not_checkpoint_and_dry_run_does_not_import(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            relative = "aniall_subtitles/100__Starlight Mage/all.zip"
            file = target / relative
            file.parent.mkdir(parents=True)
            file.write_bytes(b"test")
            state = target / "queue.json"
            state.write_text(json.dumps({"success": {"aniall:100": {
                "item": {"source": "aniall", "post_id": "100", "title": "Starlight Mage",
                         "source_url": "https://aniall.tistory.com/100"}, "files": [relative]}}}))
            argv = ["match-weekly-aniall.py", "--queue-state", str(state), "--target", str(target)]
            ref = self.reference([self.work("별빛 마법사", "Starlight Mage")])
            with patch.object(weekly, "catalog_from_postgres", return_value=ref), patch.object(sys, "argv", argv):
                with patch.object(weekly.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "import")):
                    with self.assertRaises(subprocess.CalledProcessError):
                        weekly.main()
                self.assertFalse((target / "aniall-weekly-matching.json").exists())
            with patch.object(weekly, "catalog_from_postgres", return_value=ref), patch.object(sys, "argv", argv + ["--dry-run"]):
                with patch.object(weekly.subprocess, "run") as importer:
                    weekly.main()
                    importer.assert_not_called()
                self.assertFalse((target / "aniall-weekly-matching.json").exists())


if __name__ == "__main__":
    unittest.main()
