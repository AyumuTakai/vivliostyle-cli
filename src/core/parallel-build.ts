// Builds a book in parts, in parallel processes, and merges the PDFs (experimental).
//
// - The entries of the book are split at the entries of `parallel.splitBefore`. A child process of this
//   CLI builds each part (see parallel-spec.ts), and a PDF is written without post-processing.
// - A part is typeset with the page numbers it has in the whole book. The number of the pages of the preceding
//   parts is taken from the previous build; if it turns out to be different, the parts are built again.
//   Documents of spare pages are put before the part to give the number to the first page of the part
//   (and are removed afterwards), because a named page cannot reset the page counter.
// - The cover and the table of contents are built after the parts: the TOC is generated from the compiled
//   documents, and the page numbers of the links are written as text, since the parts do not know each other.
// - The PDFs are merged, and the outline, the metadata, etc. are written to the merged PDF by the post-processing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import upath from 'upath';

import { launchSharedBrowser } from '../browser.js';
import {
  type ParsedEntry,
  type ParsedTheme,
  type ResolvedTaskConfig,
  isWebPubConfig,
} from '../config/resolve.js';
import type {
  ParsedBuildTask,
  ParsedVivliostyleInlineConfig,
} from '../config/schema.js';
import type { CmykMap, TOCItem } from '../global-viewer.js';
import { Logger } from '../logger.js';
import type { PageSizeData } from '../output/pdf-document.js';
import {
  mergePdfs,
  normalizeDestinationName,
  type PdfDestination,
} from '../output/pdf-merge.js';
import { postProcessPDF } from '../output/pdf-postprocess.js';
import type { PartResult } from '../output/pdf.js';
import { cliRoot } from '../util.js';
import {
  chooseSplitIndexes,
  recordSplitResult,
  layoutCacheKey,
  layoutCachePath,
  readLayoutCache,
  writeLayoutCache,
} from './parallel-layout.js';
import {
  orderPartsHeavyFirst,
  secretEnv,
  serializeInlineConfig,
} from './parallel-part.js';
import type { PartSpec } from './parallel-spec.js';
import { destinationNameOf, readTocItems } from './parallel-toc.js';
import {
  firstDifferentPage,
  fingerprintPdf,
  readReference,
  sourcesHash,
  UnsafeSplitError,
  writeReference,
} from './parallel-verify.js';

const MAX_ROUNDS = 3;
const cliEntryPath = upath.join(cliRoot, 'dist/cli.js');
const TEMPORARY_FILE_PREFIX = 'vivliostyle-parallel-';

export interface ParallelBuildOptions {
  task: ParsedBuildTask;
  config: ResolvedTaskConfig;
  inlineConfig: ParsedVivliostyleInlineConfig;
  /** The config is read from a file, so that child processes can read it as well. */
  hasConfigFile: boolean;
  jobs: number;
  /** The user asked for the parallel build (it is not the default). */
  explicit?: boolean;
  /** Split before entries that are not known to be safe, and check the result (default: yes). */
  allowUnknown?: boolean;
  /** The CLI that child processes run (default: the one of this package). */
  cliEntry?: string;
}

export type ParallelPlan =
  | {
      splitIndexes: number[];
      /** The entries to split before whose safety is not known: the result has to be checked. */
      unverified?: number[];
      /** What the book contains now (see `sourcesHash`), if it has to be known later. */
      hash?: string;
    }
  | {
      reason: string;
      /** Not worth telling the user (the user did not ask for the parallel build). */
      silent?: boolean;
      /** The book should be examined by the build that is not parallel, for the next build. */
      learn?: boolean;
    };

/**
 * Checks if the task can be built in parts. Returns the indexes of the entries that start a part,
 * or the reason why it cannot be built in parts.
 * When the user did not choose the entries to split before (`parallel.splitBefore`), they are chosen
 * from what the previous build found out about the book.
 */
