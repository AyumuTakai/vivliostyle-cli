import { StringifyMarkdownOptions, VFM } from '@vivliostyle/vfm';
import fs from 'fs';
import vfile, { VFile } from 'vfile';

export interface VSFile extends VFile {
  data: {
    title?: string;
    theme?: string;
  };
}

export type PreProcess = (filepath: string, contents: string) => string;

function getContents(
  filepath: string,
  preprocess: PreProcess[] | undefined,
): string {
  let contents = fs.readFileSync(filepath, 'utf8');
  if (contents && preprocess) {
    for (const proc of preprocess) {
      contents = proc(filepath, contents);
    }
  }
  return contents;
}

export function processMarkdown(
  filepath: string,
  options: StringifyMarkdownOptions = {},
  preprocess: PreProcess[] | undefined = undefined,
): VSFile {
  const vfm = VFM(options);
  const processed = vfm.processSync(
    vfile({ path: filepath, contents: getContents(filepath, preprocess) }),
  ) as VSFile;
  return processed;
}
