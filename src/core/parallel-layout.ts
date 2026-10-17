// What the parallel build learns about a book, and how it chooses the places to split the book at.
//
// A build that is not parallel records the number of the pages of each entry and whether the entry starts
// with a named page (see `learnLayout`). The next build uses them to split the book automatically, if
// the book is big enough. A parallel build keeps the numbers up to date.
import fs from 'node:fs';
import os from 'node:os';

import type { Page } from 'puppeteer-core';
import upath from 'upath';

import type { ParsedEntry, ResolvedTaskConfig } from '../config/resolve.js';
import { Logger } from '../logger.js';

/** A book of fewer pages is not built in parallel automatically, since the fixed cost of the parts is not worth it. */
export const AUTO_MIN_PAGES = 150;

/** The number of the parts that run at the same time unless specified. */
export function defaultJobs(): number {
  return Math.min(4, Math.max(2, Math.floor(os.availableParallelism() / 2)));
}

export interface LayoutCache {
  /** What the book is (see `layoutCacheKey`); the cache is not used for another book. */
  key: string;
  /** Number of the pages of the cover and the TOC */
  frontPages?: number;
  /** Number of the pages of each entry */
  docPages?: number[];
  /** Whether each entry starts with a named page, so that the layout of the entry does not depend on the preceding pages */
  named?: boolean[];
}

const isManuscript = (entry: ParsedEntry): boolean =>
  entry.rel === undefined && 'source' in entry;

/** The entries of the book that are written by the author (the cover and the TOC are generated). */
export function manuscriptEntries(config: ResolvedTaskConfig): ParsedEntry[] {
  return config.entries.filter((entry) => isManuscript(entry));
}

export function layoutCacheKey(config: ResolvedTaskConfig): string {
  return JSON.stringify({
    entries: manuscriptEntries(config).map((entry) =>
      upath.relative(config.entryContextDir, entry.target),
    ),
    front: config.entries.some((entry) => !isManuscript(entry)),
  });
}

/**
 * The cache is put in the cache directory of the project if there is one, because the workspace is removed
 * by a build that is not parallel.
 */
export function layoutCachePath(config: ResolvedTaskConfig): string {
  const modulesDir = upath.join(config.entryContextDir, 'node_modules');
  return fs.existsSync(modulesDir)
    ? upath.join(modulesDir, '.cache/vivliostyle-cli/parallel-build.json')
    : upath.join(config.workspaceDir, '.parallel/cache.json');
}

export function readLayoutCache(
  path: string,
  key: string,
): LayoutCache | undefined {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by this module
    const cache = JSON.parse(fs.readFileSync(path, 'utf8')) as LayoutCache;
    return cache.key === key ? cache : undefined;
  } catch {
    return undefined;
  }
}

/** Writes what is given, and keeps the rest of the cache of the same book. */
export function writeLayoutCache(path: string, update: LayoutCache): void {
  const previous = readLayoutCache(path, update.key);
  fs.mkdirSync(upath.dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify({ ...previous, ...update }));
}

/**
 * Chooses the entries to split the book before, so that the parts have similar numbers of pages.
 * The book is split only before the entries that start with a named page.
 * Returns nothing if the book should not be split.
 */
export function chooseSplitIndexes({
  docPages,
  named,
  jobs,
  minPages = AUTO_MIN_PAGES,
}: {
  docPages: readonly number[];
  named: readonly boolean[];
  jobs: number;
  minPages?: number;
}): number[] | undefined {
  const total = docPages.reduce((sum, pages) => sum + pages, 0);
  if (docPages.length !== named.length || total < minPages) {
    return undefined;
  }
  const candidates = named
    .map((isNamed, index) => (isNamed && index > 0 ? index : -1))
    .filter((index) => index > 0);
  const parts = Math.min(jobs, candidates.length + 1);
  if (parts < 2) {
    return undefined;
  }
  const prefix = [0];
  for (const pages of docPages) {
    prefix.push((prefix.at(-1) ?? 0) + pages);
  }
  const pagesBetween = (from: number, to: number) => prefix[to] - prefix[from];
  const points = [0, ...candidates];
  // best[k][j]: the number of the pages of the biggest part, at the best, when the first `k` parts end just before points[j]
  const count = points.length;
  const INF = Number.POSITIVE_INFINITY;
  const best: number[][] = Array.from({ length: parts + 1 }, () =>
    Array.from({ length: count }, () => INF),
  );
  const from: number[][] = Array.from({ length: parts + 1 }, () =>
    Array.from({ length: count }, () => -1),
  );
  // one part: from the start of the book to just before points[j]
  for (let j = 1; j < count; j++) {
    best[1][j] = pagesBetween(0, points[j]);
  }
  for (let k = 2; k < parts; k++) {
    for (let j = k; j < count; j++) {
      for (let i = k - 1; i < j; i++) {
        const value = Math.max(
          best[k - 1][i],
          pagesBetween(points[i], points[j]),
        );
        if (value < best[k][j]) {
          best[k][j] = value;
          from[k][j] = i;
        }
      }
    }
  }
  // the last part ends at the end of the book
  let bestValue = INF;
  let last = -1;
  for (let j = parts - 1; j < count; j++) {
    const value = Math.max(
      best[parts - 1][j],
      pagesBetween(points[j], docPages.length),
    );
    if (value < bestValue) {
      bestValue = value;
      last = j;
    }
  }
  // not worth it when the biggest part is nearly as big as the book
  if (last < 0 || bestValue > total * 0.8) {
    return undefined;
  }
  const result: number[] = [];
  let j = last;
  for (let k = parts - 1; k >= 1; k--) {
    result.unshift(points[j]);
    j = from[k][j] >= 0 ? from[k][j] : j - 1;
  }
  return result;
}