export function planParallelBuild({
  task,
  config,
  inlineConfig,
  hasConfigFile,
  jobs,
  explicit = true,
  allowUnknown = true,
  cliEntry = cliEntryPath,
}: ParallelBuildOptions): ParallelPlan {
  // The user is told why the book is not built in parallel only if they asked for it
  const no = (reason: string): ParallelPlan => ({ reason, silent: !explicit });
  if (jobs < 2) {
    return no('The number of jobs is less than 2.');
  }
  if (!fs.existsSync(cliEntry)) {
    return no(`The CLI entry is not found: ${cliEntry}`);
  }
  if (!hasConfigFile || inlineConfig.configData) {
    return no('It needs a config file.');
  }
  if (inlineConfig.vite) {
    return no('It does not support the inline Vite config.');
  }
  if (!isWebPubConfig(config)) {
    return no('The input is not a list of manuscripts.');
  }
  if (config.outputs.length !== 1 || config.outputs[0].format !== 'pdf') {
    return no('It supports a single PDF output only.');
  }
  if (config.outputs[0].renderMode === 'docker') {
    return no('It does not support the render mode "docker".');
  }
  if (task.entry.some((entry) => 'rel' in entry && entry.rel)) {
    return no('It does not support entries that have `rel`.');
  }
  const splitBefore = (task.parallel === false ? undefined : task.parallel)
    ?.splitBefore;
  if (!splitBefore) {
    // Choose the entries from what the previous build found out about the book
    const cache = readLayoutCache(
      layoutCachePath(config),
      layoutCacheKey(config),
    );
    if (!cache?.docPages || !cache.named) {
      return {
        reason: 'The book has not been examined yet.',
        silent: true,
        learn: true,
      };
    }
    // The entries that are not known to be safe can be used only if there is a PDF to check the result with
    const hash = sourcesHash(config);
    const reference = readReference(
      layoutCachePath(config),
      layoutCacheKey(config),
    );
    const choice = {
      docPages: cache.docPages,
      named: cache.named,
      verified: cache.verified,
      unsafe: cache.unsafe?.hash === hash ? cache.unsafe.entries : [],
      jobs,
    };
    const chosen = chooseSplitIndexes({
      ...choice,
      allowUnknown: allowUnknown && reference?.hash === hash,
    });
    if (!chosen) {
      return {
        reason: 'The book is small, or has no entry to split before.',
        silent: true,
      };
    }
    // Keep the PDF of this build as the reference for the next build if it could have made use of it
    const wantsReference =
      allowUnknown &&
      reference?.hash !== hash &&
      (chooseSplitIndexes({ ...choice, allowUnknown: true })?.unverified
        .length ?? 0) > 0;
    return {
      splitIndexes: chosen.splitIndexes,
      ...(chosen.unverified.length > 0
        ? { unverified: chosen.unverified }
        : {}),
      ...(chosen.unverified.length > 0 || wantsReference ? { hash } : {}),
    };
  }
  const splitIndexes: number[] = [];
  for (const path of splitBefore) {
    const index = task.entry.findIndex((entry) => entry.path === path);
    if (index < 0) {
      return no(`The entry of "parallel.splitBefore" is not found: ${path}`);
    }
    splitIndexes.push(index);
  }
  const sorted = [...new Set(splitIndexes)]
    .filter((index) => index > 0)
    .toSorted((a, b) => a - b);
  if (sorted.length === 0) {
    return no('"parallel.splitBefore" has no entry to split before.');
  }
  // The entries that the user chose are trusted
  return { splitIndexes: sorted };
}

