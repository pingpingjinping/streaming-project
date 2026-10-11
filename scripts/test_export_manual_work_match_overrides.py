import importlib.util
import json
import pathlib
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PATH = ROOT / "scripts/export-manual-work-match-overrides.py"
spec = importlib.util.spec_from_file_location("manual_export", PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManualWorkMatchExportTest(unittest.TestCase):
    def fake(self, reanime=(), anikoto=(), fail=False):
        def runner(command, **kwargs):
            self.assertEqual(command[:5], ["docker", "compose", "exec", "-T", "db"])
            self.assertNotIn("updated_by", command[-1])
            self.assertNotIn("relative_path", command[-1])
            if "anime_anikoto_work_overrides" in command[-1]:
                rows = anikoto
            elif "anime_work_match_overrides" in command[-1]:
                rows = reanime
            else:
                raise AssertionError("Unexpected database relation")
            return types.SimpleNamespace(
                stdout="\n".join(json.dumps(row) for row in rows) + ("\n" if rows else ""),
                returncode=1 if fail else 0, stderr="test")
        return runner

    def test_exact_provider_pairs_only_and_private_data_excluded(self):
        r1 = {"reanime_id": "second-season", "anissia_no": 2184}
        r2 = {"reanime_id": "one-piece", "anissia_no": 10}
        ak = {"anikoto_id": "an-id", "anissia_no": 2184, "mapping_kind": "whole",
              "anikoto_episode_start": None, "anikoto_episode_end": None,
              "target_episode_start": None, "target_episode_end": None}
        rows = module.export_rows(ROOT, self.fake([r1, r2], [ak]))
        self.assertEqual([r["reanime_id"] for r in rows["reanime"]],
                         ["one-piece", "second-season"])
        self.assertEqual(rows["anikoto"], [ak])
        output = json.dumps(rows)
        self.assertNotIn("updated_by", output)
        self.assertNotIn("relative_path", output)

    def test_reset_exports_explicit_empty_provider_lists(self):
        self.assertEqual(module.export_rows(ROOT, self.fake()),
                         {"reanime": [], "anikoto": []})

    def test_failed_db_query_never_becomes_empty_success(self):
        with self.assertRaisesRegex(RuntimeError, "Cannot read"):
            module.export_rows(ROOT, self.fake(fail=True))

    def test_duplicate_or_invalid_anikoto_ranges_fail(self):
        valid = {"anikoto_id": "ak-a", "anissia_no": 1, "mapping_kind": "range",
                 "anikoto_episode_start": 13, "anikoto_episode_end": 25,
                 "target_episode_start": 1, "target_episode_end": 13}
        self.assertEqual(len(module.export_rows(ROOT, self.fake(anikoto=[valid]))["anikoto"]), 1)
        for item in [
            {**valid, "target_episode_end": 12},
            {**valid, "anikoto_id": "bad/path"},
            {**valid, "anissia_no": "1"},
            {**valid, "updated_by": "private-admin"},
        ]:
            with self.subTest(item=item), self.assertRaises(ValueError):
                module.export_rows(ROOT, self.fake(anikoto=[item]))
        with self.assertRaises(ValueError):
            module.export_rows(ROOT, self.fake(anikoto=[valid, {**valid, "anikoto_id": "other"}]))


if __name__ == "__main__":
    unittest.main()
