import json
import sqlite3
import unittest

from catalog_core import build_catalog, build_reanime_matches


class ValidatedAutomaticReferenceTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('''CREATE TABLE entries (
          source TEXT,source_record_id TEXT,year INTEGER,title_ko TEXT,title_native TEXT,
          title_romaji TEXT,title_english TEXT,existing_match_status TEXT,cross_source_ids_json TEXT)''')
        self.db.execute('CREATE TABLE anissia_year_match (anime_no INTEGER,review_label TEXT,same_year_match_status TEXT)')
        self.db.execute('''CREATE TABLE anissia_year_candidates (
          anime_no INTEGER,source TEXT,source_record_id TEXT,anilist_id TEXT,reanime_id TEXT,title_similarity REAL)''')
        self.db.execute('''CREATE TABLE monthly_auto_matches (
          reanime_id TEXT,anissia_no INTEGER,korean_title TEXT,evidence_json TEXT)''')
        self.add('AniList','100',native='別作品',english='Wrong Series')
        self.add('AniList','101',native='新作アニメ',english='Correct Series')
        self.add('ReAnime','correct',native='新作アニメ',english='Correct ReAnime',ani=['100','101'])
        self.add('ReAnime','stale',native='別作品',english='Stale ReAnime')

    def add(self,source,rid,ko='',native='',english='',ani=(),re=()):
        self.db.execute('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?)',
                        (source,rid,2026,ko,native,'',english,'',json.dumps({'anilist_ids':list(ani),'reanime_ids':list(re)})))

    def automatic(self,evidence):
        self.db.execute('INSERT INTO monthly_auto_matches VALUES (?,?,?,?)',
                        ('correct',1,'신작',json.dumps(evidence)))

    def read(self):
        catalog,aliases=build_catalog(self.db)
        return catalog[0],{alias:title for _,alias,title in aliases},catalog

    def test_v2_uses_verified_reference_and_auto_target_over_stale_declarations(self):
        self.add('Anissia','1',ko='신작',native='新作アニメ',ani=['100'],re=['stale'])
        self.automatic({'rule_version':2,'validated_anilist_ids':['101']})
        row,aliases,_=self.read()
        self.assertEqual((row['anilistId'],row['reanimeId']),('101','correct'))
        self.assertEqual(aliases['Correct Series'],'신작')
        self.assertNotIn('Wrong Series',aliases)
        self.assertNotIn('Stale ReAnime',aliases)

    def test_v2_empty_verified_ids_does_not_borrow_declared_id(self):
        self.add('Anissia','1',ko='신작',native='新作アニメ')
        self.automatic({'rule_version':2,'validated_anilist_ids':[]})
        row,aliases,_=self.read()
        self.assertEqual(row['anilistId'],'')
        self.assertEqual(row['reanimeId'],'correct')
        self.assertNotIn('Wrong Series',aliases)
        self.assertNotIn('Correct Series',aliases)

    def test_v2_missing_verified_ids_fails_closed(self):
        self.add('Anissia','1',ko='신작',native='新作アニメ')
        self.automatic({'rule_version':2})
        row,aliases,_=self.read()
        self.assertEqual(row['anilistId'],'')
        self.assertNotIn('Wrong Series',aliases)

    def test_zero_missing_and_duplicate_verified_ids_are_filtered(self):
        self.add('Anissia','1',ko='신작',native='新作アニメ')
        self.automatic({'rule_version':2,'validated_anilist_ids':['0','999','101','101']})
        row,_,_=self.read()
        self.assertEqual(row['anilistId'],'101')

    def test_legacy_automatic_evidence_remains_compatible(self):
        self.add('Anissia','1',ko='신작',native='新作アニメ')
        self.automatic({'evidence':['exact_title']})
        row,aliases,_=self.read()
        self.assertEqual((row['anilistId'],row['reanimeId']),('100','correct'))
        self.assertEqual(aliases['Wrong Series'],'신작')

    def test_reviewed_source_wins_over_stale_automatic_row(self):
        self.add('Anissia','1',ko='검토된 작품',native='別作品',ani=['100'],re=['stale'])
        self.automatic({'rule_version':2,'validated_anilist_ids':['101']})
        self.db.execute("INSERT INTO anissia_year_match VALUES (1,'검토된 사항','exact_title_same_year')")
        row,aliases,catalog=self.read()
        self.assertEqual((row['anilistId'],row['reanimeId']),('100','stale'))
        self.assertNotIn('Correct Series',aliases)
        matches=build_reanime_matches(self.db,catalog)
        self.assertEqual([r['reanimeId'] for r in matches],['stale'])

    def test_malformed_auto_evidence_does_not_lend_external_titles(self):
        self.add('Anissia','1',ko='신작',native='新作アニメ')
        self.db.execute('INSERT INTO monthly_auto_matches VALUES (?,?,?,?)',('correct',1,'신작','broken JSON'))
        row,aliases,_=self.read()
        self.assertEqual(row['anilistId'],'')
        self.assertNotIn('Wrong Series',aliases)


if __name__=='__main__':
    unittest.main()
