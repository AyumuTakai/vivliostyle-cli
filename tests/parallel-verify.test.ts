import fs from 'node:fs';
import os from 'node:os';

import * as mupdf from 'mupdf';
import upath from 'upath';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  fingerprintPdf,
  firstDifferentPage,
  POSITION_TOLERANCE,
  readReference,
  referencePathOf,
  sourcesHash,
  UnsafeSplitError,
  writeReference,
} from '../src/core/parallel-verify.js';
import { getTaskConfig } from './command-util.js';

/** A PDF with a line of text on each page, `y` points from the bottom. */
function createPdf(lines: { text: string; y: number }[][]): Uint8Array {
  const document = new mupdf.PDFDocument();
  const font = document.addSimpleFont(new mupdf.Font('Helvetica'));
  const fonts = document.newDictionary();
  fonts.put('F1', font);
  const resources = document.newDictionary();
  resources.put('Font', fonts);
  for (const page of lines) {
    const contents = page
      .map(({ text, y }) => `BT /F1 12 Tf 10 ${y} Td (${text}) Tj ET`)
      .join('\n');
    document.insertPage(
      -1,
      document.addPage([0, 0, 200, 200], 0, resources, contents),
    );
  }
  return new Uint8Array(document.saveToBuffer('compress').asUint8Array());
}

describe('fingerprintPdf', () => {
  it('reads the size of the pages and the lines in them', async () => {
    const pages = await fingerprintPdf(
      createPdf([[{ text: 'Hello', y: 100 }], []]),
    );
    expect(pages).toHaveLength(2);
    expect(pages[0].size).toEqual([2000, 2000]);
    expect(pages[0].lines).toHaveLength(1);
    // [hash of the text, x, y of the baseline, width] in 0.1 pt
    expect(pages[0].lines[0][1]).toBe(100);
    expect(pages[0].lines[0][2]).toBe(1000);
    expect(pages[1].lines).toEqual([]);
  });
});

describe('firstDifferentPage', () => {
  const base = [
    [{ text: 'one', y: 100 }],
    [{ text: 'two', y: 100 }],
    [{ text: 'three', y: 100 }],
  ];

  it('finds nothing for the same pages', async () => {
    const a = await fingerprintPdf(createPdf(base));
    const b = await fingerprintPdf(createPdf(base));
    expect(firstDifferentPage(a, b)).toBeUndefined();
  });

  it('accepts a difference of the position that is as small as the tolerance', async () => {
    const a = await fingerprintPdf(createPdf(base));
    const moved = base.map((page) =>
      page.map((line) => ({ ...line, y: line.y + POSITION_TOLERANCE / 10 })),
    );
    const b = await fingerprintPdf(createPdf(moved));
    expect(firstDifferentPage(a, b)).toBeUndefined();
  });

  it('finds the first page whose line moved more than the tolerance', async () => {
    const a = await fingerprintPdf(createPdf(base));
    const b = await fingerprintPdf(
      createPdf([
        base[0],
        [{ text: 'two', y: 101 }],
        [{ text: 'three', y: 102 }],
      ]),
    );
    expect(firstDifferentPage(a, b)).toBe(1);
  });

  it('finds a different text', async () => {
    const a = await fingerprintPdf(createPdf(base));
    const b = await fingerprintPdf(
      createPdf([base[0], base[1], [{ text: 'THREE', y: 100 }]]),
    );
    expect(firstDifferentPage(a, b)).toBe(2);
  });

  it('finds a different number of lines and of pages', async () => {
    const a = await fingerprintPdf(createPdf(base));
    const moreLines = await fingerprintPdf(
      createPdf([[...base[0], { text: 'extra', y: 50 }], base[1], base[2]]),
    );
    expect(firstDifferentPage(a, moreLines)).toBe(0);
    const fewerPages = await fingerprintPdf(createPdf(base.slice(0, 2)));
    expect(firstDifferentPage(a, fewerPages)).toBe(2);
    expect(firstDifferentPage(fewerPages, a)).toBe(2);
  });
});

describe('sourcesHash and the reference', () => {
  let cwd: string;
  beforeAll(() => {
    cwd = fs.mkdtempSync(upath.join(os.tmpdir(), 'vivliostyle-verify-'));
    fs.writeFileSync(upath.join(cwd, 'a.md'), '# a\n');
    fs.writeFileSync(upath.join(cwd, 'b.md'), '# b\n');
    fs.writeFileSync(upath.join(cwd, 'style.css'), 'p { color: red; }\n');
  });
  afterAll(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const config = (options: object = {}) =>
    getTaskConfig([], cwd, {
      entry: ['a.md', 'b.md'],
      theme: 'style.css',
      output: 'book.pdf',
      ...options,
    } as never);

  it('changes when a source, a style file, or an option of the layout changes', async () => {
    const before = sourcesHash(await config());
    expect(sourcesHash(await config())).toBe(before);

    fs.appendFileSync(upath.join(cwd, 'b.md'), 'more\n');
    const afterSource = sourcesHash(await config());
    expect(afterSource).not.toBe(before);

    fs.appendFileSync(upath.join(cwd, 'style.css'), 'p { margin: 0; }\n');
    const afterStyle = sourcesHash(await config());
    expect(afterStyle).not.toBe(afterSource);

    expect(sourcesHash(await config({ size: 'A5' }))).not.toBe(afterStyle);
  });

  it('is written next to the cache, for the same book only', () => {
    const cachePath = upath.join(cwd, 'cache/parallel-build.json');
    expect(referencePathOf(cachePath)).toBe(
      upath.join(cwd, 'cache/parallel-reference.json'),
    );
    expect(readReference(cachePath, 'book')).toBeUndefined();
    const pages = [{ size: [1, 2] as [number, number], lines: [] }];
    writeReference(cachePath, { key: 'book', hash: 'h', pages });
    expect(readReference(cachePath, 'book')).toEqual({
      key: 'book',
      hash: 'h',
      pages,
    });
    expect(readReference(cachePath, 'another book')).toBeUndefined();
  });
});

describe('UnsafeSplitError', () => {
  it('tells the entries and the page', () => {
    const error = new UnsafeSplitError([3, 5], 11);
    expect(error).toBeInstanceOf(Error);
    expect(error.entries).toEqual([3, 5]);
    expect(error.page).toBe(11);
    expect(error.message).toContain('page 12');
  });
});
