import importlib.util
import json
import pathlib
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PATH = ROOT / "scripts/export-reviewed-subtitle-work-links.py"
spec = importlib.util.spec_from_file_location("reviewed_export", PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExportReviewedWorkLinksTest(unittest.TestCase):
    def fake(self, returncode=0, stdout="", stderr=""):
        def run(command, **kwargs):
            self.assertEqual(command[:5], ["docker", "compose", "exec", "-T", "db"])
            self.assertIn("anime_admin_subtitle_links", command[-1])
            self.assertNotIn("updated_by", command[-1])
            self.assertEqual(kwargs["cwd"], ROOT)
            return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)
        return run

    def test_private_path_never_leaves_streaming_project(self):
        data = {"members":["ani_1", "re_toradora"], "title":"토라도라", "kind":"main","season":1}
        rows = module.export_rows(ROOT, runner=self.fake(stdout=json.dumps(data)+"\n"))
        encoded=json.dumps(rows,ensure_ascii=False)
        self.assertEqual(rows,[data])
        self.assertNotIn("relative_path",encoded)
        self.assertNotIn("updated_by",encoded)
        self.assertNotIn("file_name",encoded)

    def test_database_error_fails_not_empty_success(self):
        with self.assertRaisesRegex(RuntimeError,"Cannot read"):
            module.export_rows(ROOT,runner=self.fake(returncode=1,stderr="relation missing"))

    def test_unexpected_source_shape_fails(self):
        with self.assertRaises(ValueError):
            module.export_rows(ROOT,runner=self.fake(stdout='{"relative_path":"/private","members":[]}\n'))

    def test_no_links_is_valid_empty_snapshot(self):
        self.assertEqual(module.export_rows(ROOT,runner=self.fake()), [])


if __name__ == "__main__":
    unittest.main()
