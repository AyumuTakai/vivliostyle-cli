import fs from 'node:fs';

import { fileTypeFromFile } from 'file-type';
import * as mupdf from 'mupdf';
import { describe, expect, it } from 'vitest';

import { resolveFixture, runCommand } from './command-util.js';

describe('pdf output', () => {
  it('generate pdf without errors', async () => {
    await runCommand(
      ['build', '-s', 'A4', '-o', '.vs-pdf/test.pdf', 'index.html'],
      {
        cwd: resolveFixture('wood'),
        port: 23000,
      },
    );

    // mimetype test
    const type = await fileTypeFromFile(
      resolveFixture('wood/.vs-pdf/test.pdf'),
    );
    expect(type!.mime).toEqual('application/pdf');
  }, 120000);

  it('keeps the content of object and embed elements on the pages after the first', async () => {
    await runCommand(
      ['build', '-s', 'A5', '-o', '.vs-pdf/test.pdf', 'index.html'],
      {
        cwd: resolveFixture('embedded-svg'),
        port: 23001,
      },
    );

    const document = mupdf.Document.openDocument(
      fs.readFileSync(resolveFixture('embedded-svg/.vs-pdf/test.pdf')),
      'application/pdf',
    );
    const texts = Array.from({ length: document.countPages() }, (_, index) =>
      document.loadPage(index).toStructuredText().asText(),
    );
    expect(texts).toHaveLength(3);
    // The text in the SVG
    expect(texts[1]).toContain('embedded');
    expect(texts[2]).toContain('embedded');
  }, 120000);
});
