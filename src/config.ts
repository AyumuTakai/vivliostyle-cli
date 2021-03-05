import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ErrorObject } from 'ajv/lib/types/index';
import chalk from 'chalk';
import cheerio from 'cheerio';
import fs from 'fs';
import process from 'process';
import puppeteer from 'puppeteer';
import path from 'upath';
import { MANIFEST_FILENAME, TOC_FILENAME, TOC_TITLE } from './const';
import { ContentsEntry, ManuscriptEntry, ParsedEntry } from './entry';
import { openEpubToTmpDirectory } from './epub';
import {
  detectInputFormat,
  detectManuscriptMediaType,
  InputFormat,
  ManuscriptMediaType,
} from './input';
import { processMarkdown } from './markdown';
import {
  availableOutputFormat,
  detectOutputFormat,
  OutputFormat,
} from './output';
import type {
  ContentsEntryObject,
  EntryObject,
  VivliostyleConfigSchema,
} from './schema/vivliostyle.config';
import configSchema from './schema/vivliostyle.config.schema.json';
import { PageSize } from './server';
import { ParsedTheme, ThemeManager } from './theme';
import { debug, log, readJSON, touchTmpFile } from './util';

export interface CliFlags {
  input?: string;
  configPath?: string;
  targets?: OutputFormat[];
  theme?: string;
  size?: string;
  pressReady?: boolean;
  title?: string;
  author?: string;
  language?: string;
  verbose?: boolean;
  timeout?: number;
  sandbox?: boolean;
  executableChromium?: string;
}

export interface WebPublicationManifestConfig {
  manifestPath: string;
  manifestAutoGenerate: {
    title: string;
    author: string;
  } | null;
}
export interface EpubManifestConfig {
  epubOpfPath: string;
}
export interface WebbookEntryConfig {
  webbookEntryPath: string;
}
export type ManifestConfig = XOR<
  [WebPublicationManifestConfig, WebbookEntryConfig, EpubManifestConfig]
>;

export type MergedConfig = {
  entryContextDir: string;
  workspaceDir: string;
  entries: ParsedEntry[];
  input: InputFormat;
  outputs: OutputFormat[];
  themeIndexes: ParsedTheme[];
  includeAssets: string[];
  exportAliases: {
    source: string;
    target: string;
  }[];
  size: PageSize | undefined;
  pressReady: boolean;
  language: string | null;
  cover: string | undefined;
  verbose: boolean;
  timeout: number;
  sandbox: boolean;
  executableChromium: string;
} & ManifestConfig;

const DEFAULT_TIMEOUT = 2 * 60 * 1000; // 2 minutes

const DEFAULT_ASSETS = [
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.svg',
  '**/*.gif',
  '**/*.webp',
  '**/*.apng',
  '**/*.ttf',
  '**/*.otf',
  '**/*.woff',
  '**/*.woff2',
];

export function validateTimeoutFlag(val: string) {
  return Number.isFinite(+val) && +val > 0 ? +val * 1000 : DEFAULT_TIMEOUT;
}

export function contextResolve(
  context: string,
  loc: string | undefined,
): string | undefined {
  return loc && path.resolve(context, loc);
}

function normalizeEntry(
  e: string | EntryObject | ContentsEntryObject,
): EntryObject | ContentsEntryObject {
  if (typeof e === 'object') {
    return e;
  }
  return { path: e };
}

function parsePageSize(size: string): PageSize {
  const [width, height, ...others] = `${size}`.split(',');
  if (others.length) {
    throw new Error(`Cannot parse size: ${size}`);
  } else if (width && height) {
    return {
      width,
      height,
    };
  } else {
    return {
      format: width ?? 'Letter',
    };
  }
}

function parseFileMetadata(
  type: ManuscriptMediaType,
  sourcePath: string,
  workspaceDir: string,
): { title?: string; theme?: ParsedTheme[] } {
  const sourceDir = path.dirname(sourcePath);
  let title: string | undefined;
  let theme: ParsedTheme[] = [];
  if (type === 'text/markdown') {
    const contents = fs.readFileSync(sourcePath, 'utf-8');
    const file = processMarkdown({ path: sourcePath, contents: contents });
    title = file.data.title;
    theme = ThemeManager.parseThemes(file.data.theme, sourceDir, workspaceDir);
  } else {
    const $ = cheerio.load(fs.readFileSync(sourcePath, 'utf8'));
    title = $('title')?.text() ?? undefined;
  }
  return { title, theme };
}

interface AjvError {
  keyword: string;
  dataPath: string;
  schemaPath: string;
  params: object;
  message: string;
}

