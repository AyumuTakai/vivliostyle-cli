import { StringifyMarkdownOptions, VFM } from '@vivliostyle/vfm';
import vfile, { VFile } from 'vfile';

export interface VSFile extends VFile {
  data: {
    title?: string;
    theme?: string;
  };
}

export function processMarkdown(
  input: { path: string; contents: string },
  options: StringifyMarkdownOptions = {},
): VSFile {
  const vfm = VFM(options);
  const processed = vfm.processSync(vfile(input)) as VSFile;
  return processed;
}
