import fs from 'node:fs';
import os from 'node:os';

import upath from 'upath';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUTO_MIN_PAGES,
  chooseSplitIndexes,
  defaultJobs,
  layoutCacheKey,
  layoutCachePath,
  readLayoutCache,
  recordSplitResult,
  startsWithNamedPage,
  writeLayoutCache,
} from '../src/core/parallel-layout.js';
import { getTaskConfig } from './command-util.js';

describe('defaultJobs', () => {
  it('is 2 to 4', () => {
    expect(defaultJobs()).toBeGreaterThanOrEqual(2);
    expect(defaultJobs()).toBeLessThanOrEqual(4);
  });
});

describe('chooseSplitIndexes', () => {
  // 8 entries of 25 pages; entries 0, 2, 4, 6 start with a named page
  const docPages = [25, 25, 25, 25, 25, 25, 25, 25];
  const named = [true, false, true, false, true, false, true, false];
  const safe = { allowUnknown: false };

  it('splits before named entries so that the parts have similar numbers of pages', () => {
    expect(chooseSplitIndexes({ docPages, named, jobs: 2, ...safe })).toEqual({
      splitIndexes: [4],
      unverified: [],
    });
    expect(chooseSplitIndexes({ docPages, named, jobs: 4, ...safe })).toEqual({
      splitIndexes: [2, 4, 6],
      unverified: [],
    });
  });

  it('uses fewer parts when there are not enough entries to split before', () => {
    expect(
      chooseSplitIndexes({ docPages, named, jobs: 8, ...safe })?.splitIndexes,
    ).toEqual([2, 4, 6]);
  });

  it('does not make more parts than they are worth', () => {
    // 4 parts of 50 pages cost 90 (the biggest part and 10 for each part); 5 parts would not be better
    expect(
      chooseSplitIndexes({
        docPages: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20],
        named: Array.from({ length: 10 }, () => true),
        jobs: 8,
        ...safe,
      })?.splitIndexes,
    ).toHaveLength(4);
  });

  it('balances uneven entries', () => {
    // one big chapter and small ones: [10, 10, 100, 10, 10, 10]
    expect(
      chooseSplitIndexes({
        docPages: [10, 10, 100, 10, 10, 10],
        named: [true, true, true, true, true, true],
        jobs: 3,
        ...safe,
      })?.splitIndexes,
    ).toEqual([2, 3]);
  });

  it('splits only before the entries that start with a named page', () => {
    expect(
      chooseSplitIndexes({
        docPages: [50, 50, 50, 50],
        named: [true, false, true, false],
        jobs: 4,
        ...safe,
      })?.splitIndexes,
    ).toEqual([2]);
  });

  it('does not split a small book', () => {
    expect(
      chooseSplitIndexes({
        docPages: [10, 10, 10, 10],
        named: [true, true, true, true],
        jobs: 4,
      }),
    ).toBeUndefined();
    expect(AUTO_MIN_PAGES).toBe(150);
  });

  it('does not split without a named entry (the first entry does not count)', () => {
    expect(
      chooseSplitIndexes({
        docPages: [100, 100, 100],
        named: [true, false, false],
        jobs: 4,
        ...safe,
      }),
    ).toBeUndefined();
  });

  it('does not split when the biggest part is nearly as big as the book', () => {
    expect(
      chooseSplitIndexes({
        docPages: [190, 5, 5],
        named: [true, true, true],
        jobs: 3,
      }),
    ).toBeUndefined();
  });

  it('gives nothing when the numbers do not match', () => {
    expect(
      chooseSplitIndexes({ docPages: [100, 100], named: [true], jobs: 2 }),
    ).toBeUndefined();
  });

  describe('with entries that are not known to be safe', () => {
    // 6 entries of 30 pages; only the first starts with a named page
    const book = {
      docPages: [30, 30, 30, 30, 30, 30],
      named: [true, false, false, false, false, false],
      jobs: 4,
    };

    it('uses them when the biggest part would be too big otherwise', () => {
      expect(chooseSplitIndexes(book)).toEqual({
        splitIndexes: [2, 4],
        unverified: [2, 4],
      });
    });

    it('does not use them unless it is allowed', () => {
      expect(
        chooseSplitIndexes({ ...book, allowUnknown: false }),
      ).toBeUndefined();
    });

    it('does not tell the entries that were found to be safe as not known', () => {
      expect(chooseSplitIndexes({ ...book, verified: [2, 4] })).toEqual({
        splitIndexes: [2, 4],
        unverified: [],
      });
      expect(
        chooseSplitIndexes({ ...book, verified: [2], allowUnknown: true }),
      ).toEqual({ splitIndexes: [2, 4], unverified: [4] });
    });

    it('never splits before the entries that were found to be unsafe', () => {
      const result = chooseSplitIndexes({ ...book, unsafe: [4] });
      expect(result?.splitIndexes).not.toContain(4);
      expect(result?.unverified).toEqual(result?.splitIndexes);
    });

    it('does not use them when the named entries split the book well enough', () => {
      expect(chooseSplitIndexes({ docPages, named, jobs: 4 })).toEqual({
        splitIndexes: [2, 4, 6],
        unverified: [],
      });
    });
  });
});

