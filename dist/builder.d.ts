import { Entry, MergedConfig, ParsedEntry } from './config';
export interface ManifestOption {
  title?: string;
  author?: string;
  language?: string;
  modified: string;
  entries: Entry[];
  toc?: boolean | string;
  cover?: string;
}
export interface ManifestEntry {
  href: string;
  type: string;
  rel?: string;
  [index: string]: number | string | undefined;
}
export declare function cleanup(location: string): void;
export declare function generateManifest(
  outputPath: string,
  options: ManifestOption,
): void;
export declare function generateToC(
  entries: ParsedEntry[],
  distDir: string,
): string;
export declare function buildArtifacts({
  entryContextDir,
  artifactDir,
  projectTitle,
  themeIndexes,
  entries,
  distDir,
  projectAuthor,
  language,
  toc,
  cover,
}: MergedConfig): Promise<{
  manifestPath: string;
}>;
//# sourceMappingURL=builder.d.ts.map
