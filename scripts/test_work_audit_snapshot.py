"""Offline regression for the Pi Work audit inventory; never touches Pi or PostgreSQL."""
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("prepare-work-audit.py")
SPEC = importlib.util.spec_from_file_location("prepare_work_audit", SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class WorkAuditTest(unittest.TestCase):
    def test_inventory_lists_zip_members_without_disclosing_user_uploads(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "subtitle-data"
            src = root / "anissia_subtitles" / "헬 모드 2기"
            src.mkdir(parents=True)
            (src / "01.srt").write_text("hello", encoding="utf-8")
            (src / ".hidden.srt").write_text("secret", encoding="utf-8")
            private = root / "uploads" / "someone"
            private.mkdir(parents=True)
            (private / "private.srt").write_text("do not export", encoding="utf-8")
            archive = src / "13화.zip"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("13화.srt", "sub")
            outside = Path(td) / "outside.srt"
            outside.write_text("outside", encoding="utf-8")
            (src / "symlink.srt").symlink_to(outside)
            output, members = Path(td) / "files.jsonl.gz", Path(td) / "members.csv.gz"
            totals = audit.scan_source_files(root, output, members)
            import gzip
            with gzip.open(output, "rt", encoding="utf-8") as f:
                lines = [json.loads(line) for line in f]
            paths = [row["path"] for row in lines]
            self.assertEqual(totals["file_count"], 2)
            self.assertEqual(totals["zip_count"], 1)
            self.assertEqual(totals["zip_member_count"], 1)
            self.assertTrue(any(p.endswith("/01.srt") for p in paths))
            self.assertFalse(any("private" in p or ".hidden" in p or "symlink" in p for p in paths))
            with gzip.open(members, "rt", encoding="utf-8") as f:
                rows = list(__import__("csv").DictReader(f))
            self.assertEqual(rows[0]["member_path"], "13화.srt")
            self.assertEqual((src / "01.srt").read_text(encoding="utf-8"), "hello")


if __name__ == "__main__":
    unittest.main()
