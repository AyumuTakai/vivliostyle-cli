// Checks that a book built in parts is the same as the book built as a whole.
//
// The text of each page and the positions of its lines (a "fingerprint") are compared with the ones of a PDF that
// is known to be right: the PDF of a build that is not parallel, or of a parallel build that split the book only
// before entries that start with a named page.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import upath from 'upath';

import type { ResolvedTaskConfig } from '../config/resolve.js';
import { importNodeModule } from '../node-modules.js';
import { collectLocalCssReferences } from '../processor/css.js';
import { manuscriptEntries } from './parallel-layout.js';

/** Positions are kept in 0.1 pt. */
const SCALE = 10;
/** Positions that differ by 0.5 pt or less are the same. */
export const POSITION_TOLERANCE = 5;

export interface PageFingerprint {
  /** Size of the page */
  size: [width: number, height: number];
  /** For each line: a hash of the text, the position (x, y of the baseline), and the width */
  lines: [text: string, x: number, y: number, width: number][];
}

export interface Reference {
  /** What the book is (see `layoutCacheKey`) */
  key: string;
  /** What the book contains (see `sourcesHash`); the reference is of the contents at the time */
  hash: string;
  pages: PageFingerprint[];
}

const shortHash = (text: string): string =>
  createHash('sha1').update(text).digest('hex').slice(0, 12);

/** Reads the text and the positions of the lines of a PDF. */
export async function fingerprintPdf(
  pdf: Uint8Array,
): Promise<PageFingerprint[]> {
  const mupdf = await importNodeModule('mupdf');
  const document = mupdf.Document.openDocument(pdf, 'application/pdf');
  try {
    const pages: PageFingerprint[] = [];
    for (let i = 0; i < document.countPages(); i++) {
      const page = document.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const stext = page.toStructuredText('preserve-whitespace');
        try {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON of mupdf
          const json = JSON.parse(stext.asJSON(SCALE)) as {
            blocks: {
              lines?: {
                x: number;
                y: number;
                text: string;
                bbox: { w: number };
              }[];
            }[];
          };
          pages.push({
            size: [
              Math.round((x1 - x0) * SCALE),
              Math.round((y1 - y0) * SCALE),
            ],
            lines: json.blocks.flatMap((block) =>
              (block.lines ?? []).map(
                (line): PageFingerprint['lines'][number] => [
                  shortHash(line.text),
                  line.x,
                  line.y,
                  line.bbox.w,
                ],
              ),
            ),
          });
        } finally {
          stext.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return pages;
  } finally {
    document.destroy();
  }
}

/**
 * Compares fingerprints. Returns the index of the first page that is different, or nothing if they are the same.
 */
export function firstDifferentPage(
  expected: readonly PageFingerprint[],
  actual: readonly PageFingerprint[],
  tolerance = POSITION_TOLERANCE,
): number | undefined {
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const count = Math.max(expected.length, actual.length);
  for (let i = 0; i < count; i++) {
    const a = expected[i];
    const b = actual[i];
    if (
      !a ||
      !b ||
      !near(a.size[0], b.size[0]) ||
      !near(a.size[1], b.size[1]) ||
      a.lines.length !== b.lines.length ||
      a.lines.some(
        (line, j) =>
          line[0] !== b.lines[j][0] ||
          !near(line[1], b.lines[j][1]) ||
          !near(line[2], b.lines[j][2]) ||
          !near(line[3], b.lines[j][3]),
      )
    ) {
      return i;
    }
  }
  return undefined;
}

/**
 * A hash of what the typesetting of the book depends on: the sources of the entries, the style files that are
 * given by the config with the files they refer to (imported style files, images, fonts), and the options of the
 * layout.
 */
export function sourcesHash(config: ResolvedTaskConfig): string {
  const hash = createHash('sha1');
  const addFile = (path: string) => {
    hash.update(path);
    try {
      hash.update(fs.readFileSync(path));
    } catch {
      hash.update('?');
    }
  };
  for (const entry of manuscriptEntries(config)) {
    if (entry.source?.type === 'file') {
      addFile(entry.source.pathname);
    } else {
      hash.update(entry.source?.href ?? entry.target);
    }
  }
  for (const theme of config.themeIndexes) {
    if (theme.type === 'file') {
      addFile(theme.source);
      for (const file of collectLocalCssReferences(theme.source)) {
        addFile(file);
      }
    } else {
      hash.update(theme.name);
    }
  }
  hash.update(
    JSON.stringify([
      config.size,
      config.css,
      config.customStyle,
      config.customUserStyle,
      config.cropMarks,
      config.bleed,
      config.cropOffset,
      config.viewer,
      config.viewerParam,
    ]),
  );
  return hash.digest('hex');
}

/** The reference is put next to the cache of the layout. */
export const referencePathOf = (cachePath: string): string =>
  upath.join(upath.dirname(cachePath), 'parallel-reference.json');

export function readReference(
  cachePath: string,
  key: string,
): Reference | undefined {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by this module
    const reference = JSON.parse(
      fs.readFileSync(referencePathOf(cachePath), 'utf8'),
    ) as Reference;
    return reference.key === key ? reference : undefined;
  } catch {
    return undefined;
  }
}

export function writeReference(cachePath: string, reference: Reference): void {
  fs.mkdirSync(upath.dirname(cachePath), { recursive: true });
  fs.writeFileSync(referencePathOf(cachePath), JSON.stringify(reference));
}

/** Thrown when a book built in parts is different from the book built as a whole. */
export class UnsafeSplitError extends Error {
  /** The entries that the book was split before without knowing that it is safe */
  entries: number[];
  /** The page that is different */
  page: number;

  constructor(entries: number[], page: number) {
    super(
      `The book built in parts is different from the book built as a whole (page ${page + 1}).`,
    );
    this.name = 'UnsafeSplitError';
    this.entries = entries;
    this.page = page;
  }
}
