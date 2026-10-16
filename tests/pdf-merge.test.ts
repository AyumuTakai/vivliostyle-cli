import * as mupdf from 'mupdf';
import { describe, expect, it } from 'vitest';

import {
  mergePdfs,
  normalizeDestinationName,
} from '../src/output/pdf-merge.js';

const destName = (port: number, path: string) =>
  `viv-id-http:003a:002f:002flocalhost:003a${port}:002fvivliostyle:002f${path}`;

/** Creates a PDF whose pages are labeled with `label-<index>`, with named destinations and links. */
function createPdf({
  label,
  pageCount,
  destinations = [],
  links = [],
  uriLinks = [],
}: {
  label: string;
  pageCount: number;
  destinations?: { name: string; page: number }[];
  links?: { page: number; name: string }[];
  uriLinks?: { page: number; uri: string }[];
}): Uint8Array {
  const document = new mupdf.PDFDocument();
  const font = document.addSimpleFont(new mupdf.Font('Helvetica'));
  const fonts = document.newDictionary();
  fonts.put('F1', font);
  const resources = document.newDictionary();
  resources.put('Font', fonts);
  for (let i = 0; i < pageCount; i++) {
    const page = document.addPage(
      [0, 0, 200, 200],
      0,
      resources,
      `BT /F1 12 Tf 10 100 Td (${label}-${i}) Tj ET`,
    );
    document.insertPage(-1, page);
  }
  const catalog = document.getTrailer().get('Root');
  if (destinations.length > 0) {
    const dests = document.newDictionary();
    for (const { name, page } of destinations) {
      const array = document.newArray();
      /* oxlint-disable unicorn/prefer-single-call -- PDFObject.push takes one item */
      array.push(document.findPage(page));
      array.push(document.newName('XYZ'));
      array.push(document.newReal(0));
      array.push(document.newReal(190));
      array.push(document.newNull());
      /* oxlint-enable unicorn/prefer-single-call */
      dests.put(name, array);
    }
    catalog.put('Dests', dests);
  }
  for (const { page, name } of links) {
    const annotation = document.newDictionary();
    annotation.put('Type', document.newName('Annot'));
    annotation.put('Subtype', document.newName('Link'));
    annotation.put('Rect', [0, 0, 50, 50]);
    annotation.put('Dest', document.newName(name));
    const pageObject = document.findPage(page);
    const existing = pageObject.get('Annots');
    const annots = existing.isArray() ? existing : document.newArray();
    annots.push(document.addObject(annotation));
    pageObject.put('Annots', annots);
  }
  for (const { page, uri } of uriLinks) {
    const action = document.newDictionary();
    action.put('S', document.newName('URI'));
    action.put('URI', document.newString(uri));
    const annotation = document.newDictionary();
    annotation.put('Type', document.newName('Annot'));
    annotation.put('Subtype', document.newName('Link'));
    annotation.put('Rect', [0, 0, 50, 50]);
    annotation.put('A', action);
    const pageObject = document.findPage(page);
    const existing = pageObject.get('Annots');
    const annots = existing.isArray() ? existing : document.newArray();
    annots.push(document.addObject(annotation));
    pageObject.put('Annots', annots);
  }
  return new Uint8Array(document.saveToBuffer('compress').asUint8Array());
}

function openMerged(pdf: Uint8Array) {
  return mupdf.PDFDocument.openDocument(
    pdf,
    'application/pdf',
  ) as mupdf.PDFDocument;
}

function pageText(document: mupdf.PDFDocument, index: number): string {
  return document.loadPage(index).toStructuredText().asText().trim();
}

function readDests(document: mupdf.PDFDocument) {
  const dests = document.getTrailer().get('Root').get('Dests');
  const result: Record<string, { page: number; parameters: unknown[] }> = {};
  const pages = new Map<number, number>();
  for (let i = 0; i < document.countPages(); i++) {
    pages.set(document.findPage(i).asIndirect(), i);
  }
  dests.forEach((value, key) => {
    result[String(key)] = {
      page: pages.get(value.get(0).asIndirect()) ?? -1,
      parameters: [1, 2, 3].map((j) => {
        const item = value.get(j);
        return item.isName()
          ? item.asName()
          : item.isNumber()
            ? item.asNumber()
            : null;
      }),
    };
  });
  return result;
}

describe('normalizeDestinationName', () => {
  it('replaces the port of the server', () => {
    expect(normalizeDestinationName(destName(13000, 'a.html'))).toBe(
      destName(0, 'a.html'),
    );
    expect(
      normalizeDestinationName(
        'viv-id-https:003a:002f:002f127.0.0.1:003a443:002fa.html',
      ),
    ).toBe('viv-id-https:003a:002f:002f127.0.0.1:003a0:002fa.html');
  });

  it('keeps other names', () => {
    expect(normalizeDestinationName('foo')).toBe('foo');
    expect(normalizeDestinationName('viv-id-file:003a:002f:002fa.html')).toBe(
      'viv-id-file:003a:002f:002fa.html',
    );
  });
});

