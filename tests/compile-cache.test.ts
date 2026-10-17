import fs from 'node:fs';
import os from 'node:os';

import upath from 'upath';
import * as v from 'valibot';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { VivliostyleConfigSchema } from '../src/config/schema.js';
import {
  CompileCache,
  compileCacheDir,
  createCompileCache,
  hashConfigSide,
  injectStyle,
  listFiles,
  parseSize,
} from '../src/processor/compile-cache.js';
import { getTaskConfig } from './command-util.js';

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(upath.join(os.tmpdir(), 'vivliostyle-compile-cache-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

let counter = 0;
const newDir = (): string => {
  const dir = upath.join(root, `case-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

describe('parseSize', () => {
  it('reads numbers and sizes with units', () => {
    expect(parseSize(1000)).toBe(1000);
    expect(parseSize('2048')).toBe(2048);
    expect(parseSize('512MB')).toBe(512 * 1024 ** 2);
    expect(parseSize('1.5 gb')).toBe(1.5 * 1024 ** 3);
    expect(parseSize('10kb')).toBe(10 * 1024);
  });

  it('uses 512MB for something else', () => {
    expect(parseSize()).toBe(512 * 1024 ** 2);
    expect(parseSize('big')).toBe(512 * 1024 ** 2);
    expect(parseSize(-1)).toBe(512 * 1024 ** 2);
  });
});

describe('hashConfigSide', () => {
  let dir: string;
  beforeEach(() => {
    dir = newDir();
    fs.writeFileSync(
      upath.join(dir, 'vivliostyle.config.js'),
      'export default {}',
    );
    fs.mkdirSync(upath.join(dir, 'theme'));
    fs.writeFileSync(
      upath.join(dir, 'theme/plugin.mjs'),
      'export const a = 1;',
    );
  });

  it('changes when a script or a JSON file beside the config changes', () => {
    const before = hashConfigSide({ configDir: dir });
    expect(before).toMatch(/^[0-9a-f]{64}$/v);
    expect(hashConfigSide({ configDir: dir })).toBe(before);

    fs.writeFileSync(
      upath.join(dir, 'theme/plugin.mjs'),
      'export const a = 2;',
    );
    const afterScript = hashConfigSide({ configDir: dir });
    expect(afterScript).not.toBe(before);

    fs.writeFileSync(upath.join(dir, 'data.json'), '{}');
    expect(hashConfigSide({ configDir: dir })).not.toBe(afterScript);
  });

  it('does not look at node_modules, hidden directories, ignored directories, and other kinds of files', () => {
    const before = hashConfigSide({
      configDir: dir,
      ignoredDirs: [upath.join(dir, 'out')],
    });
    fs.mkdirSync(upath.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(upath.join(dir, 'node_modules/pkg/index.js'), 'x');
    fs.mkdirSync(upath.join(dir, '.hidden'));
    fs.writeFileSync(upath.join(dir, '.hidden/a.js'), 'x');
    fs.mkdirSync(upath.join(dir, 'out'));
    fs.writeFileSync(upath.join(dir, 'out/a.js'), 'x');
    fs.writeFileSync(upath.join(dir, 'chapter.md'), '# changed');
    fs.writeFileSync(upath.join(dir, 'image.png'), 'png');
    expect(
      hashConfigSide({ configDir: dir, ignoredDirs: [upath.join(dir, 'out')] }),
    ).toBe(before);
  });

  it('includes the lock file of the project, also from a parent directory', () => {
    const project = newDir();
    const sub = upath.join(project, 'book');
    fs.mkdirSync(sub);
    fs.writeFileSync(
      upath.join(sub, 'vivliostyle.config.js'),
      'export default {}',
    );
    const without = hashConfigSide({ configDir: sub });
    fs.writeFileSync(
      upath.join(project, 'pnpm-lock.yaml'),
      'lockfileVersion: 1',
    );
    const withLock = hashConfigSide({ configDir: sub });
    expect(withLock).not.toBe(without);
    fs.writeFileSync(
      upath.join(project, 'pnpm-lock.yaml'),
      'lockfileVersion: 2',
    );
    expect(hashConfigSide({ configDir: sub })).not.toBe(withLock);
  });

  it('gives nothing when there are too many files', () => {
    const many = newDir();
    for (let i = 0; i < 5001; i++) {
      fs.writeFileSync(upath.join(many, `f${i}.json`), '{}');
    }
    expect(hashConfigSide({ configDir: many })).toBeUndefined();
  });
});

describe('CompileCache', () => {
  const create = (
    settings: Partial<{ exclude: string[]; maxSize: number }> = {},
    environment = 'env',
  ) => {
    const dir = newDir();
    return new CompileCache({
      dir: upath.join(dir, 'cache'),
      environment,
      entryContextDir: dir,
      settings: { exclude: [], maxSize: 1024 ** 3, ...settings },
    });
  };
  const input = { source: Buffer.from('# title'), options: { a: 1 } };

  it('keeps and gives back what is set', () => {
    const cache = create();
    const key = cache.key(input);
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, '<html>1</html>');
    expect(cache.get(key)).toBe('<html>1</html>');
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
    // no temporary file is left
    expect(fs.readdirSync(cache.dir)).toEqual([`${key}.html`]);
  });

  it('makes another key when the source, the options, or the config changes', () => {
    const cache = create();
    const key = cache.key(input);
    expect(cache.key(input)).toBe(key);
    expect(cache.key({ ...input, source: Buffer.from('# other') })).not.toBe(
      key,
    );
    expect(cache.key({ ...input, options: { a: 2 } })).not.toBe(key);
    expect(create({}, 'another environment').key(input)).not.toBe(key);
  });

  it('knows the sources that are excluded', () => {
    const cache = create({ exclude: ['colophon.md', 'generated/', 'a/b.md'] });
    const path = (p: string) => upath.join(upath.dirname(cache.dir), p);
    expect(cache.isExcluded(path('colophon.md'))).toBe(true);
    expect(cache.isExcluded(path('sub/colophon.md'))).toBe(true);
    expect(cache.isExcluded(path('generated/x/y.md'))).toBe(true);
    expect(cache.isExcluded(path('a/b.md'))).toBe(true);
    expect(cache.isExcluded(path('b.md'))).toBe(false);
    expect(cache.isExcluded(path('chapter.md'))).toBe(false);
  });

  it('removes the oldest files when it is bigger than the limit', () => {
    const cache = create({ maxSize: 25 });
    const keys = ['k1', 'k2', 'k3'];
    keys.forEach((key, index) => {
      cache.set(key, 'x'.repeat(10));
      const time = new Date(Date.now() - (keys.length - index) * 10_000);
      fs.utimesSync(upath.join(cache.dir, `${key}.html`), time, time);
    });
    cache.prune();
    expect(fs.readdirSync(cache.dir).toSorted()).toEqual([
      'k2.html',
      'k3.html',
    ]);
  });

  it('keeps the files that were used lately', () => {
    const cache = create({ maxSize: 25 });
    for (const key of ['k1', 'k2', 'k3']) {
      cache.set(key, 'x'.repeat(10));
      const time = new Date(Date.now() - 100_000);
      fs.utimesSync(upath.join(cache.dir, `${key}.html`), time, time);
    }
    // k1 is the oldest, but is used now
    expect(cache.get('k1')).toBeDefined();
    cache.prune();
    expect(fs.readdirSync(cache.dir)).toContain('k1.html');
    expect(fs.readdirSync(cache.dir)).toHaveLength(2);
  });

  it('does not fail to prune a directory that does not exist', () => {
    expect(() => create().prune()).not.toThrow();
  });
});

describe('compileCacheDir', () => {
  it('is in node_modules of the project if there is one', () => {
    const dir = newDir();
    fs.mkdirSync(upath.join(dir, 'node_modules'));
    expect(compileCacheDir(dir)).toBe(
      upath.join(dir, 'node_modules/.cache/vivliostyle-cli/compile'),
    );
  });

  it('is in the cache directory of the OS otherwise, for each project', () => {
    const one = compileCacheDir(newDir());
    const another = compileCacheDir(newDir());
    expect(one).toMatch(/vivliostyle-cli\/[0-9a-f]{16}\/compile$/v);
    expect(one).not.toBe(another);
  });
});

describe('injectStyle', () => {
  it('puts the style before the end of the head', () => {
    expect(
      injectStyle(
        '<html><head><title>t</title></head><body></body></html>',
        'a{b:c}',
      ),
    ).toBe(
      '<html><head><title>t</title><style>a{b:c}</style></head><body></body></html>',
    );
  });

  it('puts the style in the head that is not closed', () => {
    expect(injectStyle('<html><head lang="ja"><body>', 'a{}')).toBe(
      '<html><head lang="ja"><style>a{}</style><body>',
    );
  });

  it('fails for a document without head', () => {
    expect(() => injectStyle('<p>text</p>', 'a{}')).toThrow('no head');
  });
});

describe('listFiles', () => {
  it('lists the files under a directory, and nothing for a directory that does not exist', () => {
    const dir = newDir();
    fs.mkdirSync(upath.join(dir, 'sub'));
    fs.writeFileSync(upath.join(dir, 'a.html'), '');
    fs.writeFileSync(upath.join(dir, 'sub/b.html'), '');
    expect(
      [...listFiles(dir)].map((p) => upath.relative(dir, p)).toSorted(),
    ).toEqual(['a.html', 'sub/b.html']);
    expect(listFiles(upath.join(dir, 'nothing')).size).toBe(0);
  });
});

describe('createCompileCache', () => {
  let cwd: string;
  beforeAll(() => {
    cwd = newDir();
    fs.writeFileSync(upath.join(cwd, 'a.md'), '# a\n');
    fs.writeFileSync(
      upath.join(cwd, 'vivliostyle.config.js'),
      'export default {}',
    );
  });

  const make = async (compileCache?: unknown, inline: object = {}) => {
    const raw = { entry: 'a.md', output: 'book.pdf', compileCache };
    const task = v.parse(VivliostyleConfigSchema, raw).tasks[0];
    const config = await getTaskConfig([], cwd, raw as never);
    return createCompileCache({
      task,
      config,
      inlineConfig: { cwd, ...inline },
    });
  };

  it('is off unless it is asked for', async () => {
    expect(await make()).toBeUndefined();
    expect(await make(false)).toBeUndefined();
  });

  it('is on with true or with settings', async () => {
    expect(await make(true)).toBeInstanceOf(CompileCache);
    const cache = await make({ exclude: ['a.md'], maxSize: '1KB' });
    expect(cache?.isExcluded(upath.join(cwd, 'a.md'))).toBe(true);
  });

  it('is not used when the config is not in a file', async () => {
    expect(await make(true, { configData: { entry: 'a.md' } })).toBeUndefined();
  });
});
