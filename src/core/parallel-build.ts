// Builds a book in parts, in parallel processes, and merges the PDFs (experimental).
//
// - The entries of the book are split into parts (see `planParallelBuild`). A child process of this CLI builds
//   each part (see parallel-spec.ts) and writes the PDF without post-processing.
// - A part is typeset with the page numbers it has in the whole book: each document of the part is given the
//   number of its first page. The numbers of the pages are taken from the previous build; if they turn out to be
//   different, the parts are built again.
// - The cover and the TOC are built separately: the TOC is generated from the compiled documents, and the page
//   numbers of its links are written as text, since the parts do not know each other.
// - The PDFs are merged, and the outline, the links between the parts, the metadata, etc. are made for the
//   merged PDF.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import upath from 'upath';

import { launchSharedBrowser } from '../browser.js';
import {
  type ParsedEntry,
  type ParsedTheme,
  type PdfOutput,
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
import { injectStyle } from '../processor/compile-cache.js';
import { cliRoot } from '../util.js';
import {
  chooseSplitIndexes,
  type LayoutCache,
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

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);

/** The number of the pages of each document, from the documents of the pages. */
function countPages(spineIndexes: readonly number[]): Map<number, number> {
  const pages = new Map<number, number>();
  for (const spine of spineIndexes) {
    pages.set(spine, (pages.get(spine) ?? 0) + 1);
  }
  return pages;
}

/** A place in the body (the pages after the cover and the TOC) */
interface Place {
  page: number;
  x: number;
  y: number;
}

type ParallelBuildRun = ParallelBuildOptions & {
  splitIndexes: number[];
  unverified?: number[];
  hash?: string;
};

/**
 * A build of a book in parts. `run()` builds the parts, the cover and the TOC, and merges them.
 */
class ParallelBuild {
  private readonly task: ParsedBuildTask;
  private readonly config: ResolvedTaskConfig;
  private readonly inlineConfig: ParsedVivliostyleInlineConfig;
  private readonly jobs: number;
  private readonly unverified: number[];
  private readonly hash: string | undefined;
  private readonly target: PdfOutput;
  /** The entries that start each part, followed by the number of the entries */
  private readonly bounds: number[];
  private readonly partCount: number;
  private readonly entryCount: number;

  /** Aborted when the build fails, to stop the child processes that are running */
  private readonly failure = new AbortController();
  private readonly signal: AbortSignal;
  private readonly runId = `${process.pid}-${Date.now()}`;
  /** Files of a build are put in a directory of its own, so that builds can run at the same time */
  private readonly workDir: string;
  private readonly temporaryFiles: string[] = [];
  private browserWsEndpoint = '';
  private closeBrowser: (() => Promise<void>) | undefined;

  private readonly cachePath: string;
  private readonly cacheKey: string;
  private readonly cache: LayoutCache | undefined;
  private readonly cover: ParsedEntry | undefined;
  private readonly contents: ParsedEntry | undefined;
  private readonly basePath: string;
  /** The URL of the TOC document, which the links of the TOC are relative to */
  private readonly tocUrl: string;

  /** The number of the pages of the cover and the TOC, and of each entry, as they are known now */
  private frontPages: number | undefined;
  private readonly docPages: (number | undefined)[];
  /** The page number that the first page of each entry was given */
  private readonly usedNumber: (number | undefined)[];
  private readonly results: (PartResult | undefined)[];
  /** The number of the spare pages at the beginning of each part */
  private readonly skipped: number[];
  private compiled: Promise<void> | undefined;
  private readonly places = new Map<string, Place>();
  private front: { pdf: string; result: PartResult } | undefined;
  private tocNumbers: Record<string, string> | undefined;

  constructor(options: ParallelBuildRun) {
    const { task, config, inlineConfig } = options;
    this.task = task;
    this.config = config;
    this.inlineConfig = inlineConfig;
    this.jobs = options.jobs;
    this.unverified = options.unverified ?? [];
    this.hash = options.hash;
    const target = config.outputs[0];
    if (target.format !== 'pdf') {
      throw new Error('A PDF output is expected.');
    }
    this.target = target;
    this.entryCount = task.entry.length;
    this.bounds = [0, ...options.splitIndexes, this.entryCount];
    this.partCount = this.bounds.length - 1;
    Logger.debug(
      `parallel > split before the entries ${JSON.stringify(options.splitIndexes)} (not known to be safe: ${JSON.stringify(this.unverified)})`,
    );
    this.signal = inlineConfig.signal
      ? AbortSignal.any([inlineConfig.signal, this.failure.signal])
      : this.failure.signal;

    this.workDir = upath.join(config.workspaceDir, '.parallel', this.runId);
    fs.mkdirSync(this.workDir, { recursive: true, mode: 0o700 });

    this.cachePath = layoutCachePath(config);
    this.cacheKey = layoutCacheKey(config);
    this.cache = readLayoutCache(this.cachePath, this.cacheKey);
    this.cover = config.entries.find((e) => e.rel === 'cover');
    this.contents = config.entries.find((e) => e.rel === 'contents');
    this.basePath = `${config.base.replace(/\/$/v, '')}/`;
    this.tocUrl = `http://localhost:0${this.basePath}${
      this.contents
        ? upath.relative(config.workspaceDir, this.contents.target)
        : ''
    }`;

    this.frontPages = this.hasFront ? this.cache?.frontPages : 0;
    this.docPages = range(0, this.entryCount).map(
      (i) => this.cache?.docPages?.[i],
    );
    this.usedNumber = Array.from({ length: this.entryCount });
    this.results = Array.from({ length: this.partCount });
    this.skipped = Array.from({ length: this.partCount }, () => 0);
  }

  private get hasFront(): boolean {
    return Boolean(this.task.toc) || Boolean(this.task.cover);
  }

  async run(): Promise<string> {
    const started = Date.now();
    try {
      const browser = await launchSharedBrowser(this.config);
      this.browserWsEndpoint = browser.wsEndpoint;
      this.closeBrowser = browser.closeBrowser;

      const speculativeFront = this.startSpeculativeFront();
      await this.buildParts();
      Logger.debug(`parallel > parts built in ${Date.now() - started} ms`);
      this.updatePlaces();
      if (this.hasFront) {
        await this.buildFront(await speculativeFront);
      }
      const merged = await this.merge();
      await this.checkOrKeepReference(merged);
      await this.postProcess(merged);
      this.saveLayout();
      return this.target.path;
    } catch (error) {
      // Stop the child processes that are still running
      this.failure.abort(error);
      throw error;
    } finally {
      await this.closeBrowser?.();
      fs.rmSync(this.workDir, { recursive: true, force: true });
      for (const file of this.temporaryFiles) {
        fs.rmSync(file, { force: true });
      }
    }
  }

  // ---- child processes ---------------------------------------------------------------------------------------

  private runChild(name: string, spec: Omit<PartSpec, 'inlineConfig'>) {
    return runChild({
      spec: {
        inlineConfig: serializeInlineConfig(this.inlineConfig),
        browserWsEndpoint: this.browserWsEndpoint,
        ...spec,
      },
      specPath: upath.join(this.workDir, `${name}.json`),
      config: this.inlineConfig.config,
      cwd: this.inlineConfig.cwd ?? process.cwd(),
      env: secretEnv(this.inlineConfig),
      signal: this.signal,
    });
  }

  private readResult(name: string): PartResult {
    return readJson<PartResult>(
      upath.join(this.workDir, `${name}.result.json`),
    );
  }

  /** Writes a file in the entry context, where the files of the entries are looked for. */
  private temporaryFile(name: string, content: string): string {
    const file = upath.join(
      this.config.entryContextDir,
      `${TEMPORARY_FILE_PREFIX}${this.runId}-${name}`,
    );
    fs.writeFileSync(file, content);
    this.temporaryFiles.push(file);
    return upath.basename(file);
  }

  private partDir(index: number): string {
    return upath.join(this.workDir, `part-${index}`);
  }

  private compiledMark(index: number): string {
    return `${this.partDir(index)}.compiled`;
  }

  // ---- the parts ---------------------------------------------------------------------------------------------

  /** Page number of the first page of the entry in the whole book (as it is known now) */
  private startNumber(entryIndex: number): number {
    let number = (this.frontPages ?? 0) + 1;
    for (let i = 0; i < entryIndex; i++) {
      number += this.docPages[i] ?? 0;
    }
    return number;
  }

  private async buildPart(index: number): Promise<void> {
    const [from, to] = [this.bounds[index], this.bounds[index + 1]];
    // A page number is counted from the first page of the part, and is reset by each document. So each
    // document is given the page number it has in the whole book.
    const inlineStyles = range(from, to).map((i) => {
      const number = this.startNumber(i);
      this.usedNumber[i] = number;
      return {
        path: this.task.entry[i].path ?? '',
        css: `@page :nth(1) { counter-reset: page ${number - 1}; }`,
      };
    });
    // A spare page makes the first page of the part be on the same side (left/right) as in the book
    const leadingFiles: PartSpec['leadingFiles'] =
      this.startNumber(from) % 2 === 0
        ? [
            {
              path: this.temporaryFile(
                `spare-${index}.html`,
                '<!doctype html><html><head><meta charset="utf-8"><title>spare</title></head><body><p>.</p></body></html>',
              ),
            },
          ]
        : [];
    const name = `part-${index}`;
    await this.runChild(name, {
      entries: { range: [from, to] },
      inlineStyles,
      leadingFiles,
      withoutTocAndCover: true,
      output: { path: upath.join(this.workDir, `${name}.pdf`), format: 'pdf' },
      workspaceDir: this.partDir(index),
      resultPath: upath.join(this.workDir, `${name}.result.json`),
      compiledMark: this.compiledMark(index),
    });
    const result = this.readResult(name);
    const pages = countPages(spineIndexesOf(result, `the part ${index}`));
    const spare = leadingFiles.length;
    this.results[index] = result;
    this.skipped[index] = spare ? (pages.get(0) ?? 0) : 0;
    for (const i of range(from, to)) {
      this.docPages[i] = pages.get(i - from + spare) ?? 0;
    }
  }

  /** The parts that were built with page numbers that turned out to be wrong (or were not built) */
  private mismatchedParts(): number[] {
    return range(0, this.partCount).filter((index) =>
      range(this.bounds[index], this.bounds[index + 1]).some(
        (i) => this.usedNumber[i] !== this.startNumber(i),
      ),
    );
  }

  /** Builds the parts until the page numbers of the parts agree with the pages of the preceding parts */
  private async buildParts(): Promise<void> {
    const heavyFirst = (parts: number[]) =>
      orderPartsHeavyFirst(parts, this.bounds, this.docPages);
    let pending = heavyFirst(this.mismatchedParts());
    for (let round = 1; pending.length > 0; round++) {
      if (round > MAX_ROUNDS) {
        throw new Error(
          'The page numbers of the parts did not settle. Try choosing other entries for "parallel.splitBefore".',
        );
      }
      const nothingBuilt = this.results.every((result) => !result);
      Logger.logInfo(
        nothingBuilt && pending.length === this.partCount
          ? `Building ${this.partCount} parts in parallel`
          : `Building ${pending.length} parts again with the right page numbers`,
      );
      await Promise.all([
        pool(
          pending.map((index) => () => this.buildPart(index)),
          this.jobs,
        ),
        // the cover and the TOC with dummy numbers, to know the number of their pages
        nothingBuilt ? this.buildDummyFront() : undefined,
      ]);
      pending = heavyFirst(this.mismatchedParts());
    }
  }

  // ---- the cover and the TOC ---------------------------------------------------------------------------------

  /** Compiles the whole book, for the cover and the TOC, once the parts have compiled their documents */
  private compile(): Promise<void> {
    this.compiled ??= (async () => {
      if (!this.hasFront) {
        return;
      }
      const marks = range(0, this.partCount).map((i) => this.compiledMark(i));
      while (!marks.every((mark) => fs.existsSync(mark))) {
        this.signal.throwIfAborted();
        await sleep(100);
      }
      await this.runChild('compile', {
        entries: { keep: true },
        output: {
          path: upath.join(this.workDir, 'compile.out'),
          format: 'webpub',
        },
        workspaceDir: this.compileDir,
        precompiledDirs: range(0, this.partCount).map((i) => this.partDir(i)),
      });
    })();
    return this.compiled;
  }

  private get compileDir(): string {
    return upath.join(this.workDir, 'compile');
  }

  private compiledTarget(entry: ParsedEntry): string {
    return upath.join(
      this.compileDir,
      upath.relative(this.config.workspaceDir, entry.target),
    );
  }

  /**
   * Builds the cover and the TOC. The page numbers of the links of the TOC are written as text, by `pageOf`
   * (or `00` to know the number of the pages).
   */
  private async buildFrontPdf(
    pageOf?: (href: string) => string,
  ): Promise<{ pdf: string; result: PartResult }> {
    const files: { path: string; theme: string[] }[] = [];
    if (this.cover) {
      files.push({
        path: this.temporaryFile(
          'front-cover.html',
          stripLinks(fs.readFileSync(this.compiledTarget(this.cover), 'utf8')),
        ),
        theme: this.cover.themes.map(themeSpecifier),
      });
    }
    if (this.contents) {
      const html = fs
        .readFileSync(this.compiledTarget(this.contents), 'utf8')
        .replaceAll(
          /<a href="([^"]*)"/gv,
          (_match, href: string) =>
            `<a href="${href}" data-page="${pageOf ? pageOf(href) : '00'}"`,
        );
      files.push({
        path: this.temporaryFile(
          'front-toc.html',
          stripLinks(
            injectStyle(
              html,
              'nav li a::after { content: attr(data-page) !important; }',
            ),
          ),
        ),
        theme: this.contents.themes.map(themeSpecifier),
      });
    }
    const name = pageOf ? 'front' : 'front-dummy';
    const pdf = upath.join(this.workDir, `${name}.pdf`);
    await this.runChild(name, {
      entries: { files },
      withoutTocAndCover: true,
      output: { path: pdf, format: 'pdf' },
      workspaceDir: upath.join(this.workDir, name),
      resultPath: upath.join(this.workDir, `${name}.result.json`),
    });
    return { pdf, result: this.readResult(name) };
  }

  private async buildDummyFront(): Promise<void> {
    if (!this.hasFront || this.frontPages !== undefined) {
      return;
    }
    await this.compile();
    const { result } = await this.buildFrontPdf();
    this.frontPages = frontPageCountOf(result);
  }

  /**
   * If the previous build left the page numbers of the links of the TOC, the cover and the TOC are built while
   * the parts are built; they are used if the numbers turn out to be the same.
   */
  private startSpeculativeFront():
    | Promise<{
        numbers: Record<string, string>;
        front: { pdf: string; result: PartResult };
      } | null>
    | undefined {
    const numbers = this.cache?.tocNumbers;
    if (!this.hasFront || !numbers || this.cache?.frontPages === undefined) {
      return undefined;
    }
    return (
      this.compile()
        .then(() => this.buildFrontPdf((href) => numbers[href] ?? ''))
        .then((front) => ({ numbers, front }))
        // If it failed, the cover and the TOC are built again (and the error is reported then)
        .catch(() => null)
    );
  }

  private pageOf(href: string): string {
    const url = new URL(href, this.tocUrl);
    const place = this.locate(destinationNameOf(url.pathname, url.hash));
    if (!place) {
      Logger.logWarn(`Could not find the page of the TOC link: ${href}`);
      return '';
    }
    return String((this.frontPages ?? 0) + place.page + 1);
  }

  private async buildFront(
    speculative: Awaited<ReturnType<ParallelBuild['startSpeculativeFront']>>,
  ): Promise<void> {
    await this.compile();
    const pageOf = (href: string) => this.pageOf(href);
    const hrefs = this.contents
      ? tocHrefsOf(fs.readFileSync(this.compiledTarget(this.contents), 'utf8'))
      : [];
    if (
      speculative &&
      hrefs.every((href) => pageOf(href) === speculative.numbers[href]) &&
      frontPageCountOf(speculative.front.result) === this.frontPages
    ) {
      Logger.debug(
        'parallel > the cover and the TOC built in advance are used',
      );
      this.front = speculative.front;
    }
    for (let attempt = 1; !this.front; attempt++) {
      const front = await this.buildFrontPdf(pageOf);
      const actual = frontPageCountOf(front.result);
      if (actual === this.frontPages) {
        this.front = front;
      } else if (attempt >= MAX_ROUNDS) {
        throw new Error(
          'The number of the pages of the cover and the TOC did not settle.',
        );
      } else {
        // The number of the pages changed from the previous build: the parts need the right numbers
        this.frontPages = actual;
        await this.buildParts();
        this.updatePlaces();
      }
    }
    this.tocNumbers = Object.fromEntries(
      hrefs.map((href) => [href, pageOf(href)]),
    );
  }

  // ---- where the places that links refer to are ----------------------------------------------------------

  /**
   * Finds the places of the elements in the body. The viewer puts an element named like the PDF destination
   * on every element that has an id.
   */
  private updatePlaces(): void {
    const documentStart: number[] = [];
    let offset = 0;
    for (let i = 0; i < this.entryCount; i++) {
      documentStart[i] = offset;
      offset += this.docPages[i] ?? 0;
    }
    this.places.clear();
    this.results.forEach((result, k) => {
      const spare = this.skipped[k] > 0 ? 1 : 0;
      const spineIndexes = result?.pageInfo?.spineIndexes ?? [];
      for (const [spine, ids] of Object.entries(result?.pageInfo?.ids ?? {})) {
        const global = this.bounds[k] + Number(spine) - spare;
        const first = spineIndexes.indexOf(Number(spine));
        for (const [id, [index, x, y]] of Object.entries(ids)) {
          if (id.startsWith('viv-id-')) {
            this.places.set(normalizeDestinationName(id), {
              page: documentStart[global] + index - first,
              x,
              y,
            });
          }
        }
      }
    });
  }

  /** The place of a destination, or of the document when the place has no element */
  private locate(name: string): Place | undefined {
    return (
      this.places.get(name) ?? this.places.get(name.replace(/:0023.*$/v, ''))
    );
  }

  // ---- merge and post-process --------------------------------------------------------------------------------

  private partResults(): PartResult[] {
    return this.results.map((result, index) => {
      if (!result) {
        throw new Error(`The part ${index} has not been built.`);
      }
      return result;
    });
  }

  /** The results of the PDFs to merge, and the pages that are left out at the beginning of each */
  private sections(): { result: PartResult; skip: number }[] {
    return [
      ...(this.front ? [{ result: this.front.result, skip: 0 }] : []),
      ...this.partResults().map((result, k) => ({
        result,
        skip: this.skipped[k],
      })),
    ];
  }

  private pageSizeData(): PageSizeData[] {
    return this.sections().flatMap(({ result, skip }) =>
      result.pageSizeData.slice(skip),
    );
  }

  /** The TOC of the book is the one of the TOC document; without it, the ones of the parts are put together */
  private tocItems(): TOCItem[] {
    if (this.front && this.front.result.toc.length > 0) {
      return normalizeTocItems(this.front.result.toc);
    }
    if (this.contents) {
      return readTocItems(
        fs.readFileSync(this.compiledTarget(this.contents), 'utf8'),
        this.tocUrl,
      );
    }
    return normalizeTocItems(
      this.partResults().flatMap((result) => result.toc),
    );
  }

  private merge(): Promise<Uint8Array> {
    Logger.logUpdate('Merging PDFs');
    const pageSizeData = this.pageSizeData();
    const outlineIds: string[] = [];
    const collectIds = (items: TOCItem[]) => {
      for (const item of items) {
        outlineIds.push(item.id);
        collectIds(item.children);
      }
    };
    collectIds(this.tocItems());
    // Chromium defines the destinations of the links in the same PDF only. Define the ones that refer to other parts.
    const resolveDestination = (name: string): PdfDestination | undefined => {
      const place = this.locate(name);
      if (!place) {
        return undefined;
      }
      const pageIndex = (this.frontPages ?? 0) + place.page;
      const pageHeight = pageSizeData[pageIndex]?.mediaHeight;
      return pageHeight
        ? { pageIndex, x: place.x, y: pageHeight - place.y }
        : undefined;
    };
    // The links of the TOC refer to documents that are not in the PDF of the cover and the TOC
    const localHosts = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      this.config.server.host,
    ]);
    const uriToDestination = (uri: string): string | undefined => {
      if (!URL.canParse(uri)) {
        return undefined;
      }
      const url = new URL(uri);
      return localHosts.has(url.hostname) &&
        url.pathname.startsWith(this.basePath)
        ? destinationNameOf(url.pathname, url.hash)
        : undefined;
    };
    return mergePdfs(
      [
        ...(this.front
          ? [
              {
                pdf: fs.readFileSync(this.front.pdf),
                pageCount: frontPageCountOf(this.front.result),
              },
            ]
          : []),
        ...this.partResults().map((result, k) => ({
          pdf: fs.readFileSync(upath.join(this.workDir, `part-${k}.pdf`)),
          skipPages: this.skipped[k],
          pageCount: spineIndexesOf(result, `the part ${k}`).length,
        })),
      ],
      {
        signal: this.signal,
        requiredDestinations: outlineIds,
        resolveDestination,
        uriToDestination,
      },
    );
  }

  /**
   * With entries that are not known to be safe to split before, the book has to be the same as the book built as
   * a whole. Otherwise, the PDF is kept as the reference for the next build, which can use it to check.
   */
  private async checkOrKeepReference(merged: Uint8Array): Promise<void> {
    if (!this.hash) {
      return;
    }
    if (this.unverified.length === 0) {
      writeReference(this.cachePath, {
        key: this.cacheKey,
        hash: this.hash,
        pages: await fingerprintPdf(merged),
      });
      return;
    }
    Logger.logUpdate('Checking the PDF');
    const reference = readReference(this.cachePath, this.cacheKey);
    if (!reference) {
      throw new Error('The PDF to check the book with is missing.');
    }
    const different = firstDifferentPage(
      reference.pages,
      await fingerprintPdf(merged),
    );
    if (different !== undefined) {
      throw new UnsafeSplitError(this.unverified, different);
    }
  }

  private async postProcess(merged: Uint8Array): Promise<void> {
    const first = this.sections()[0].result;
    const cmykMap: CmykMap = {};
    for (const { result } of this.sections()) {
      Object.assign(cmykMap, result.cmykMap);
    }
    fs.mkdirSync(upath.dirname(this.target.path), { recursive: true });
    Logger.logUpdate('Processing PDF');
    await postProcessPDF({
      pdf: merged,
      output: this.target.path,
      metadata: first.metadata,
      metadataOptions: {
        pageProgression: first.pageProgression,
        browserVersion: first.browserVersion,
        viewerCoreVersion: first.viewerCoreVersion,
        disableCreatorOption: !!this.config.viewer && !first.viewerCoreVersion,
      },
      tocItems: this.tocItems(),
      pageSizeData: this.pageSizeData(),
      preflight: this.target.preflight,
      preflightOption: this.target.preflightOption,
      image: this.config.image,
      cmyk: this.target.cmyk,
      cmykMap,
      replaceImage: this.target.replaceImage,
      outputIntent: this.target.outputIntent,
      signal: this.signal,
    });
  }

  /** Keeps what this build found out for the next build */
  private saveLayout(): void {
    writeLayoutCache(this.cachePath, {
      key: this.cacheKey,
      frontPages: this.frontPages ?? 0,
      docPages: this.docPages.map((n) => n ?? 0),
      ...(this.tocNumbers ? { tocNumbers: this.tocNumbers } : {}),
    });
    if (this.unverified.length > 0) {
      recordSplitResult(this.cachePath, this.cacheKey, {
        verified: this.unverified,
      });
    }
  }
}

/**
 * Builds the task in parts. Returns the path of the output PDF.
 */
export function buildInParallel(options: ParallelBuildRun): Promise<string> {
  return new ParallelBuild(options).run();
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

/** The documents of the pages that a child process reported. */
function spineIndexesOf(result: PartResult, name: string): number[] {
  const spineIndexes = result.pageInfo?.spineIndexes ?? [];
  if (
    spineIndexes.length === 0 ||
    !spineIndexes.every((index) => Number.isInteger(index))
  ) {
    throw new Error(
      `The viewer did not tell the pages of ${name}. The viewer needs to set data-vivliostyle-spine-index on the page containers.`,
    );
  }
  return spineIndexes;
}

const frontPageCountOf = (result: PartResult): number =>
  spineIndexesOf(result, 'the cover and the TOC').length;