function runChild({
  spec,
  specPath,
  config,
  cwd,
  env,
  signal,
}: {
  spec: PartSpec;
  specPath: string;
  config: string | undefined;
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}): Promise<void> {
  // The spec has the endpoint of the shared browser, which must not be known to other users of the machine
  fs.writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  const args = [
    cliEntryPath,
    'build',
    ...(config ? ['--config', config] : []),
    '--part-spec',
    specPath,
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env, NO_COLOR: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      output += data;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      Logger.debug(
        `parallel > ${upath.basename(specPath, '.json')} took ${Date.now() - started} ms`,
      );
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `The build of ${upath.basename(specPath, '.json')} failed:\n${output.slice(-1500)}`,
          ),
        );
      }
    });
  });
}

async function pool(
  tasks: (() => Promise<void>)[],
  concurrency: number,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (next < tasks.length) {
        await tasks[next++]();
      }
    }),
  );
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller gives the type of the file
function readJson<T>(path: string): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the files are written by this module and its child processes
  return JSON.parse(fs.readFileSync(path, 'utf8')) as T;
}

const themeSpecifier = (theme: ParsedTheme) =>
  theme.type === 'uri'
    ? theme.location
    : theme.type === 'file'
      ? theme.source
      : theme.specifier;

const normalizeTocItems = (items: TOCItem[]): TOCItem[] =>
  items.map((item) => ({
    ...item,
    id: normalizeDestinationName(item.id),
    children: normalizeTocItems(item.children),
  }));

/**
 * Builds the task in parts. Returns the path of the output PDF.
 */
