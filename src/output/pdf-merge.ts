import type * as mupdfType from 'mupdf';

import { disposable } from '../disposable.js';
import { importNodeModule } from '../node-modules.js';

export interface PdfDestination {
  /** Index of the page in the merged document. */
  pageIndex: number;
  /** Position in the page (pt, from the bottom left corner). */
  x: number;
  y: number;
}

export interface PdfMergeOptions {
  signal?: AbortSignal;
  /** Names of the destinations that the merged document needs in addition to the ones of the sources (e.g. the ones of the outline). */
  requiredDestinations?: readonly string[];
  /**
   * Gives the position of a destination that is needed (see above, and the destinations of the links)
   * but is not defined in the sources, because Chromium defines the destinations of the links in the same PDF only.
   */
  resolveDestination?: (name: string) => PdfDestination | undefined;
  /**
   * Links to documents that are not in the PDF are URI links. Gives the name of the destination
   * when the URI refers to a place of the book, so that the link is turned into an internal link.
   */
  uriToDestination?: (uri: string) => string | undefined;
}

export interface PdfMergeSource {
  pdf: Uint8Array;
  /** Number of the leading pages that are left out of the merged document. */
  skipPages?: number;
  /** Number of the pages of the source to use (default: all). The ones after them (e.g. a blank page that Chromium adds) are left out. */
  pageCount?: number;
}

/**
 * Chromium names the PDF destinations after the URL of the element, which includes the port of the
 * server that served the document (`viv-id-http:003a:002f:002flocalhost:003a13000:002f...`).
 * PDFs that are built by different processes are served on different ports, so the port is
 * replaced with a fixed value to make the names comparable.
 */
export function normalizeDestinationName(name: string): string {
  return name.replace(/^(viv-id-https?:003a:002f:002f[^:]*:003a)\d+/v, '$10');
}

/**
 * Reads the URL out of the name of a destination that Chromium made for an element
 * (`viv-id-<URL>`, in which the characters other than alphanumerics are written as `:<4 hex digits>`).
 */
export function decodeDestinationName(name: string): string | undefined {
  if (!name.startsWith('viv-id-')) {
    return undefined;
  }
  return name
    .slice('viv-id-'.length)
    .replaceAll(/:([0-9a-f]{4})/giv, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

/** The inverse of `decodeDestinationName` */
export function encodeDestinationName(url: string): string {
  const hex = (unit: number) => `:${unit.toString(16).padStart(4, '0')}`;
  let encoded = 'viv-id-';
  // Characters are written as UTF-16 code units
  for (const char of url) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (/[A-Za-z0-9_\-]/v.test(char)) {
      encoded += char;
    } else if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000;
      encoded += hex(0xd800 + (offset >> 10)) + hex(0xdc00 + (offset & 0x3ff));
    } else {
      encoded += hex(codePoint);
    }
  }
  return encoded;
}

interface MergedDestination {
  name: string;
  pageIndex: number;
  parameters: (number | string | null)[];
}

/**
 * Concatenates PDF files into one document. Pages, link annotations, and named destinations
 * are kept (the destination names are normalized by `normalizeDestinationName`).
 * Other document-level data such as the outline, the structure tree (tagged PDF), and the
 * metadata are not copied; apply them to the merged document afterwards.
 */
export async function mergePdfs(
  sources: readonly PdfMergeSource[],
  {
    signal,
    requiredDestinations = [],
    resolveDestination,
    uriToDestination,
  }: PdfMergeOptions = {},
): Promise<Uint8Array> {
  const mupdf = await importNodeModule('mupdf');
  using merged = disposable(new mupdf.PDFDocument());
  const destinations: MergedDestination[] = [];
  let producer: string | undefined;
  const linkedNames = new Set<string>();

  for (const { pdf, skipPages = 0, pageCount: usedPages } of sources) {
    signal?.throwIfAborted();
    using source = disposable(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- openDocument returns the Document base type; a PDF input yields a PDFDocument
      mupdf.PDFDocument.openDocument(
        pdf,
        'application/pdf',
      ) as mupdfType.PDFDocument,
    );
    producer ??= source.getMetaData('info:Producer') || undefined;
    const pageCount = Math.min(source.countPages(), usedPages ?? Infinity);
    const pageBase = merged.countPages() - skipPages;
    destinations.push(
      ...readDestinations(source, pageBase, skipPages, pageCount),
    );
    using graftMap = disposable(merged.newGraftMap());
    for (let i = skipPages; i < pageCount; i++) {
      // The graft map makes the pages share the fonts and the images that they share in the source
      graftMap.graftPage(-1, source, i);
      copyLinkAnnotations(
        merged,
        source,
        graftMap,
        i,
        merged.countPages() - 1,
        linkedNames,
        uriToDestination,
      );
    }
  }

  signal?.throwIfAborted();
  if (resolveDestination) {
    const missing = new Set(requiredDestinations)
      .union(linkedNames)
      .difference(new Set(destinations.map(({ name }) => name)));
    for (const name of missing) {
      const destination = resolveDestination(name);
      if (destination) {
        destinations.push({
          name,
          pageIndex: destination.pageIndex,
          parameters: ['XYZ', destination.x, destination.y, null],
        });
      }
    }
  }
  writeDestinations(merged, destinations);

  if (producer) {
    merged.setMetaData('info:Producer', producer);
  }

  using output = disposable(merged.saveToBuffer('compress'));
  // Create a copy to ensure the data remains valid after the buffer is destroyed
  return new Uint8Array(output.asUint8Array());
}