function formatAjvErrors(errors: ErrorObject[] | undefined | null): string[] {
  if (!errors) return [];
  const errorDict: { [name: string]: string[] } = {};
  for (const error of errors) {
    if (!errorDict[error.dataPath]) {
      errorDict[error.dataPath] = [];
    }
    if (error.params.type) {
      // add type error only
      errorDict[error.dataPath].push(error.params.type);
    }
  }
  return Object.entries(errorDict).map(
    (messages) => `${messages[0]} should be ${messages[1].join(' | ')}`,
  );
}

export function collectVivliostyleConfig<T extends CliFlags>(
  cliFlags: T,
): {
  cliFlags: T;
  vivliostyleConfig?: VivliostyleConfigSchema;
  vivliostyleConfigPath: string;
} {
  const load = (configPath: string) => {
    if (!fs.existsSync(configPath)) {
      return undefined;
    }
    const config = require(configPath) as VivliostyleConfigSchema;

    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const valid = ajv.validate(configSchema, config);
    if (!valid) {
      const errors = '\n\t' + formatAjvErrors(ajv.errors).join('\n\t') + '\n';
      throw new Error(
        `Validation of vivliostyle.config failed. Please check the schema: ${configPath}${errors}`,
      );
    }
    return config;
  };

  const cwd = process.cwd();
  let vivliostyleConfigPath = cliFlags.configPath
    ? path.resolve(cwd, cliFlags.configPath)
    : path.join(cwd, 'vivliostyle.config.js');
  let vivliostyleConfig = load(vivliostyleConfigPath);
  if (
    !vivliostyleConfig &&
    cliFlags.input &&
    path.basename(cliFlags.input).startsWith('vivliostyle.config')
  ) {
    // Load an input argument as a Vivliostyle config
    try {
      const inputPath = path.resolve(process.cwd(), cliFlags.input);
      const inputConfig = load(inputPath);
      if (inputConfig) {
        cliFlags = {
          ...cliFlags,
          input: undefined,
        };
        vivliostyleConfigPath = inputPath;
        vivliostyleConfig = inputConfig;
      }
    } catch (_err) {}
  }
  return {
    cliFlags,
    vivliostyleConfig,
    vivliostyleConfigPath,
  };
}

export async function mergeConfig<T extends CliFlags>(
  cliFlags: T,
  config: VivliostyleConfigSchema | undefined,
  context: string,
): Promise<MergedConfig> {
  debug('context directory', context);
  debug('cliFlags', cliFlags);
  debug('vivliostyle.config.js', config);
  let entryContextDir: string;
  let workspaceDir: string;

  if (cliFlags.input && /https?:\/\//.test(cliFlags.input)) {
    workspaceDir = entryContextDir = process.cwd();
  } else {
    entryContextDir = path.resolve(
      cliFlags.input
        ? path.dirname(path.resolve(context, cliFlags.input))
        : contextResolve(context, config?.entryContext) ?? context,
    );
    workspaceDir =
      contextResolve(context, config?.workspaceDir) ?? entryContextDir;
  }

  const includeAssets = config?.includeAssets
    ? Array.isArray(config.includeAssets)
      ? config.includeAssets
      : [config.includeAssets]
    : DEFAULT_ASSETS;

  const language = cliFlags.language ?? config?.language ?? null;
  const sizeFlag = cliFlags.size ?? config?.size;
  const size = sizeFlag ? parsePageSize(sizeFlag) : undefined;
  const cover = contextResolve(entryContextDir, config?.cover) ?? undefined;
  const pressReady = cliFlags.pressReady ?? config?.pressReady ?? false;

  const verbose = cliFlags.verbose ?? false;
  const timeout = cliFlags.timeout ?? config?.timeout ?? DEFAULT_TIMEOUT;
  const sandbox = cliFlags.sandbox ?? true;
  const executableChromium =
    cliFlags.executableChromium ?? puppeteer.executablePath();

  const themeIndexes = new ThemeManager();
  themeIndexes.setCliTheme(cliFlags, workspaceDir);
  themeIndexes.setConfigTheme(config, context, workspaceDir);

  const outputs = ((): OutputFormat[] => {
    if (cliFlags.targets?.length) {
      return cliFlags.targets.map(({ path: outputPath, format }) => ({
        path: path.resolve(outputPath),
        format,
      }));
    }
    if (config?.output) {
      return (Array.isArray(config.output)
        ? config.output
        : [config.output]
      ).map((target) => {
        if (typeof target === 'string') {
          return detectOutputFormat(path.resolve(context, target));
        }
        const outputPath = path.resolve(context, target.path);
        if (!target.format) {
          return { ...target, ...detectOutputFormat(outputPath) };
        }
        if (
          !availableOutputFormat.includes(
            target.format as typeof availableOutputFormat[number],
          )
        ) {
          throw new Error(`Unknown format: ${target.format}`);
        }
        return { ...target, path: outputPath } as OutputFormat;
      });
    }
    // Outputs a pdf file if any output configuration is not set
    const filename = config?.title ? `${config.title}.pdf` : 'output.pdf';
    return [
      {
        path: path.resolve(context, filename),
        format: 'pdf',
      },
    ];
  })();

  const commonOpts: CommonOpts = {
    entryContextDir,
    workspaceDir,
    includeAssets,
    outputs,
    themeIndexes,
    pressReady,
    size,
    language,
    cover,
    verbose,
    timeout,
    sandbox,
    executableChromium,
  };
  if (!cliFlags.input && !config) {
    throw new Error(
      'No input is set. Please set an appropriate entry or a Vivliostyle config file.',
    );
  }
  const parsedConfig = cliFlags.input
    ? await composeSingleInputConfig(commonOpts, cliFlags, config)
    : await composeProjectConfig(commonOpts, cliFlags, config, context);
  debug('parsedConfig', parsedConfig);
  checkUnusedCliFlags(parsedConfig, cliFlags);
  return parsedConfig;
}

