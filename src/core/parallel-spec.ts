import fs from 'node:fs';

/**
 * Instructions that the parent process of a parallel build gives to a child process
 * (`vivliostyle build --part-spec <file>`). The child process loads the same config file and
 * changes what it builds as described here.
 */
export interface PartSpec {
  /** Inline options of the parent process (the ones that can be serialized). */
  inlineConfig: Record<string, unknown>;
  /** Replaces the entries of the build. */
  entries:
    | {
        /** Entries of the config in [from, to). */
        range: [from: number, to: number];
        /** Stylesheets added to the theme of each of these entries (by the index in the range). */
        extraThemes?: string[][];
      }
    | {
        /** Entries that are not in the config. Paths are relative to the entry context. */
        files: { path: string; theme?: string[] }[];
      }
    | { keep: true };
  /**
   * Documents that are put before the entries. They make the first page of the entries
   * get the page number it has in the whole book (see `pageNumberOffset`).
   */
  leadingFiles?: { path: string; theme?: string[] }[];
  /** Remove `toc` and `cover` from the config. */
  withoutTocAndCover?: boolean;
  /** Path of the file to be written. */
  output: { path: string; format: 'pdf' | 'webpub' };
  /** Directory for the intermediate files. */
  workspaceDir: string;
  /**
   * When set, the PDF is not post-processed: the PDF as printed by the browser is written to `output`,
   * and what the post-processing needs is written to this file in JSON (see `PartResult`).
   */
  resultPath?: string;
  /** A file that is created when the documents have been compiled. */
  compiledMark?: string;
  /** Workspaces of other builds to take the compiled documents from. */
  precompiledDirs?: string[];
  /** The browser launched by the parent process to connect to. */
  browserWsEndpoint?: string;
}

let current: PartSpec | undefined;

export function readPartSpec(path: string): PartSpec {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the file is written by the parent process
  return JSON.parse(fs.readFileSync(path, 'utf8')) as PartSpec;
}

export function setPartSpec(spec: PartSpec | undefined): void {
  current = spec;
}

export function getPartSpec(): PartSpec | undefined {
  return current;
}