function readDestinations(
  source: mupdfType.PDFDocument,
  pageBase: number,
  skipPages: number,
  pageCount: number,
): MergedDestination[] {
  using trailer = disposable(source.getTrailer());
  using catalog = disposable(trailer.get('Root'));
  using dests = disposable(catalog.get('Dests'));
  if (!dests.isDictionary()) {
    return [];
  }

  const pageIndexByObject = new Map<number, number>();
  for (let i = skipPages; i < pageCount; i++) {
    using page = disposable(source.findPage(i));
    pageIndexByObject.set(page.asIndirect(), i);
  }

  const result: MergedDestination[] = [];
  dests.forEach((value, key) => {
    if (typeof key !== 'string' || !value.isArray() || value.length === 0) {
      return;
    }
    using pageRef = disposable(value.get(0));
    const index = pageRef.isIndirect()
      ? pageIndexByObject.get(pageRef.asIndirect())
      : undefined;
    if (index === undefined) {
      // The destination is on a page that is left out
      return;
    }
    const parameters: MergedDestination['parameters'] = [];
    for (let i = 1; i < value.length; i++) {
      using item = disposable(value.get(i));
      parameters.push(
        item.isName()
          ? item.asName()
          : item.isNumber()
            ? item.asNumber()
            : null,
      );
    }
    result.push({
      name: normalizeDestinationName(key),
      pageIndex: pageBase + index,
      parameters,
    });
  });
  return result;
}

function writeDestinations(
  merged: mupdfType.PDFDocument,
  destinations: readonly MergedDestination[],
): void {
  using trailer = disposable(merged.getTrailer());
  using catalog = disposable(trailer.get('Root'));
  using dests = disposable(merged.newDictionary());
  const written = new Set<string>();
  for (const { name, pageIndex, parameters } of destinations) {
    if (written.has(name)) {
      // The same name is defined in several parts; the first one wins
      continue;
    }
    written.add(name);
    using array = disposable(merged.newArray());
    using page = disposable(merged.findPage(pageIndex));
    array.push(page);
    for (const parameter of parameters) {
      using item = disposable(
        typeof parameter === 'string'
          ? merged.newName(parameter)
          : typeof parameter === 'number'
            ? merged.newReal(parameter)
            : merged.newNull(),
      );
      array.push(item);
    }
    dests.put(name, array);
  }
  catalog.put('Dests', dests);
}

function readUri(action: mupdfType.PDFObject): string {
  using uri = disposable(action.get('URI'));
  return uri.isString() ? uri.asString() : '';
}

// graftPage does not copy the annotations, so the links are copied one by one.
// Other kinds of annotations (e.g. widgets, comments) are not used by the PDFs that Chromium prints.
const LINK_KEYS_TO_COPY = ['Rect', 'Border', 'F', 'C', 'QuadPoints'] as const;

function copyLinkAnnotations(
  merged: mupdfType.PDFDocument,
  source: mupdfType.PDFDocument,
  graftMap: mupdfType.PDFGraftMap,
  sourceIndex: number,
  mergedIndex: number,
  linkedNames: Set<string>,
  uriToDestination: PdfMergeOptions['uriToDestination'],
): void {
  using sourcePage = disposable(source.findPage(sourceIndex));
  using sourceAnnotations = disposable(sourcePage.get('Annots'));
  if (!sourceAnnotations.isArray()) {
    return;
  }
  using annotations = disposable(merged.newArray());
  for (let i = 0; i < sourceAnnotations.length; i++) {
    using sourceAnnotation = disposable(sourceAnnotations.get(i).resolve());
    using subtype = disposable(sourceAnnotation.get('Subtype'));
    if (!subtype.isName() || subtype.asName() !== 'Link') {
      continue;
    }
    using annotation = disposable(merged.newDictionary());
    using type = disposable(merged.newName('Annot'));
    annotation.put('Type', type);
    using linkSubtype = disposable(merged.newName('Link'));
    annotation.put('Subtype', linkSubtype);
    for (const key of LINK_KEYS_TO_COPY) {
      using value = disposable(sourceAnnotation.get(key));
      if (!value.isNull()) {
        using grafted = disposable(graftMap.graftObject(value));
        annotation.put(key, grafted);
      }
    }
    using destination = disposable(sourceAnnotation.get('Dest'));
    if (destination.isName()) {
      const normalized = normalizeDestinationName(destination.asName());
      linkedNames.add(normalized);
      using name = disposable(merged.newName(normalized));
      annotation.put('Dest', name);
    }
    using action = disposable(sourceAnnotation.get('A'));
    const uriDestination = action.isDictionary()
      ? uriToDestination?.(readUri(action))
      : undefined;
    if (uriDestination) {
      linkedNames.add(uriDestination);
      using name = disposable(merged.newName(uriDestination));
      annotation.put('Dest', name);
    } else if (action.isDictionary()) {
      using grafted = disposable(graftMap.graftObject(action));
      using actionDestination = disposable(grafted.resolve().get('D'));
      if (actionDestination.isName()) {
        const normalized = normalizeDestinationName(actionDestination.asName());
        linkedNames.add(normalized);
        using name = disposable(merged.newName(normalized));
        grafted.resolve().put('D', name);
      }
      annotation.put('A', grafted);
    }
    using ref = disposable(merged.addObject(annotation));
    annotations.push(ref);
  }
  if (annotations.length > 0) {
    using mergedPage = disposable(merged.findPage(mergedIndex));
    mergedPage.put('Annots', annotations);
  }
}
