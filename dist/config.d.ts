import { PageSize } from './server';
export interface Entry {
  path: string;
  title?: string;
  theme?: string;
}
export declare type ParsedTheme = UriTheme | FileTheme | PackageTheme;
export interface UriTheme {
  type: 'uri';
  name: string;
  location: string;
  replace?: string;
}
export interface FileTheme {
  type: 'file';
  name: string;
  location: string;
  replace?: string;
}
export interface PackageTheme {
  type: 'package';
  name: string;
  location: string;
  style: string;
  replace?: string;
}
export interface ParsedEntry {
  type: 'markdown' | 'html';
  title?: string;
  theme?: ParsedTheme;
  source: {
    path: string;
    dir: string;
  };
  target: {
    path: string;
    dir: string;
  };
}
export interface VivliostyleConfig {
  title?: string;
  author?: string;
  theme?: string;
  entry: string | Entry | (string | Entry)[];
  entryContext?: string;
  size?: string;
  format?: 'pdf';
  pressReady?: boolean;
  outDir?: string;
  outFile?: string;
  language?: string;
  toc?: boolean | string;
  cover?: string;
  distDir?: string;
  timeout?: number;
}
export interface CliFlags {
  input?: string;
  configPath?: string;
  outFile?: string;
  outDir?: string;
  theme?: string;
  size?: string;
  pressReady?: boolean;
  title?: string;
  author?: string;
  language?: string;
  verbose?: boolean;
  distDir?: string;
  timeout?: number;
  sandbox?: boolean;
  executableChromium?: string;
}
export interface MergedConfig {
  entryContextDir: string;
  artifactDir: string;
  distDir: string;
  outputPath: string;
  entries: ParsedEntry[];
  themeIndexes: ParsedTheme[];
  size: PageSize | undefined;
  pressReady: boolean;
  projectTitle: string;
  projectAuthor: string;
  language: string;
  toc: string | boolean;
  cover: string | undefined;
  verbose: boolean;
  timeout: number;
  sandbox: boolean;
  executableChromium: string;
}
export declare function validateTimeoutFlag(val: string): number;
export declare function contextResolve(
  context: string,
  loc: string | undefined,
): string | undefined;
export declare function parseTheme(
  locator: string | undefined,
  contextDir: string,
): ParsedTheme | undefined;
export declare function collectVivliostyleConfig(
  configPath: string,
): VivliostyleConfig | undefined;
export declare function getVivliostyleConfigPath(configPath?: string): string;
export declare function mergeConfig<T extends CliFlags>(
  cliFlags: T,
  config: VivliostyleConfig | undefined,
  context: string,
): Promise<MergedConfig>;
//# sourceMappingURL=config.d.ts.map