export async function buildInParallel(
  options: ParallelBuildOptions & {
    splitIndexes: number[];
    unverified?: number[];
    hash?: string;
  },
): Promise<string> {
  const { task, config, inlineConfig, jobs, splitIndexes, unverified, hash } =
    options;
  // Aborted when the build fails, to stop the child processes that are running
  const failure = new AbortController();
  const signal = inlineConfig.signal
    ? AbortSignal.any([inlineConfig.signal, failure.signal])
    : failure.signal;
  const target = config.outputs[0];
  if (target.format !== 'pdf') {
    throw new Error('A PDF output is expected.');
  }
  const entryCount = task.entry.length;
  const bounds = [0, ...splitIndexes, entryCount];
  Logger.debug(
    `parallel > split before the entries ${JSON.stringify(splitIndexes)} (not known to be safe: ${JSON.stringify(unverified ?? [])})`,
  );
  const partCount = bounds.length - 1;
  const cwd = inlineConfig.cwd ?? process.cwd();

  // Files of a build are put in a directory of its own, so that builds can run at the same time
  const rootDir = upath.join(config.workspaceDir, '.parallel');
  const runId = `${process.pid}-${Date.now()}`;
  const workDir = upath.join(rootDir, runId);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const temporaryFiles: string[] = [];
  const temporaryFile = (name: string, content: string): string => {
    const file = upath.join(
      config.entryContextDir,
      `${TEMPORARY_FILE_PREFIX}${runId}-${name}`,
    );
    fs.writeFileSync(file, content);
    temporaryFiles.push(file);
    return upath.basename(file);
  };

  const hasFront = Boolean(task.toc) || Boolean(task.cover);
  const cachePath = layoutCachePath(config);
  const cacheKey = layoutCacheKey(config);
  const cache = readLayoutCache(cachePath, cacheKey);
  // The numbers of the pages that are known (or guessed from the previous build)
  let frontPages: number | undefined = hasFront ? cache?.frontPages : 0;
  const docPages: (number | undefined)[] = Array.from(
    { length: entryCount },
    (_, i) => cache?.docPages?.[i],
  );

  const baseSpec = {
    inlineConfig: serializeInlineConfig(inlineConfig),
  } satisfies Partial<PartSpec>;
  const run = (name: string, spec: Omit<PartSpec, 'inlineConfig'>) =>
    runChild({
      spec: { ...baseSpec, ...spec },
      specPath: upath.join(workDir, `${name}.json`),
      config: inlineConfig.config,
      cwd,
      env: secretEnv(inlineConfig),
      signal,
    });

  /** Page number of the first page of the entry in the whole book (as it is known now) */
  const startNumber = (entryIndex: number): number => {
    let number = (frontPages ?? 0) + 1;
    for (let i = 0; i < entryIndex; i++) {
      number += docPages[i] ?? 0;
    }
    return number;
  };

  const t0 = Date.now();
  let sharedBrowser:
    | Awaited<ReturnType<typeof launchSharedBrowser>>
    | undefined;
  try {
    sharedBrowser = await launchSharedBrowser(config);
    const browserWsEndpoint = sharedBrowser.wsEndpoint;

    // ---- compile the whole book to get the cover and the TOC ----------------------------------------------
    const compileDir = upath.join(workDir, 'compile');
    const partDirs = Array.from({ length: partCount }, (_, i) =>
      upath.join(workDir, `part-${i}`),
    );
    const marks = partDirs.map((dir) => `${dir}.compiled`);
    for (const mark of marks) {
      fs.rmSync(mark, { force: true });
    }
    let compiled: Promise<void> | undefined;
    const compile = () => (compiled ??= compileOnce());
    const compileOnce = async () => {
      if (!hasFront) {
        return;
      }
      // The TOC is generated from the documents that the parts compile, so wait for them
      while (!marks.every((mark) => fs.existsSync(mark))) {
        signal?.throwIfAborted();
        await sleep(100);
      }
      await run('compile', {
        entries: { keep: true },
        output: { path: upath.join(workDir, 'compile.out'), format: 'webpub' },
        workspaceDir: compileDir,
        precompiledDirs: partDirs,
        browserWsEndpoint,
      });
    };

    // ---- the parts ------------------------------------------------------------------------------------------
    const results: (PartResult | undefined)[] = Array.from({
      length: partCount,
    });
    const skipped: number[] = Array.from({ length: partCount }, () => 0);
    /** The page number given to the first page of each entry */
    const usedNumber: (number | undefined)[] = Array.from({
      length: entryCount,
    });
    const buildPart = async (index: number) => {
      const [from, to] = [bounds[index], bounds[index + 1]];
      // A page number is counted from the first page of the part, and is reset by each document. So each
      // document is given the page number it has in the whole book.
      const extraThemes: string[][] = [];
      for (let i = from; i < to; i++) {
        const number = startNumber(i);
        usedNumber[i] = number;
        extraThemes.push([
          temporaryFile(
            `offset-${i}.css`,
            `@page :nth(1) { counter-reset: page ${number - 1}; }\n`,
          ),
        ]);
      }
      // A spare page makes the first page of the part be on the same side (left/right) as in the book
      const leadingFiles: PartSpec['leadingFiles'] = [];
      if (startNumber(from) % 2 === 0) {
        leadingFiles.push({
          path: temporaryFile(
            `spare-${index}.html`,
            '<!doctype html><html><head><meta charset="utf-8"><title>spare</title></head><body><p>.</p></body></html>',
          ),
        });
      }
      const pdf = upath.join(workDir, `part-${index}.pdf`);
      const resultPath = upath.join(workDir, `part-${index}.result.json`);
      await run(`part-${index}`, {
        entries: { range: [from, to], extraThemes },
        leadingFiles,
        withoutTocAndCover: true,
        output: { path: pdf, format: 'pdf' },
        workspaceDir: partDirs[index],
        resultPath,
        compiledMark: marks[index],
        browserWsEndpoint,
      });
      const result = readJson<PartResult>(resultPath);
      pageCountOf(result, `the part ${index}`);
      results[index] = result;
      const spare = leadingFiles.length;
      const spineIndexes = result.pageInfo?.spineIndexes ?? [];
      skipped[index] = spare ? spineIndexes.filter((i) => i === 0).length : 0;
      for (let i = from; i < to; i++) {
        docPages[i] = spineIndexes.filter(
          (spine) => spine === i - from + spare,
        ).length;
      }
    };

    // The cover and the TOC with dummy numbers are built to know the number of their pages
    const dummyFront = async () => {
      if (!hasFront || frontPages !== undefined) {
        return;
      }
      await compile();
      await buildFront();
      frontPages = pageCountOf(
        readJson<PartResult>(upath.join(workDir, 'front-dummy.result.json')),
        'the cover and the TOC',
      );
    };

    // ---- the cover and the TOC --------------------------------------------------------------------------------
    const compiledTarget = (entry: ParsedEntry) =>
      upath.join(compileDir, upath.relative(config.workspaceDir, entry.target));
    const frontEntries = (pageOf?: (href: string) => string) => {
      const files: { path: string; theme: string[] }[] = [];
      const cover = config.entries.find((e) => e.rel === 'cover');
      if (cover) {
        files.push({
          path: temporaryFile(
            'front-cover.html',
            stripLinks(fs.readFileSync(compiledTarget(cover), 'utf8')),
          ),
          theme: cover.themes.map(themeSpecifier),
        });
      }
      const contents = config.entries.find((e) => e.rel === 'contents');
      if (contents) {
        const html = fs
          .readFileSync(compiledTarget(contents), 'utf8')
          .replaceAll(
            /<a href="([^"]*)"/gv,
            (_match, href: string) =>
              `<a href="${href}" data-page="${pageOf ? pageOf(href) : '00'}"`,
          )
          .replace(
            '</head>',
            '<style>nav li a::after { content: attr(data-page) !important; }</style></head>',
          );
        files.push({
          path: temporaryFile('front-toc.html', stripLinks(html)),
          theme: contents.themes.map(themeSpecifier),
        });
      }
      return files;
    };
    const buildFront = async (
      pageOf?: (href: string) => string,
    ): Promise<string> => {
      const name = pageOf ? 'front' : 'front-dummy';
      const pdf = upath.join(workDir, `${name}.pdf`);
      await run(name, {
        entries: { files: frontEntries(pageOf) },
        withoutTocAndCover: true,
        output: { path: pdf, format: 'pdf' },
        workspaceDir: upath.join(workDir, name),
        resultPath: upath.join(workDir, `${name}.result.json`),
        browserWsEndpoint,
      });
      return pdf;
    };

    // ---- build until the page numbers of the parts agree with the pages of the preceding parts ---------------
    const mismatchedParts = () =>
      Array.from({ length: partCount }, (_, i) => i).filter((index) =>
        Array.from(
          { length: bounds[index + 1] - bounds[index] },
          (_, j) => bounds[index] + j,
        ).some((i) => usedNumber[i] !== startNumber(i)),
      );
    const heavyFirst = (parts: number[]) =>
      orderPartsHeavyFirst(parts, bounds, docPages);
    const settle = async () => {
      let pending = heavyFirst(mismatchedParts());
      for (let round = 1; pending.length > 0; round++) {
        if (round > MAX_ROUNDS) {
          throw new Error(
            'The page numbers of the parts did not settle. Try choosing other entries for "parallel.splitBefore".',
          );
        }
        Logger.logInfo(
          pending.length === partCount && results.every((r) => !r)
            ? `Building ${partCount} parts in parallel`
            : `Building ${pending.length} parts again with the right page numbers`,
        );
        await Promise.all([
          pool(
            pending.map((index) => () => buildPart(index)),
            jobs,
          ),
          // the cover and the TOC with dummy numbers, to know the number of their pages
          results.every((r) => !r) ? compile().then(dummyFront) : undefined,
        ]);
        pending = heavyFirst(mismatchedParts());
      }
    };
    // If the previous build left the page numbers of the links of the TOC, the cover and the TOC are built while
    // the parts are built, and they are used if the numbers turn out to be the same
    let speculativeFront: Promise<Record<string, string> | null> | undefined;
    if (hasFront && cache?.tocNumbers && cache.frontPages !== undefined) {
      const numbers = cache.tocNumbers;
      speculativeFront = compile()
        .then(() => buildFront((href) => numbers[href] ?? ''))
        .then(() => numbers)
        // If it failed, the cover and the TOC are built again (and the error is reported then)
        .catch(() => null);
    }
    await settle();
    Logger.debug(`parallel > parts built in ${Date.now() - t0} ms`);

    // ---- the front, with the real numbers ---------------------------------------------------------------------
    // Where the places that links refer to are in the body (the pages after the cover and the TOC).
    // The viewer puts an element named like the PDF destination on every element that has an id.
    const documentStart: number[] = [];
    const positions = new Map<string, { page: number; x: number; y: number }>();
    const updatePositions = () => {
      documentStart.length = 0;
      positions.clear();
      let documentOffset = 0;
      for (let i = 0; i < entryCount; i++) {
        documentStart[i] = documentOffset;
        documentOffset += docPages[i] ?? 0;
      }
      results.forEach((result, k) => {
        const spare = skipped[k] > 0 ? 1 : 0;
        const spineIndexes = result?.pageInfo?.spineIndexes ?? [];
        for (const [spine, ids] of Object.entries(
          result?.pageInfo?.ids ?? {},
        )) {
          const global = bounds[k] + Number(spine) - spare;
          const first = spineIndexes.indexOf(Number(spine));
          for (const [id, [ix, x, y]] of Object.entries(ids)) {
            if (id.startsWith('viv-id-')) {
              positions.set(normalizeDestinationName(id), {
                page: documentStart[global] + ix - first,
                x,
                y,
              });
            }
          }
        }
      });
    };
    updatePositions();
    const basePath = `${config.base.replace(/\/$/v, '')}/`;
    /** Position of a place of the book, or of the document when the place has no element */
    const locate = (name: string) =>
      positions.get(name) ?? positions.get(name.replace(/:0023.*$/v, ''));

    let frontPdf: string | undefined;
    let frontResult: PartResult | undefined;
    let tocNumbers: Record<string, string> | undefined;
    if (hasFront) {
      await compile();
      const contentsEntry = config.entries.find((e) => e.rel === 'contents');
      const tocUrl = `http://localhost:0${basePath}${
        contentsEntry
          ? upath.relative(config.workspaceDir, contentsEntry.target)
          : ''
      }`;
      const pageOf = (href: string): string => {
        const url = new URL(href, tocUrl);
        const position = locate(destinationNameOf(url.pathname, url.hash));
        if (!position) {
          Logger.logWarn(`Could not find the page of the TOC link: ${href}`);
          return '';
        }
        return String((frontPages ?? 0) + position.page + 1);
      };
      const hrefs = contentsEntry
        ? tocHrefsOf(fs.readFileSync(compiledTarget(contentsEntry), 'utf8'))
        : [];
      let frontReady = false;
      const speculativeNumbers = await speculativeFront;
      if (
        speculativeNumbers &&
        hrefs.every((href) => pageOf(href) === speculativeNumbers[href])
      ) {
        const result = readJson<PartResult>(
          upath.join(workDir, 'front.result.json'),
        );
        if (pageCountOf(result, 'the cover and the TOC') === frontPages) {
          frontPdf = upath.join(workDir, 'front.pdf');
          frontResult = result;
          frontReady = true;
          Logger.debug(
            'parallel > the cover and the TOC built in advance are used',
          );
        }
      }
      for (let attempt = 1; !frontReady; attempt++) {
        frontPdf = await buildFront(pageOf);
        frontResult = readJson<PartResult>(
          upath.join(workDir, 'front.result.json'),
        );
        const actual = pageCountOf(frontResult, 'the cover and the TOC');
        frontReady = actual === frontPages;
        if (!frontReady && attempt >= MAX_ROUNDS) {
          throw new Error(
            'The number of the pages of the cover and the TOC did not settle.',
          );
        }
        if (!frontReady) {
          // The number of the pages changed from the previous build: the parts need the right numbers
          frontPages = actual;
          await settle();
          updatePositions();
        }
      }
      tocNumbers = Object.fromEntries(
        hrefs.map((href) => [href, pageOf(href)]),
      );
    }

    // ---- merge and post-process -------------------------------------------------------------------------------
    Logger.logUpdate('Merging PDFs');
    const partResults = results.map((result, index) => {
      if (!result) {
        throw new Error(`The part ${index} has not been built.`);
      }
      return result;
    });
    const sections: { result: PartResult; skip: number }[] = [
      ...(frontResult ? [{ result: frontResult, skip: 0 }] : []),
      ...partResults.map((result, k) => ({ result, skip: skipped[k] })),
    ];
    const pageSizeData: PageSizeData[] = sections.flatMap(({ result, skip }) =>
      result.pageSizeData.slice(skip),
    );
    const cmykMap: CmykMap = {};
    for (const { result } of sections) {
      Object.assign(cmykMap, result.cmykMap);
    }
    // The TOC of the book is the one of the TOC document; without it, the ones of the parts are put together
    const contentsEntry = config.entries.find((e) => e.rel === 'contents');
    const tocItems =
      frontResult && frontResult.toc.length > 0
        ? normalizeTocItems(frontResult.toc)
        : contentsEntry
          ? readTocItems(
              fs.readFileSync(compiledTarget(contentsEntry), 'utf8'),
              `http://localhost:0${basePath}${upath.relative(config.workspaceDir, contentsEntry.target)}`,
            )
          : normalizeTocItems(partResults.flatMap((result) => result.toc));
    const first = sections[0].result;

    const outlineIds: string[] = [];
    const collectIds = (items: TOCItem[]) => {
      for (const item of items) {
        outlineIds.push(item.id);
        collectIds(item.children);
      }
    };
    collectIds(tocItems);
    // Chromium defines the destinations of the links in the same PDF only. Define the ones that refer to other parts.
    const resolveDestination = (name: string): PdfDestination | undefined => {
      const position = locate(name);
      const pageIndex = position && (frontPages ?? 0) + position.page;
      const pageHeight =
        pageIndex === undefined
          ? undefined
          : pageSizeData[pageIndex]?.mediaHeight;
      if (!position || pageIndex === undefined || !pageHeight) {
        return undefined;
      }
      return { pageIndex, x: position.x, y: pageHeight - position.y };
    };
    // The links of the TOC refer to documents that are not in the PDF of the cover and the TOC
    const localHosts = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      config.server.host,
    ]);
    const uriToDestination = (uri: string): string | undefined => {
      let url: URL;
      try {
        url = new URL(uri);
      } catch {
        return undefined;
      }
      return localHosts.has(url.hostname) && url.pathname.startsWith(basePath)
        ? destinationNameOf(url.pathname, url.hash)
        : undefined;
    };
    const merged = await mergePdfs(
      [
        ...(frontPdf && frontResult
          ? [
              {
                pdf: fs.readFileSync(frontPdf),
                pageCount: pageCountOf(frontResult, 'the cover and the TOC'),
              },
            ]
          : []),
        ...partResults.map((result, k) => ({
          pdf: fs.readFileSync(upath.join(workDir, `part-${k}.pdf`)),
          skipPages: skipped[k],
          pageCount: pageCountOf(result, `the part ${k}`),
        })),
      ],
      {
        signal,
        requiredDestinations: outlineIds,
        resolveDestination,
        uriToDestination,
      },
    );

    // Entries that are not known to be safe to split before: the book has to be the same as the book built as a
    // whole. Otherwise, this PDF is kept as the reference for the next build, which can use it to check.
    if (hash && unverified && unverified.length > 0) {
      Logger.logUpdate('Checking the PDF');
      const reference = readReference(cachePath, cacheKey);
      if (!reference) {
        throw new Error('The PDF to check the book with is missing.');
      }
      const different = firstDifferentPage(
        reference.pages,
        await fingerprintPdf(merged),
      );
      if (different !== undefined) {
        throw new UnsafeSplitError(unverified, different);
      }
    } else if (hash) {
      writeReference(cachePath, {
        key: cacheKey,
        hash,
        pages: await fingerprintPdf(merged),
      });
    }

    fs.mkdirSync(upath.dirname(target.path), { recursive: true });
    Logger.logUpdate('Processing PDF');
    await postProcessPDF({
      pdf: merged,
      output: target.path,
      metadata: first.metadata,
      metadataOptions: {
        pageProgression: first.pageProgression,
        browserVersion: first.browserVersion,
        viewerCoreVersion: first.viewerCoreVersion,
        disableCreatorOption: !!config.viewer && !first.viewerCoreVersion,
      },
      tocItems,
      pageSizeData,
      preflight: target.preflight,
      preflightOption: target.preflightOption,
      image: config.image,
      cmyk: target.cmyk,
      cmykMap,
      replaceImage: target.replaceImage,
      outputIntent: target.outputIntent,
      signal,
    });

    writeLayoutCache(cachePath, {
      key: cacheKey,
      frontPages: frontPages ?? 0,
      docPages: docPages.map((n) => n ?? 0),
      ...(tocNumbers ? { tocNumbers } : {}),
    });
    if (unverified && unverified.length > 0) {
      recordSplitResult(cachePath, cacheKey, { verified: unverified });
    }
    return target.path;
  } catch (error) {
    // Stop the child processes that are still running
    failure.abort(error);
    throw error;
  } finally {
    await sharedBrowser?.closeBrowser();
    fs.rmSync(workDir, { recursive: true, force: true });
    for (const file of temporaryFiles) {
      fs.rmSync(file, { force: true });
    }
  }
}