describe('mergePdfs', () => {
  it('concatenates the pages in the order of the sources', async () => {
    const merged = openMerged(
      await mergePdfs([
        { pdf: createPdf({ label: 'a', pageCount: 2 }) },
        { pdf: createPdf({ label: 'b', pageCount: 3 }) },
      ]),
    );
    expect(merged.countPages()).toBe(5);
    expect([0, 1, 2, 3, 4].map((i) => pageText(merged, i))).toEqual([
      'a-0',
      'a-1',
      'b-0',
      'b-1',
      'b-2',
    ]);
  });

  it('leaves out the leading pages of a source', async () => {
    const merged = openMerged(
      await mergePdfs([
        { pdf: createPdf({ label: 'a', pageCount: 2 }) },
        { pdf: createPdf({ label: 'b', pageCount: 4 }), skipPages: 2 },
      ]),
    );
    expect([0, 1, 2, 3].map((i) => pageText(merged, i))).toEqual([
      'a-0',
      'a-1',
      'b-2',
      'b-3',
    ]);
  });

  it('moves the named destinations to the merged pages and normalizes their names', async () => {
    const merged = openMerged(
      await mergePdfs([
        {
          pdf: createPdf({
            label: 'a',
            pageCount: 2,
            destinations: [{ name: destName(13001, 'a.html'), page: 1 }],
          }),
        },
        {
          pdf: createPdf({
            label: 'b',
            pageCount: 3,
            destinations: [
              { name: destName(13002, 'b.html'), page: 2 },
              { name: destName(13002, 'spare.html'), page: 0 },
            ],
          }),
          skipPages: 1,
        },
      ]),
    );
    const dests = readDests(merged);
    expect(Object.keys(dests).toSorted()).toEqual(
      [destName(0, 'a.html'), destName(0, 'b.html')].toSorted(),
    );
    expect(dests[destName(0, 'a.html')]).toEqual({
      page: 1,
      parameters: ['XYZ', 0, 190],
    });
    // page 2 of the source b is the 4th page of the merged document (the first page of b is left out)
    expect(dests[destName(0, 'b.html')].page).toBe(3);
  });

  it('normalizes the destinations of the links', async () => {
    const merged = openMerged(
      await mergePdfs([
        {
          pdf: createPdf({
            label: 'a',
            pageCount: 1,
            links: [{ page: 0, name: destName(13001, 'b.html') }],
          }),
        },
        {
          pdf: createPdf({
            label: 'b',
            pageCount: 1,
            destinations: [{ name: destName(13002, 'b.html'), page: 0 }],
          }),
        },
      ]),
    );
    const annots = merged.findPage(0).get('Annots');
    expect(annots.length).toBe(1);
    expect(annots.get(0).resolve().get('Dest').asName()).toBe(
      destName(0, 'b.html'),
    );
    expect(Object.keys(readDests(merged))).toContain(destName(0, 'b.html'));
  });

  it('keeps the first destination when the same name is defined twice', async () => {
    const merged = openMerged(
      await mergePdfs([
        {
          pdf: createPdf({
            label: 'a',
            pageCount: 1,
            destinations: [{ name: 'x', page: 0 }],
          }),
        },
        {
          pdf: createPdf({
            label: 'b',
            pageCount: 1,
            destinations: [{ name: 'x', page: 0 }],
          }),
        },
      ]),
    );
    expect(readDests(merged).x.page).toBe(0);
  });

  it('works for sources without destinations', async () => {
    const merged = openMerged(
      await mergePdfs([{ pdf: createPdf({ label: 'a', pageCount: 1 }) }]),
    );
    expect(merged.countPages()).toBe(1);
  });

  it('stops when the signal is aborted', async () => {
    await expect(
      mergePdfs([{ pdf: createPdf({ label: 'a', pageCount: 1 }) }], {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow('aborted');
  });

  it('defines the destinations that are needed but missing, with the position the callback gives', async () => {
    const merged = openMerged(
      await mergePdfs(
        [
          { pdf: createPdf({ label: 'a', pageCount: 2 }) },
          { pdf: createPdf({ label: 'b', pageCount: 2 }) },
        ],
        {
          requiredDestinations: ['outline-item', 'unknown'],
          resolveDestination: (name) =>
            ({ 'outline-item': { pageIndex: 3, x: 10, y: 20 } })[name],
        },
      ),
    );
    expect(readDests(merged)).toEqual({
      'outline-item': { page: 3, parameters: ['XYZ', 10, 20] },
    });
  });

  it('defines the destinations of the links that refer to other sources', async () => {
    const target = destName(0, 'b.html');
    const merged = openMerged(
      await mergePdfs(
        [
          {
            pdf: createPdf({
              label: 'a',
              pageCount: 1,
              links: [{ page: 0, name: destName(13001, 'b.html') }],
            }),
          },
          { pdf: createPdf({ label: 'b', pageCount: 1 }) },
        ],
        {
          resolveDestination: (name) =>
            ({ [target]: { pageIndex: 1, x: 0, y: 190 } })[name],
        },
      ),
    );
    expect(readDests(merged)[target].page).toBe(1);
  });

  it('turns URI links to places of the book into internal links', async () => {
    const merged = openMerged(
      await mergePdfs(
        [
          {
            pdf: createPdf({
              label: 'a',
              pageCount: 1,
              uriLinks: [
                { page: 0, uri: 'http://localhost:13001/vivliostyle/b.html#x' },
                { page: 0, uri: 'https://example.com/' },
              ],
            }),
          },
          { pdf: createPdf({ label: 'b', pageCount: 1 }) },
        ],
        {
          uriToDestination: (uri) =>
            ({
              'http://localhost:13001/vivliostyle/b.html#x': 'internal-name',
            })[uri],
          resolveDestination: (name) =>
            ({ 'internal-name': { pageIndex: 1, x: 0, y: 190 } })[name],
        },
      ),
    );
    const annots = merged.findPage(0).get('Annots');
    expect(annots.length).toBe(2);
    const internal = annots.get(0).resolve();
    expect(internal.get('Dest').asName()).toBe('internal-name');
    expect(internal.get('A').isNull()).toBe(true);
    const external = annots.get(1).resolve();
    expect(external.get('A').get('URI').asString()).toBe(
      'https://example.com/',
    );
    expect(readDests(merged)['internal-name'].page).toBe(1);
  });
});
