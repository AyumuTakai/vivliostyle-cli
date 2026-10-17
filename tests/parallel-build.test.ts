import fs from 'node:fs';
import os from 'node:os';

import upath from 'upath';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VivliostyleConfigSchema } from '../src/config/schema.js';
import { planParallelBuild } from '../src/core/parallel-build.js';
import {
  layoutCacheKey,
  layoutCachePath,
  writeLayoutCache,
} from '../src/core/parallel-layout.js';
import {
  applyPartSpec,
  orderPartsHeavyFirst,
  secretEnv,
  secretEnvName,
  serializeInlineConfig,
  takeSecretEnv,
} from '../src/core/parallel-part.js';
import { destinationNameOf, readTocItems } from '../src/core/parallel-toc.js';
import { getTaskConfig, rootPath } from './command-util.js';

const cliEntry = `${rootPath}/package.json`;

const parseTask = (config: object) =>
  v.parse(VivliostyleConfigSchema, config).tasks[0];

let cwd: string;
beforeAll(() => {
  cwd = fs.mkdtempSync(upath.join(os.tmpdir(), 'vivliostyle-parallel-'));
  for (const name of ['a', 'b', 'c', 'd']) {
    fs.writeFileSync(upath.join(cwd, `${name}.md`), `# ${name}\n`);
  }
});
afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

type PlanOptions = {
  inlineConfig?: object;
  jobs?: number;
  explicit?: boolean;
  hasConfigFile?: boolean;
  cliEntry?: string;
};

async function plan(config: object, options: PlanOptions = {}) {
  const { inlineConfig, ...rest } = options;
  const task = parseTask(config);
  return planParallelBuild({
    task,
    config: await getTaskConfig([], cwd, config as never),
    inlineConfig: { cwd, ...inlineConfig },
    hasConfigFile: true,
    jobs: 2,
    cliEntry,
    ...rest,
  });
}

const book = {
  entry: ['a.md', 'b.md', 'c.md', 'd.md'],
  output: 'book.pdf',
};

describe('planParallelBuild', () => {
  it('returns the indexes of the entries that start a part', async () => {
    await expect(
      plan({ ...book, parallel: { splitBefore: ['c.md', 'b.md'] } }),
    ).resolves.toEqual({ splitIndexes: [1, 2] });
  });

  it('ignores the first entry and duplicates', async () => {
    await expect(
      plan({ ...book, parallel: { splitBefore: ['a.md', 'c.md', 'c.md'] } }),
    ).resolves.toEqual({ splitIndexes: [2] });
  });

  it.each<[string, object, PlanOptions, string]>([
    [
      'the jobs are less than 2',
      { ...book, parallel: { splitBefore: ['b.md'] } },
      { jobs: 1 },
      'less than 2',
    ],
    [
      'there is no config file',
      { ...book, parallel: { splitBefore: ['b.md'] } },
      { hasConfigFile: false },
      'config file',
    ],
    [
      'the CLI is not found',
      { ...book, parallel: { splitBefore: ['b.md'] } },
      { cliEntry: `${rootPath}/not-found.js` },
      'not found',
    ],
    [
      'the output is not a PDF',
      { ...book, output: 'book.epub', parallel: { splitBefore: ['b.md'] } },
      {},
      'single PDF output',
    ],
    [
      'there are several outputs',
      {
        ...book,
        output: ['a.pdf', 'b.pdf'],
        parallel: { splitBefore: ['b.md'] },
      },
      {},
      'single PDF output',
    ],
    [
      'the render mode is docker',
      {
        ...book,
        output: { path: 'book.pdf', renderMode: 'docker' },
        parallel: { splitBefore: ['b.md'] },
      },
      {},
      'docker',
    ],
    [
      'the Vite config is given inline',
      { ...book, parallel: { splitBefore: ['b.md'] } },
      { inlineConfig: { vite: { logLevel: 'silent' } } },
      'Vite',
    ],
    [
      'the entry of splitBefore does not exist',
      { ...book, parallel: { splitBefore: ['x.md'] } },
      {},
      'x.md',
    ],
    [
      'splitBefore has only the first entry',
      { ...book, parallel: { splitBefore: ['a.md'] } },
      {},
      'no entry to split before',
    ],
  ])('gives the reason when %s', async (_name, config, options, reason) => {
    const result = await plan(config, options);
    expect(result).toHaveProperty('reason');
    expect((result as { reason: string }).reason).toContain(reason);
  });
});

