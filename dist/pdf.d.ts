import { MergedConfig, ParsedEntry } from './config';
export interface BuildPdfOptions extends MergedConfig {
  input: string;
  entries: ParsedEntry[];
}
export declare function buildPDF({
  input,
  distDir,
  outputPath,
  size,
  executableChromium,
  sandbox,
  verbose,
  timeout,
  pressReady,
  entryContextDir,
  entries,
}: BuildPdfOptions): Promise<string>;
//# sourceMappingURL=pdf.d.ts.map