describe('layout cache', () => {
  let cwd: string;
  beforeAll(() => {
    cwd = fs.mkdtempSync(upath.join(os.tmpdir(), 'vivliostyle-layout-'));
    for (const name of ['a', 'b']) {
      fs.writeFileSync(upath.join(cwd, `${name}.md`), `# ${name}\n`);
    }
  });
  afterAll(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('is kept for the same book only, and updated piece by piece', async () => {
    const config = await getTaskConfig([], cwd, {
      entry: ['a.md', 'b.md'],
      output: 'book.pdf',
    } as never);
    const path = layoutCachePath(config);
    const key = layoutCacheKey(config);
    // there is no node_modules, so the cache is in the workspace
    expect(path).toBe(upath.join(config.workspaceDir, '.parallel/cache.json'));
    expect(readLayoutCache(path, key)).toBeUndefined();

    writeLayoutCache(path, { key, docPages: [1, 2], named: [true, false] });
    writeLayoutCache(path, { key, frontPages: 5, docPages: [3, 4] });
    writeLayoutCache(path, { key, tocNumbers: { 'a.html': '6' } });
    expect(readLayoutCache(path, key)).toEqual({
      key,
      frontPages: 5,
      docPages: [3, 4],
      named: [true, false],
      tocNumbers: { 'a.html': '6' },
    });
    expect(readLayoutCache(path, 'another book')).toBeUndefined();
  });

  it('is put in the cache directory of the project if there is node_modules', async () => {
    fs.mkdirSync(upath.join(cwd, 'node_modules'));
    const config = await getTaskConfig([], cwd, {
      entry: ['a.md', 'b.md'],
      output: 'book.pdf',
    } as never);
    expect(layoutCachePath(config)).toBe(
      upath.join(
        cwd,
        'node_modules/.cache/vivliostyle-cli/parallel-build.json',
      ),
    );
  });

  it('remembers which entries are safe to split before, and which are not', async () => {
    const config = await getTaskConfig([], cwd, {
      entry: ['a.md', 'b.md'],
      output: 'book.pdf',
    } as never);
    const path = layoutCachePath(config);
    const key = layoutCacheKey(config);
    writeLayoutCache(path, { key, docPages: [1, 2], named: [true, false] });
    recordSplitResult(path, key, { verified: [3] });
    recordSplitResult(path, key, { verified: [3, 5] });
    expect(readLayoutCache(path, key)?.verified).toEqual([3, 5]);

    recordSplitResult(path, key, { unsafe: [7], hash: 'h1' });
    recordSplitResult(path, key, { unsafe: [8], hash: 'h1' });
    expect(readLayoutCache(path, key)?.unsafe).toEqual({
      hash: 'h1',
      entries: [7, 8],
    });
    // what was found for other contents is forgotten
    recordSplitResult(path, key, { unsafe: [9], hash: 'h2' });
    expect(readLayoutCache(path, key)?.unsafe).toEqual({
      hash: 'h2',
      entries: [9],
    });
    // the rest is kept
    expect(readLayoutCache(path, key)).toMatchObject({
      docPages: [1, 2],
      verified: [3, 5],
    });
  });

  it('has a key that does not depend on the workspace', async () => {
    const one = await getTaskConfig([], cwd, {
      entry: ['a.md', 'b.md'],
      output: 'book.pdf',
    } as never);
    const another = await getTaskConfig([], cwd, {
      entry: ['a.md', 'b.md'],
      output: 'book.pdf',
      workspaceDir: '.another-workspace',
    } as never);
    expect(layoutCacheKey(another)).toBe(layoutCacheKey(one));
    expect(JSON.parse(layoutCacheKey(one)).entries).toEqual(['a.md', 'b.md']);
  });

  it('has a key that changes with the entries', async () => {
    const one = await getTaskConfig([], cwd, {
      entry: ['a.md', 'b.md'],
      output: 'book.pdf',
    } as never);
    const another = await getTaskConfig([], cwd, {
      entry: ['b.md', 'a.md'],
      output: 'book.pdf',
    } as never);
    const withToc = await getTaskConfig([], cwd, {
      entry: ['a.md', 'b.md'],
      toc: true,
      output: 'book.pdf',
    } as never);
    expect(layoutCacheKey(one)).not.toBe(layoutCacheKey(another));
    expect(layoutCacheKey(one)).not.toBe(layoutCacheKey(withToc));
  });
});

describe('startsWithNamedPage', () => {
  // The function runs in the browser; jsdom-like behavior is checked in the real browser by the build tests
  it('is a function that takes no argument', () => {
    expect(startsWithNamedPage).toBeTypeOf('function');
    expect(startsWithNamedPage.length).toBe(0);
  });
});
