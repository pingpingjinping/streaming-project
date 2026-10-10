import importlib.util
import pathlib
import types
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
SCRIPT=ROOT/"scripts/export-db-search-posters.py"
spec=importlib.util.spec_from_file_location("poster_export",SCRIPT)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PiArtworkExportTests(unittest.TestCase):
    def test_only_verified_public_urls_without_private_fields(self):
        expected=[{"work_id":"db_Onnada_10","poster":"https://cdn.example/poster.jpg","source":"ReAnime"}]
        result=module.export_rows(ROOT,runner=lambda *args,**kwargs:
            types.SimpleNamespace(returncode=0,stdout='{"work_id":"db_Onnada_10","poster":"https://cdn.example/poster.jpg","source":"ReAnime"}\n',stderr=""))
        self.assertEqual(result,expected)
        self.assertEqual(set(result[0]),{"work_id","poster","source"})

    def test_unsafe_input_and_account_or_path_fields_rejected(self):
        for row in [
            {"work_id":"db_Onnada_10","poster":"http://private.example","source":"AniList"},
            {"work_id":"db_Onnada_10","poster":"https://person:secret@cdn.example/abc","source":"AniList"},
            {"work_id":"../../db","poster":"https://cdn.example/x.jpg","source":"AniList"},
            {"work_id":"db_Onnada_10","poster":"https://cdn.example/x.jpg","source":"AniList","user_id":"private"},
        ]:
            with self.subTest(row=row), self.assertRaises(ValueError):
                module.sanitize([row])

    def test_missing_cache_table_is_initially_allowed(self):
        result=module.export_rows(ROOT,runner=lambda *args,**kwargs:
            types.SimpleNamespace(returncode=1,stdout="",stderr='ERROR: relation "anime_search_poster_cache" does not exist'))
        self.assertEqual(result,[])

    def test_other_postgres_failures_are_not_misreported_as_empty_cache(self):
        with self.assertRaises(RuntimeError):
            module.export_rows(ROOT,runner=lambda *args,**kwargs:
                types.SimpleNamespace(returncode=1,stdout="",stderr="connection refused"))


if __name__=="__main__":unittest.main()
