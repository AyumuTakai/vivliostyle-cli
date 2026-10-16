import type { TOCItem } from '../global-viewer.js';
import { encodeDestinationName } from '../output/pdf-merge.js';
import { getJsdomFromString } from '../processor/html.js';

/**
 * Name of the PDF destination that Chromium makes for a place of the book.
 * The port of the server is replaced with 0 (see `normalizeDestinationName`).
 */
export function destinationNameOf(pathname: string, hash: string): string {
  let id = hash.replace(/^#/v, '');
  try {
    id = decodeURIComponent(id);
  } catch {
    // use as is
  }
  return encodeDestinationName(
    `http://localhost:0${pathname}${id ? `#${id}` : ''}`,
  );
}

/**
 * Reads the items of the outline from the table of contents document.
 * `documentUrl` is the URL of the document (the links are relative to it).
 */
export function readTocItems(html: string, documentUrl: string): TOCItem[] {
  const { document } = getJsdomFromString({ html }).window;
  const nav = document.querySelector('nav[role="doc-toc"], nav#toc, nav');
  const readList = (list: Element): TOCItem[] =>
    [...list.children].flatMap((item): TOCItem[] => {
      if (item.tagName !== 'LI') {
        return [];
      }
      const link = [...item.children].find((child) => child.tagName === 'A');
      const sublist = [...item.children].find(
        (child) => child.tagName === 'OL',
      );
      if (!link) {
        return sublist ? readList(sublist) : [];
      }
      const url = new URL(link.getAttribute('href') ?? '', documentUrl);
      return [
        {
          id: destinationNameOf(url.pathname, url.hash),
          title: link.textContent.trim(),
          children: sublist ? readList(sublist) : [],
        },
      ];
    });
  const list = nav && [...nav.children].find((child) => child.tagName === 'OL');
  return list ? readList(list) : [];
}
