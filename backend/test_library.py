import concurrent.futures
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('library_api',Path(__file__).with_name('library_api.py'))
library=importlib.util.module_from_spec(spec);spec.loader.exec_module(library)


class LibraryTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=Path(self.temp.name)/'libraries.db'
        self.store=library.Store(self.path)
        self.movie=dict(id=1,title='Фильм',poster_path='/poster.jpg',release_date='1995',vote_average=8)

    def tearDown(self):
        self.temp.cleanup()

    def test_persistence_nickname_normalization_and_profile_isolation(self):
        self.store.apply(dict(nick='  MARIN ',action='add',movie=self.movie))
        self.assertEqual(library.Store(self.path).apply(dict(nick='marin'))['movies'][0]['id'],1)
        self.assertEqual(self.store.apply(dict(nick='other'))['movies'],[])
        self.assertEqual(self.store.apply(dict(nick='marin',action='remove',movie=self.movie))['movies'],[])

    def test_anime_and_movie_ids_are_independent(self):
        self.store.apply(dict(nick='nick',action='add',movie=self.movie))
        self.store.apply(dict(nick='nick',action='add',movie={**self.movie,'animeId':1}))
        self.assertEqual(len(self.store.apply(dict(nick='nick'))['movies']),2)

    def test_concurrent_additions_do_not_overwrite_each_other(self):
        def add(i):self.store.apply(dict(nick='nick',action='add',movie={**self.movie,'id':i}))
        with concurrent.futures.ThreadPoolExecutor(4) as pool:list(pool.map(add,range(1,21)))
        self.assertEqual(len(self.store.apply(dict(nick='nick'))['movies']),20)

    def test_import_limit_is_atomic(self):
        self.store.apply(dict(nick='nick',action='import',movies=[{**self.movie,'id':i} for i in range(1,101)]))
        with self.assertRaises(ValueError):self.store.apply(dict(nick='nick',action='add',movie={**self.movie,'id':101}))
        self.assertEqual(len(self.store.apply(dict(nick='nick'))['movies']),100)

    def test_invalid_keys_and_external_poster_urls_are_rejected(self):
        for nick in ['../secret','ab','a'*33]:
            with self.assertRaises(ValueError):self.store.apply(dict(nick=nick))
        with self.assertRaises(ValueError):self.store.apply(dict(nick='nick',action='add',movie={**self.movie,'poster_path':'//evil.test/a.jpg'}))


if __name__=='__main__':unittest.main()