describe('planParallelBuild for the default parallel build', () => {
  const auto = { ...book };

  it('asks the build to examine the book when nothing is known about it', async () => {
    expect(await plan(auto, { explicit: false })).toEqual({
      reason: 'The book has not been examined yet.',
      silent: true,
      learn: true,
    });
  });

  it('splits the book automatically from what is known about it', async () => {
    const config = await getTaskConfig([], cwd, auto as never);
    writeLayoutCache(layoutCachePath(config), {
      key: layoutCacheKey(config),
      docPages: [60, 60, 60, 60],
      named: [true, false, true, false],
    });
    expect(await plan(auto, { explicit: false, jobs: 2 })).toEqual({
      splitIndexes: [2],
    });
    // splitBefore of the config is used instead if there is
    expect(
      await plan(
        { ...auto, parallel: { splitBefore: ['b.md'] } },
        { explicit: false },
      ),
    ).toEqual({ splitIndexes: [1] });
  });

  it('does not tell why a book that was not asked to be built in parallel is not', async () => {
    const result = await plan(
      { ...book, output: 'book.epub' },
      { explicit: false },
    );
    expect(result).toMatchObject({ silent: true });
    const asked = await plan({ ...book, output: 'book.epub' });
    expect(asked).toMatchObject({ silent: false });
  });
});

describe('applyPartSpec', () => {
  const task = parseTask({
    entry: ['a.md', { path: 'b.md', theme: 'own.css' }, 'c.md', 'd.md'],
    theme: 'base.css',
    toc: true,
    cover: 'cover.png',
    output: 'book.pdf',
    parallel: { jobs: 2, splitBefore: ['c.md'] },
  });
  const spec = {
    inlineConfig: {},
    output: { path: '/tmp/part.pdf', format: 'pdf' as const },
    workspaceDir: '/tmp/part',
  };
  const specifiers = (themes: { specifier: string }[] | undefined) =>
    themes?.map((theme) => theme.specifier);

  it('keeps the entries of a range, with the extra theme', () => {
    const result = applyPartSpec(task, {
      ...spec,
      entries: { range: [1, 3], extraThemes: [['x.css'], []] },
      withoutTocAndCover: true,
    });
    expect(result.entry.map((entry) => entry.path)).toEqual(['b.md', 'c.md']);
    // the entry's own theme replaces the theme of the task; the extra theme is added
    expect(specifiers(result.entry[0].theme)).toEqual(['own.css', 'x.css']);
    // an entry without extra theme is left as it is
    expect(result.entry[1]).toEqual(task.entry[2]);
    expect(result.toc).toBeUndefined();
    expect(result.cover).toBeUndefined();
    expect(result.parallel).toBeUndefined();
    expect(result.output).toEqual([{ path: '/tmp/part.pdf', format: 'pdf' }]);
    expect(result.workspaceDir).toBe('/tmp/part');
  });

  it('adds the extra theme to the theme of the task for an entry without own theme', () => {
    const result = applyPartSpec(task, {
      ...spec,
      entries: { range: [0, 1], extraThemes: [['x.css']] },
    });
    expect(specifiers(result.entry[0].theme)).toEqual(['base.css', 'x.css']);
    // toc and cover are left
    expect(result.toc).toBeDefined();
    expect(result.cover).toBeDefined();
  });

  it('puts the leading files before the entries', () => {
    const result = applyPartSpec(task, {
      ...spec,
      entries: { range: [2, 4] },
      leadingFiles: [{ path: 'spare.html' }],
    });
    expect(result.entry.map((entry) => entry.path)).toEqual([
      'spare.html',
      'c.md',
      'd.md',
    ]);
  });

  it('replaces the entries with files', () => {
    const result = applyPartSpec(task, {
      ...spec,
      entries: { files: [{ path: 'toc.html', theme: ['t.css'] }] },
    });
    expect(result.entry.map((entry) => entry.path)).toEqual(['toc.html']);
    expect(specifiers(result.entry[0].theme)).toEqual(['t.css']);
  });

  it('keeps all the entries', () => {
    const result = applyPartSpec(task, { ...spec, entries: { keep: true } });
    expect(result.entry).toEqual(task.entry);
  });
});

describe('serializeInlineConfig', () => {
  it('keeps what can be written as JSON', () => {
    const logger = { info() {} };
    expect(
      serializeInlineConfig({
        cwd: '/work',
        config: 'vivliostyle.config.js',
        logLevel: 'silent',
        sandbox: true,
        output: [{ path: 'a.pdf' }],
        jobs: 4,
        partSpec: 'spec.json',
        configData: { entry: 'a.md' },
        signal: new AbortController().signal,
        logger,
        unknown: undefined,
        callback: () => {},
        circular: (() => {
          const o: Record<string, unknown> = {};
          o.self = o;
          return o;
        })(),
      }),
    ).toEqual({
      cwd: '/work',
      config: 'vivliostyle.config.js',
      logLevel: 'silent',
      sandbox: true,
    });
  });
});

