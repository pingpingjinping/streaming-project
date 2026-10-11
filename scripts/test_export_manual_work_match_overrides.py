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
    def fake(self, stdout="", returncode=0):
        def runner(command, **kwargs):
            self.assertEqual(command[:5], ["docker", "compose", "exec", "-T", "db"])
            self.assertIn("anime_work_match_overrides", command[-1])
            self.assertNotIn("updated_by", command[-1])
            self.assertNotIn("relative_path", command[-1])
            return types.SimpleNamespace(stdout=stdout, returncode=returncode, stderr="test")
        return runner

    def test_exact_id_pairs_only_sorted_and_private_data_excluded(self):
        raw = [
            {"reanime_id": "second-season", "anissia_no": 2184},
            {"reanime_id": "one-piece", "anissia_no": 10},
        ]
        rows = module.export_rows(ROOT, runner=self.fake(
            stdout="\n".join(json.dumps(x) for x in raw) + "\n"))
        self.assertEqual([row["reanime_id"] for row in rows],
                         ["one-piece", "second-season"])
        output = json.dumps(rows)
        self.assertNotIn("updated_by", output)
        self.assertNotIn("relative_path", output)

    def test_reset_can_export_an_explicit_empty_snapshot(self):
        self.assertEqual(module.export_rows(ROOT, runner=self.fake()), [])

    def test_failed_db_query_must_not_be_converted_into_empty_success(self):
        with self.assertRaisesRegex(RuntimeError, "Cannot read"):
            module.export_rows(ROOT, runner=self.fake(returncode=1))

    def test_duplicate_and_malformed_work_ids_fail(self):
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            module.export_rows(ROOT, runner=self.fake(
                stdout='{"reanime_id":"a","anissia_no":5}\n'
                       '{"reanime_id":"b","anissia_no":5}\n'))
        for row in ({"reanime_id": "bad/path", "anissia_no": 1},
                    {"reanime_id": "valid", "anissia_no": "1"},
                    {"reanime_id": "valid", "anissia_no": 0},
                    {"reanime_id": "valid", "anissia_no": 1, "updated_by": "admin"}):
            with self.subTest(row=row), self.assertRaises(ValueError):
                module.export_rows(ROOT, runner=self.fake(stdout=json.dumps(row)+"\n"))


if __name__ == "__main__":
    unittest.main()