type CommonOpts = Omit<
  MergedConfig,
  | 'input'
  | 'entries'
  | 'exportAliases'
  | 'manifestPath'
  | 'manifestAutoGenerate'
  | 'epubOpfPath'
  | 'webbookEntryPath'
  | 'projectTitle'
  | 'projectAuthor'
>;

async function composeSingleInputConfig<T extends CliFlags>(
  otherConfig: CommonOpts,
  cliFlags: T,
  config: VivliostyleConfigSchema | undefined,
): Promise<MergedConfig> {
  debug('entering single entry config mode');

  let sourcePath: string;
  let workspaceDir: string;
  let input: InputFormat;
  const entries: ParsedEntry[] = [];
  const exportAliases: { source: string; target: string }[] = [];
  const tmpPrefix = `.vs-${Date.now()}.`;

  if (cliFlags.input && /https?:\/\//.test(cliFlags.input)) {
    sourcePath = cliFlags.input;
    workspaceDir = otherConfig.workspaceDir;
    input = { format: 'webbook', entry: sourcePath };
  } else {
    sourcePath = path.resolve(cliFlags.input);
    workspaceDir = path.dirname(sourcePath);
    input = detectInputFormat(sourcePath);
  }

  if (input.format === 'markdown') {
    // Single input file; create temporary file
    const type = detectManuscriptMediaType(sourcePath);
    const metadata = parseFileMetadata(type, sourcePath, workspaceDir);
    const target = path
      .resolve(workspaceDir, `${tmpPrefix}${path.basename(sourcePath)}`)
      .replace(/\.md$/, '.html');
    await touchTmpFile(target);
    const theme = (otherConfig.themeIndexes as ThemeManager).singleInputTheme(
      metadata,
    );
    const entry = new ManuscriptEntry(
      type,
      metadata.title,
      theme,
      sourcePath,
      target,
      undefined,
    );
    entries.push(entry);
    exportAliases.push({
      source: target,
      target: path.resolve(
        workspaceDir,
        path.basename(sourcePath).replace(/\.md$/, '.html'),
      ),
    });
  }

  const manifestDeclaration = await (async (): Promise<ManifestConfig> => {
    if (input.format === 'markdown') {
      // create temporary manifest file
      const manifestPath = path.resolve(
        workspaceDir,
        `${tmpPrefix}${MANIFEST_FILENAME}`,
      );
      await touchTmpFile(manifestPath);
      exportAliases.push({
        source: manifestPath,
        target: path.resolve(workspaceDir, MANIFEST_FILENAME),
      });
      return {
        manifestPath,
        manifestAutoGenerate: {
          title:
            cliFlags.title ??
            config?.title ??
            (entries.length === 1 && entries[0].title
              ? (entries[0].title as string)
              : path.basename(sourcePath)),
          author: cliFlags.author ?? config?.author ?? '',
        },
      };
    } else if (input.format === 'html' || input.format === 'webbook') {
      return { webbookEntryPath: input.entry };
    } else if (input.format === 'pub-manifest') {
      return { manifestPath: input.entry, manifestAutoGenerate: null };
    } else if (input.format === 'epub-opf') {
      return { epubOpfPath: input.entry };
    } else if (input.format === 'epub') {
      const { epubOpfPath } = await openEpubToTmpDirectory(input.entry);
      return { epubOpfPath };
    } else {
      throw new Error('Failed to export manifest declaration');
    }
  })();

  return {
    ...otherConfig,
    ...manifestDeclaration,
    entries,
    input,
    exportAliases,
  };
}