describe('secrets of the inline config', () => {
  it('are left out of the serialized config', () => {
    expect(
      serializeInlineConfig({
        cwd: '/work',
        proxyServer: 'http://proxy:8080',
        proxyUser: 'user',
        proxyPass: 'secret',
      }),
    ).toEqual({ cwd: '/work', proxyServer: 'http://proxy:8080' });
  });

  it('are handed over by the environment and taken back', () => {
    const env = secretEnv({ proxyUser: 'user', proxyPass: 'secret' });
    expect(env).toEqual({
      VS_CLI_PARALLEL_PROXY_USER: 'user',
      VS_CLI_PARALLEL_PROXY_PASS: 'secret',
    });
    expect(secretEnvName('proxyPass')).toBe('VS_CLI_PARALLEL_PROXY_PASS');
    const childEnv: NodeJS.ProcessEnv = { PATH: '/bin', ...env };
    expect(takeSecretEnv(childEnv)).toEqual({
      proxyUser: 'user',
      proxyPass: 'secret',
    });
    // the secrets do not stay in the environment of the child process
    expect(childEnv).toEqual({ PATH: '/bin' });
  });

  it('gives nothing when there is no secret', () => {
    expect(secretEnv({})).toEqual({});
    expect(takeSecretEnv({ PATH: '/bin' })).toEqual({});
  });
});

describe('orderPartsHeavyFirst', () => {
  // parts: [0,2) [2,3) [3,6)
  const bounds = [0, 2, 3, 6];

  it('puts the parts with more pages first', () => {
    expect(
      orderPartsHeavyFirst([0, 1, 2], bounds, [3, 4, 20, 1, 1, 1]),
    ).toEqual([1, 0, 2]);
  });

  it('uses the order of the config when the pages are not known', () => {
    expect(orderPartsHeavyFirst([0, 1, 2], bounds, [])).toEqual([0, 1, 2]);
    expect(
      orderPartsHeavyFirst([2, 0], bounds, [undefined, undefined, 5]),
    ).toEqual([0, 2]);
  });

  it('orders only the given parts', () => {
    expect(orderPartsHeavyFirst([2, 1], bounds, [9, 9, 1, 2, 2, 2])).toEqual([
      2, 1,
    ]);
  });
});

describe('readTocItems', () => {
  const html = `<html><body><h1>Book</h1><nav id="toc" role="doc-toc"><h2>Contents</h2>
    <ol>
      <li><a href="a.html">First</a>
        <ol>
          <li><a href="a.html#section%201">Section 1</a></li>
          <li><a href="a.html#%E3%81%82">Japanese</a></li>
        </ol>
      </li>
      <li><a href="dir/b.html">Second</a></li>
    </ol></nav></body></html>`;

  it('reads the items and makes the names of the destinations', () => {
    const items = readTocItems(
      html,
      'http://localhost:0/vivliostyle/index.html',
    );
    expect(items).toEqual([
      {
        id: destinationNameOf('/vivliostyle/a.html', ''),
        title: 'First',
        children: [
          {
            id: destinationNameOf('/vivliostyle/a.html', '#section 1'),
            title: 'Section 1',
            children: [],
          },
          {
            id: destinationNameOf('/vivliostyle/a.html', '#あ'),
            title: 'Japanese',
            children: [],
          },
        ],
      },
      {
        id: destinationNameOf('/vivliostyle/dir/b.html', ''),
        title: 'Second',
        children: [],
      },
    ]);
  });

  it('returns nothing without a list', () => {
    expect(readTocItems('<nav></nav>', 'http://localhost:0/x.html')).toEqual(
      [],
    );
    expect(readTocItems('<p>none</p>', 'http://localhost:0/x.html')).toEqual(
      [],
    );
  });
});

describe('destinationNameOf', () => {
  it('makes the name that Chromium gives with a fixed port', () => {
    expect(destinationNameOf('/vivliostyle/ch01.html', '#id')).toBe(
      'viv-id-http:003a:002f:002flocalhost:003a0:002fvivliostyle:002fch01:002ehtml:0023id',
    );
    expect(destinationNameOf('/vivliostyle/ch01.html', '')).toBe(
      'viv-id-http:003a:002f:002flocalhost:003a0:002fvivliostyle:002fch01:002ehtml',
    );
  });
});
