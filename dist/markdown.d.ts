import { StringifyMarkdownOptions } from '@vivliostyle/vfm';
import { VFile } from 'vfile';
export interface VSFile extends VFile {
  data: {
    title?: string;
    theme?: string;
  };
}
export declare function processMarkdown(
  filepath: string,
  options?: StringifyMarkdownOptions,
): VSFile;
//# sourceMappingURL=markdown.d.ts.map