async function composeProjectConfig<T extends CliFlags>(
  otherConfig: CommonOpts,
  cliFlags: T,
  config: VivliostyleConfigSchema | undefined,
  context: string,
): Promise<MergedConfig> {
  debug('entering project config mode');

  const { entryContextDir, workspaceDir, outputs } = otherConfig;
  const pkgJsonPath = path.resolve(context, 'package.json');
  const pkgJson = fs.existsSync(pkgJsonPath)
    ? readJSON(pkgJsonPath)
    : undefined;
  if (pkgJson) {
    debug('located package.json path', pkgJsonPath);
  }

  const autoGeneratedTocPath = path.resolve(
    workspaceDir,
    typeof config?.toc === 'string' ? config.toc : TOC_FILENAME,
  );

  const projectTitle: string | undefined =
    cliFlags.title ?? config?.title ?? pkgJson?.name;
  const projectAuthor: string | undefined =
    cliFlags.author ?? config?.author ?? pkgJson?.author;

  function parseEntry(entry: EntryObject | ContentsEntryObject): ParsedEntry {
    if (!('path' in entry)) {
      const title = entry.title ?? config?.tocTitle ?? TOC_TITLE;
      const theme = (otherConfig.themeIndexes as ThemeManager).tocTheme(
        entry,
        context,
        workspaceDir,
      );
      const target = autoGeneratedTocPath;
      return new ContentsEntry(title, theme, target);
    }
    const sourcePath = path.resolve(entryContextDir, entry.path); // abs
    const contextEntryPath = path.relative(entryContextDir, sourcePath); // rel
    const targetPath = path
      .resolve(workspaceDir, contextEntryPath)
      .replace(/\.md$/, '.html');
    const type = detectManuscriptMediaType(sourcePath);
    const metadata = parseFileMetadata(type, sourcePath, workspaceDir);

    const title = entry.title ?? metadata.title ?? projectTitle;
    const theme = (otherConfig.themeIndexes as ThemeManager).resolveEntryTheme(
      metadata,
      entry,
      context,
      workspaceDir,
    );

    return new ManuscriptEntry(
      type,
      title,
      theme,
      sourcePath,
      targetPath,
      entry.rel,
    );
  }

  const entries: ParsedEntry[] = config?.entry
    ? (Array.isArray(config.entry) ? config.entry : [config.entry])
        .map(normalizeEntry)
        .map(parseEntry)
    : [];
  if (!entries.length) {
    throw new Error(
      'The entry fields seems to be empty. Make sure your Vivliostyle configuration.',
    );
  }

  let fallbackProjectTitle: string = '';
  if (!projectTitle) {
    if (entries.length === 1 && entries[0].title) {
      fallbackProjectTitle = entries[0].title;
    } else {
      fallbackProjectTitle = path.basename(outputs[0].path);
      log(
        `\n${chalk.yellow(
          'Could not find any appropriate publication title. We set ',
        )}${chalk.bold.yellow(`"${fallbackProjectTitle}"`)}${chalk.yellow(
          ' as a fallback.',
        )}`,
      );
    }
  }
  if (!!config?.toc && !entries.find(({ rel }) => rel === 'contents')) {
    const title = config?.tocTitle ?? TOC_TITLE;
    const theme = (otherConfig.themeIndexes as ThemeManager).rootTheme();
    const entry = new ContentsEntry(title, theme, autoGeneratedTocPath);
    entries.unshift(entry);
  }

  return {
    ...otherConfig,
    entries,
    input: {
      format: 'pub-manifest',
      entry: path.join(workspaceDir, MANIFEST_FILENAME),
    },
    exportAliases: [],
    manifestPath: path.join(workspaceDir, MANIFEST_FILENAME),
    manifestAutoGenerate: {
      title: projectTitle || fallbackProjectTitle,
      author: projectAuthor || '',
    },
  };
}

export function checkUnusedCliFlags<T extends CliFlags>(
  config: MergedConfig,
  cliFlags: T,
) {
  const unusedFlags: string[] = [];
  if (!config.manifestPath) {
    if (cliFlags.theme) {
      unusedFlags.push('--theme');
    }
    if (cliFlags.title) {
      unusedFlags.push('--title');
    }
    if (cliFlags.author) {
      unusedFlags.push('--author');
    }
    if (cliFlags.language) {
      unusedFlags.push('--language');
    }
  }
  if (unusedFlags.length) {
    log('\n');
    unusedFlags.forEach((flag) => {
      log(
        `${chalk.bold.yellow(flag)}${chalk.bold.yellow(
          ` flag seems to be set but the current export setting doesn't support this. This option will be ignored.`,
        )}`,
      );
    });
  }
}
