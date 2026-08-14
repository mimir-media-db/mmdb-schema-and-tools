import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { buildSeriesIndex, buildMovieIndex, buildPeopleIndex } from '../src/build-indexes.js';

const TEST_DIR = join(import.meta.dirname, '__fixtures__');

function createDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

describe('buildSeriesIndex', () => {
  const seriesDir = join(TEST_DIR, 'series');

  beforeEach(() => {
    createDir(seriesDir);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('flat file format (current)', () => {
    it('should index flat .json files in the series directory', () => {
      writeJson(join(seriesDir, 'breaking_bad.json'), {
        schema_version: 1,
        id: 's_breaking_bad',
        title: 'Breaking Bad',
        start_year: 2008,
        end_year: 2013,
        total_seasons: 5,
        total_episodes: 62
      });

      writeJson(join(seriesDir, 'the_wire.json'), {
        schema_version: 1,
        id: 's_the_wire',
        title: 'The Wire',
        start_year: 2002,
        end_year: 2008,
        total_seasons: 5,
        total_episodes: 60
      });

      const index = buildSeriesIndex(seriesDir);

      assert.strictEqual(index.length, 2);

      const breaking = index.find(e => e.id === 's_breaking_bad');
      assert.ok(breaking);
      assert.strictEqual(breaking.title, 'Breaking Bad');
      assert.strictEqual(breaking.start_year, 2008);
      assert.strictEqual(breaking.end_year, 2013);
      assert.strictEqual(breaking.path, 'data/series/breaking_bad.json');

      const wire = index.find(e => e.id === 's_the_wire');
      assert.ok(wire);
      assert.strictEqual(wire.title, 'The Wire');
      assert.strictEqual(wire.path, 'data/series/the_wire.json');
    });

    it('should skip index.json', () => {
      writeJson(join(seriesDir, 'index.json'), []);
      writeJson(join(seriesDir, 'show_a.json'), {
        id: 's_show_a',
        title: 'Show A',
        start_year: 2020,
        end_year: null
      });

      const index = buildSeriesIndex(seriesDir);
      assert.strictEqual(index.length, 1);
      assert.strictEqual(index[0].id, 's_show_a');
    });

    it('should handle end_year being null', () => {
      writeJson(join(seriesDir, 'ongoing.json'), {
        id: 's_ongoing',
        title: 'Ongoing Show',
        start_year: 2022,
        end_year: null
      });

      const index = buildSeriesIndex(seriesDir);
      assert.strictEqual(index.length, 1);
      assert.strictEqual(index[0].end_year, null);
    });

    it('should sort entries by id', () => {
      writeJson(join(seriesDir, 'zebra.json'), {
        id: 's_zebra',
        title: 'Zebra',
        start_year: 2020,
        end_year: null
      });
      writeJson(join(seriesDir, 'alpha.json'), {
        id: 's_alpha',
        title: 'Alpha',
        start_year: 2019,
        end_year: 2021
      });

      const index = buildSeriesIndex(seriesDir);
      assert.strictEqual(index[0].id, 's_alpha');
      assert.strictEqual(index[1].id, 's_zebra');
    });

    it('should return empty array for empty directory', () => {
      const index = buildSeriesIndex(seriesDir);
      assert.strictEqual(index.length, 0);
    });

    it('should skip non-json files', () => {
      writeFileSync(join(seriesDir, 'README.md'), '# Series\n');
      writeJson(join(seriesDir, 'show.json'), {
        id: 's_show',
        title: 'Show',
        start_year: 2020,
        end_year: null
      });

      const index = buildSeriesIndex(seriesDir);
      assert.strictEqual(index.length, 1);
    });
  });

  describe('directory format (legacy)', () => {
    it('should index series stored as directories with meta.json', () => {
      const seriesSubDir = join(seriesDir, 'breaking_bad');
      createDir(seriesSubDir);
      writeJson(join(seriesSubDir, 'meta.json'), {
        id: 's_breaking_bad',
        title: 'Breaking Bad',
        start_year: 2008,
        end_year: 2013
      });

      const index = buildSeriesIndex(seriesDir);
      assert.strictEqual(index.length, 1);
      assert.strictEqual(index[0].id, 's_breaking_bad');
      assert.strictEqual(index[0].path, 'data/series/breaking_bad/meta.json');
    });

    it('should skip directories without meta.json', () => {
      const emptySubDir = join(seriesDir, 'empty_show');
      createDir(emptySubDir);

      const index = buildSeriesIndex(seriesDir);
      assert.strictEqual(index.length, 0);
    });
  });

  describe('mixed format', () => {
    it('should handle both flat files and directories together', () => {
      // Flat file
      writeJson(join(seriesDir, 'flat_show.json'), {
        id: 's_flat_show',
        title: 'Flat Show',
        start_year: 2020,
        end_year: null
      });

      // Directory with meta.json
      const subDir = join(seriesDir, 'dir_show');
      createDir(subDir);
      writeJson(join(subDir, 'meta.json'), {
        id: 's_dir_show',
        title: 'Dir Show',
        start_year: 2018,
        end_year: 2020
      });

      const index = buildSeriesIndex(seriesDir);
      assert.strictEqual(index.length, 2);
      assert.ok(index.find(e => e.id === 's_flat_show'));
      assert.ok(index.find(e => e.id === 's_dir_show'));
    });
  });
});

describe('buildMovieIndex', () => {
  const moviesDir = join(TEST_DIR, 'movies');

  beforeEach(() => {
    createDir(moviesDir);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('should index movie .json files', () => {
    writeJson(join(moviesDir, 'inception_2010.json'), {
      id: 'm_inception_2010',
      title: 'Inception',
      year: 2010,
      type: 'movie',
      runtime_minutes: 148
    });

    const index = buildMovieIndex(moviesDir);
    assert.strictEqual(index.length, 1);
    assert.strictEqual(index[0].id, 'm_inception_2010');
    assert.strictEqual(index[0].title, 'Inception');
    assert.strictEqual(index[0].year, 2010);
    assert.strictEqual(index[0].path, 'data/movies/inception_2010.json');
  });

  it('should skip index.json', () => {
    writeJson(join(moviesDir, 'index.json'), []);
    writeJson(join(moviesDir, 'movie.json'), {
      id: 'm_movie_2010',
      title: 'Movie',
      year: 2010,
      type: 'movie',
      runtime_minutes: 120
    });

    const index = buildMovieIndex(moviesDir);
    assert.strictEqual(index.length, 1);
  });

  it('should sort by id', () => {
    writeJson(join(moviesDir, 'z_movie.json'), {
      id: 'm_z_movie_2010',
      title: 'Z Movie',
      year: 2010,
      type: 'movie',
      runtime_minutes: 90
    });
    writeJson(join(moviesDir, 'a_movie.json'), {
      id: 'm_a_movie_2010',
      title: 'A Movie',
      year: 2010,
      type: 'movie',
      runtime_minutes: 100
    });

    const index = buildMovieIndex(moviesDir);
    assert.strictEqual(index[0].id, 'm_a_movie_2010');
    assert.strictEqual(index[1].id, 'm_z_movie_2010');
  });
});