/**
 * Reads, in the browser, how the entries of the book were laid out, and records it for the next build.
 * `page` shows the book (typeset); the entries are loaded in another tab to look at their first boxes.
 */
export async function learnLayout({
  page,
  config,
  cachePath,
  key,
}: {
  page: Page;
  config: ResolvedTaskConfig;
  cachePath: string;
  key: string;
}): Promise<void> {
  const spineIndexes = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '#vivliostyle-viewer-viewport > div > div > div[data-vivliostyle-page-container]',
      ),
    ].map((container) => Number(container.dataset.vivliostyleSpineIndex)),
  );
  const total = spineIndexes.length;
  if (
    total < AUTO_MIN_PAGES ||
    !spineIndexes.every((i) => Number.isInteger(i))
  ) {
    return;
  }
  const pagesOf = config.entries.map(
    (_, index) => spineIndexes.filter((spine) => spine === index).length,
  );
  const frontPages = config.entries.reduce(
    (sum, entry, index) => (isManuscript(entry) ? sum : sum + pagesOf[index]),
    0,
  );
  const manuscripts = config.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isManuscript(entry));

  const tab = await page.browser().newPage();
  const named: boolean[] = [];
  try {
    await tab.setRequestInterception(true);
    tab.on('request', (request) => {
      if (['image', 'media', 'font'].includes(request.resourceType())) {
        void request.abort();
      } else {
        void request.continue();
      }
    });
    const base = `${config.rootUrl}${config.base}/`;
    for (const { entry } of manuscripts) {
      const relative = upath.relative(config.workspaceDir, entry.target);
      await tab.goto(new URL(encodeURI(relative), base).href, {
        waitUntil: 'load',
      });
      named.push(await tab.evaluate(startsWithNamedPage));
    }
  } catch (error) {
    // The numbers of the pages are still useful, but nothing is known about the first pages
    Logger.debug('Failed to look at the first pages of the entries', error);
    named.length = 0;
  } finally {
    await tab.close().catch(() => {});
  }

  writeLayoutCache(cachePath, {
    key,
    frontPages,
    docPages: manuscripts.map(({ index }) => pagesOf[index]),
    ...(named.length === manuscripts.length ? { named } : {}),
  });
}

/**
 * Runs in the browser: whether the first box of the document is on a named page (the `page` property).
 * Such a document always starts a new page, and its first page does not depend on the preceding one.
 */
/* v8 ignore start */
export function startsWithNamedPage(): boolean {
  const pageOf = (element: Element): string =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `page` is not in the type of CSSStyleDeclaration
    (getComputedStyle(element) as unknown as { page?: string }).page ?? 'auto';
  let element: Element | null = document.documentElement;
  while (element) {
    if (getComputedStyle(element).display === 'none') {
      return false;
    }
    if (pageOf(element) !== 'auto') {
      return true;
    }
    // go to the first child, unless text comes first
    let next: Element | null = null;
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
        return false;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the node is an element
        const child = node as Element;
        if (
          ['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD'].includes(
            child.tagName,
          ) ||
          getComputedStyle(child).display === 'none'
        ) {
          continue;
        }
        next = child;
        break;
      }
    }
    element = next;
  }
  return false;
}
/* v8 ignore stop */