/**
 * Builds the book in parallel if it can be. If the book built in parts turns out to be different from the book
 * built as a whole, the entries to split before are not used again.
 * Otherwise, returns why the book is not built in parallel.
 */
export async function tryParallelBuild(
  options: ParallelBuildOptions,
): Promise<
  { output: string } | Exclude<ParallelPlan, { splitIndexes: number[] }>
> {
  const { config } = options;
  let current = options;
  let plan = planParallelBuild(current);
  while ('splitIndexes' in plan) {
    try {
      return { output: await buildInParallel({ ...current, ...plan }) };
    } catch (error) {
      if (!(error instanceof UnsafeSplitError)) {
        throw error;
      }
      Logger.logInfo(
        'The book is not split before some entries, because the layout there depends on the preceding pages.',
      );
      recordSplitResult(layoutCachePath(config), layoutCacheKey(config), {
        unsafe: error.entries,
        hash: sourcesHash(config),
      });
      // Do not try other entries: split only before the entries that are known to be safe
      current = { ...options, allowUnknown: false };
      plan = planParallelBuild(current);
    }
  }
  return plan;
}

/** The targets of the links of the TOC document. */
export function tocHrefsOf(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/<a href="([^"]*)"/gv)].map((match) => match[1]),
    ),
  ];
}

/** Removes the links, which refer to files of the workspace that the build of the cover and the TOC does not have. */
function stripLinks(html: string): string {
  return html.replaceAll(/<link[^>]*>/gv, '');
}

/** The number of the pages that a child process reported. */
function pageCountOf(result: PartResult, name: string): number {
  const spineIndexes = result.pageInfo?.spineIndexes ?? [];
  if (
    spineIndexes.length === 0 ||
    !spineIndexes.every((index) => Number.isInteger(index))
  ) {
    throw new Error(
      `The viewer did not tell the pages of ${name}. The viewer needs to set data-vivliostyle-spine-index on the page containers.`,
    );
  }
  return spineIndexes.length;
}
