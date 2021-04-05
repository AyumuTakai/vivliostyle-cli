import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ErrorObject } from 'ajv/lib/types/index';
import chalk from 'chalk';
import cheerio from 'cheerio';
import fs from 'fs';
import puppeteer from 'puppeteer';
import path from 'upath';
import { pathToFileURL } from 'url';
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
import { cwd, debug, isUrlString, log, readJSON, touchTmpFile } from './util';

export interface CliFlags {
  input?: string;
  configPath?: string;
  targets?: OutputFormat[];
  theme?: string;
  size?: string;
  style?: string;
  userStyle?: string;
  singleDoc?: boolean;
  quick?: boolean;
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
  customStyle: string | undefined;
  customUserStyle: string | undefined;
  singleDoc: boolean;
  quick: boolean;
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
      const inputPath = path.resolve(cwd, cliFlags.input);
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

/**
 *
 */
class ConfigComposer {
  protected cliFlags: CliFlags;
  protected config: VivliostyleConfigSchema | undefined;
  protected context: string;

  public entryContextDir: string = '';
  public workspaceDir: string = '';
  public entries: ParsedEntry[] = [];
  public input: InputFormat = { format: 'markdown', entry: '' };
  public exportAliases: { source: string; target: string }[] = [];
  public themeIndexes: ThemeManager = new ThemeManager();

  public constructor(
    cliFlags: CliFlags,
    config: VivliostyleConfigSchema | undefined,
    context: string,
  ) {
    this.cliFlags = cliFlags;
    this.config = config;
    this.context = context;
  }

  public exportConfig(manifestConfig: ManifestConfig): MergedConfig {
    const config: MergedConfig = {
      entryContextDir: this.entryContextDir,
      workspaceDir: this.workspaceDir,
      entries: this.entries,
      input: this.input,
      outputs: this.outputs(),
      themeIndexes: this.themeIndexes,
      includeAssets: this.includeAssets(),
      exportAliases: this.exportAliases,
      size: this.size(),
      customStyle: this.customStyle(),
      customUserStyle: this.customUserStyle(),
      singleDoc: this.singleDoc(),
      quick: this.quick(),
      pressReady: this.pressReady(),
      language: this.language(),
      cover: this.cover(),
      verbose: this.verbose(),
      timeout: this.timeout(),
      sandbox: this.sandbox(),
      executableChromium: this.executableChromium(),
      ...manifestConfig,
    };
    return config;
  }

  public includeAssets(): string[] {
    return this.config?.includeAssets
      ? Array.isArray(this.config.includeAssets)
        ? this.config.includeAssets
        : [this.config.includeAssets]
      : DEFAULT_ASSETS;
  }

  public language(): string | null {
    return this.cliFlags.language ?? this.config?.language ?? null;
  }

  public size(): PageSize | undefined {
    const sizeFlag = this.cliFlags.size ?? this.config?.size;
    return sizeFlag ? parsePageSize(sizeFlag) : undefined;
  }

  public customStyle(): string | undefined {
    return (
      this.cliFlags.style &&
      (isUrlString(this.cliFlags.style)
        ? this.cliFlags.style
        : pathToFileURL(this.cliFlags.style).href)
    );
  }

  public customUserStyle(): string | undefined {
    return (
      this.cliFlags.userStyle &&
      (isUrlString(this.cliFlags.userStyle)
        ? this.cliFlags.userStyle
        : pathToFileURL(this.cliFlags.userStyle).href)
    );
  }

  public singleDoc(): boolean {
    return this.cliFlags.singleDoc ?? false;
  }

  public quick(): boolean {
    return this.cliFlags.quick ?? false;
  }

  public cover(): string | undefined {
    return (
      contextResolve(this.entryContextDir!, this.config?.cover) ?? undefined
    );
  }

  public pressReady(): boolean {
    return this.cliFlags.pressReady ?? this.config?.pressReady ?? false;
  }

  public verbose(): boolean {
    return this.cliFlags.verbose ?? false;
  }

  public timeout(): number {
    return this.cliFlags.timeout ?? this.config?.timeout ?? DEFAULT_TIMEOUT;
  }

  public sandbox(): boolean {
    return this.cliFlags.sandbox ?? true;
  }

  public executableChromium(): string {
    return this.cliFlags.executableChromium ?? puppeteer.executablePath();
  }

  public outputs(): OutputFormat[] {
    if (this.cliFlags.targets?.length) {
      return this.cliFlags.targets.map(({ path: outputPath, format }) => ({
        path: path.resolve(outputPath),
        format,
      }));
    }
    if (this.config?.output) {
      return (Array.isArray(this.config.output)
        ? this.config.output
        : [this.config.output]
      ).map((target) => {
        if (typeof target === 'string') {
          return detectOutputFormat(path.resolve(this.context, target));
        }
        const outputPath = path.resolve(this.context, target.path);
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
    const filename = this.config?.title
      ? `${this.config.title}.pdf`
      : 'output.pdf';
    return [
      {
        path: path.resolve(this.context, filename),
        format: 'pdf',
      },
    ];
  }
}

/**
 *   単一ファイル用設定構築
 */
class SingleInputConfigComposer extends ConfigComposer {
  sourcePath: string;
  workspaceDir: string;
  /**
   * コンストラクタ
   * @param cliFlags
   * @param config
   * @param context
   */
  public constructor(
    cliFlags: CliFlags,
    config: VivliostyleConfigSchema | undefined,
    context: string,
  ) {
    super(cliFlags, config, context);
    if (isUrlString(cliFlags.input!)) {
      this.workspaceDir = this.entryContextDir = cwd;
      this.sourcePath = this.cliFlags.input!;
      this.input = { format: 'webbook', entry: this.sourcePath };
    } else {
      this.entryContextDir = path.resolve(
        cliFlags.input
          ? path.dirname(path.resolve(context, cliFlags.input))
          : contextResolve(context, config?.entryContext) ?? context,
      );
      this.workspaceDir =
        contextResolve(context, config?.workspaceDir) ?? this.entryContextDir;
      this.themeIndexes.setCliTheme(this.cliFlags, this.workspaceDir!);
      this.themeIndexes.setConfigTheme(
        this.config,
        this.context,
        this.workspaceDir!,
      );
      this.sourcePath = path.resolve(this.cliFlags.input);
      this.input = detectInputFormat(this.sourcePath);
    }
  }

  /**
   *
   */
  public async compose(): Promise<MergedConfig> {
    debug('entering single entry config mode');
    const tmpPrefix = `.vs-${Date.now()}.`;

    // composeSingleInputConfig()のworkspaceDirとmergeConfig()のworkspaceDirは別のパスになることがあるので注意
    const workspaceDir = path.dirname(this.sourcePath);

    if (this.input.format === 'markdown') {
      // Single input file; create temporary file
      const type = detectManuscriptMediaType(this.sourcePath);
      const metadata = parseFileMetadata(type, this.sourcePath, workspaceDir);
      const target = path
        .resolve(workspaceDir, `${tmpPrefix}${path.basename(this.sourcePath)}`)
        .replace(/\.md$/, '.html');
      await touchTmpFile(target);
      const theme = this.themeIndexes.singleInputTheme(metadata);
      const entry = new ManuscriptEntry(
        type,
        metadata.title,
        theme,
        this.sourcePath,
        target,
        undefined,
      );
      this.entries.push(entry);
      this.exportAliases.push({
        source: target,
        target: path.resolve(
          workspaceDir,
          path.basename(this.sourcePath).replace(/\.md$/, '.html'),
        ),
      });
    }
    let manifestConfig: ManifestConfig;
    if (this.input.format === 'markdown') {
      // create temporary manifest file
      const manifestPath = path.resolve(
        workspaceDir,
        `${tmpPrefix}${MANIFEST_FILENAME}`,
      );
      await touchTmpFile(manifestPath);
      this.exportAliases.push({
        source: manifestPath,
        target: path.resolve(workspaceDir, MANIFEST_FILENAME),
      });
      // WebPublicationManifestConfig
      manifestConfig = {
        manifestPath,
        manifestAutoGenerate: {
          title:
            this.cliFlags.title ??
            this.config?.title ??
            (this.entries.length === 1 && this.entries[0].title
              ? (this.entries[0].title as string)
              : path.basename(this.sourcePath)),
          author: this.cliFlags.author ?? this.config?.author ?? '',
        },
      };
    } else if (
      this.input.format === 'html' ||
      this.input.format === 'webbook'
    ) {
      // WebbookEntryConfig
      manifestConfig = { webbookEntryPath: this.input.entry };
    } else if (this.input.format === 'pub-manifest') {
      // WebPublicationManifestConfig
      manifestConfig = {
        manifestPath: this.input.entry,
        manifestAutoGenerate: null,
      };
    } else if (this.input.format === 'epub-opf') {
      // EpubManifestConfig
      manifestConfig = { epubOpfPath: this.input.entry };
    } else if (this.input.format === 'epub') {
      // EpubManifestConfig
      manifestConfig = {
        epubOpfPath: (await openEpubToTmpDirectory(this.input.entry))
          .epubOpfPath,
      };
    } else {
      throw new Error('Failed to export manifest declaration');
    }
    return this.exportConfig(manifestConfig);
  }
}

/**
 *
 */
class ProjectConfigComposer extends ConfigComposer {
  private autoGeneratedTocPath: string | undefined;
  private projectTitle: string | undefined;
  private projectAuthor: string | undefined;

  public constructor(
    cliFlags: CliFlags,
    config: VivliostyleConfigSchema | undefined,
    context: string,
  ) {
    super(cliFlags, config, context);
    if (!config) {
      throw new Error(
        'No input is set. Please set an appropriate entry or a Vivliostyle config file.',
      );
    }
    this.entryContextDir = path.resolve(
      cliFlags.input
        ? path.dirname(path.resolve(context, cliFlags.input))
        : contextResolve(context, config?.entryContext) ?? context,
    );
    this.workspaceDir =
      contextResolve(context, config?.workspaceDir) ?? this.entryContextDir;
  }

  /**
   *
   * @param e
   * @private
   */
  private normalizeEntry(
    e: string | EntryObject | ContentsEntryObject,
  ): EntryObject | ContentsEntryObject {
    if (typeof e === 'object') {
      return e;
    }
    return { path: e };
  }

  /**
   *
   * @param entry
   * @private
   */
  private parseEntry(entry: EntryObject | ContentsEntryObject): ParsedEntry {
    if (!('path' in entry)) {
      const title = entry.title ?? this.config?.tocTitle ?? TOC_TITLE;
      const theme = (this.themeIndexes as ThemeManager).tocTheme(
        entry,
        this.context,
        this.workspaceDir!,
      );
      const target = this.autoGeneratedTocPath!;
      return new ContentsEntry(title, theme, target);
    }
    const sourcePath = path.resolve(this.entryContextDir, entry.path); // abs
    const contextEntryPath = path.relative(this.entryContextDir!, sourcePath); // rel
    const targetPath = path
      .resolve(this.workspaceDir, contextEntryPath)
      .replace(/\.md$/, '.html');
    const type = detectManuscriptMediaType(sourcePath);
    const metadata = parseFileMetadata(type, sourcePath, this.workspaceDir!);

    const title = entry.title ?? metadata.title ?? this.projectTitle;
    const theme = (this.themeIndexes as ThemeManager).resolveEntryTheme(
      metadata,
      entry,
      this.context,
      this.workspaceDir,
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

  /**
   *
   */
  public async compose(): Promise<MergedConfig> {
    debug('entering project config mode');
    const pkgJsonPath = path.resolve(this.context, 'package.json');
    const pkgJson = fs.existsSync(pkgJsonPath)
      ? readJSON(pkgJsonPath)
      : undefined;
    if (pkgJson) {
      debug('located package.json path', pkgJsonPath);
    }

    this.themeIndexes.setCliTheme(this.cliFlags, this.workspaceDir!);
    this.themeIndexes.setConfigTheme(
      this.config,
      this.context,
      this.workspaceDir!,
    );

    this.autoGeneratedTocPath = path.resolve(
      this.workspaceDir,
      typeof this.config?.toc === 'string' ? this.config.toc : TOC_FILENAME,
    );
    this.projectTitle =
      this.cliFlags.title ?? this.config?.title ?? pkgJson?.name;
    this.projectAuthor =
      this.cliFlags.author ?? this.config?.author ?? pkgJson?.author;

    this.entries = this.config?.entry
      ? (Array.isArray(this.config.entry)
          ? this.config.entry
          : [this.config.entry]
        )
          .map(this.normalizeEntry)
          .map(this.parseEntry, this)
      : [];
    if (!this.entries.length) {
      throw new Error(
        'The entry fields seems to be empty. Make sure your Vivliostyle configuration.',
      );
    }

    let fallbackProjectTitle: string = '';

    if (!this.projectTitle) {
      if (this.entries.length === 1 && this.entries[0].title) {
        fallbackProjectTitle = this.entries[0].title;
      } else {
        fallbackProjectTitle = path.basename(this.outputs()[0].path);
        log(
          `\n${chalk.yellow(
            'Could not find any appropriate publication title. We set ',
          )}${chalk.bold.yellow(`"${fallbackProjectTitle}"`)}${chalk.yellow(
            ' as a fallback.',
          )}`,
        );
      }
    }
    if (
      !!this.config?.toc &&
      !this.entries.find(({ rel }) => rel === 'contents')
    ) {
      const title = this.config?.tocTitle ?? TOC_TITLE;
      const theme = (this.themeIndexes as ThemeManager).rootTheme();
      const entry = new ContentsEntry(title, theme, this.autoGeneratedTocPath);
      this.entries.unshift(entry);
    }

    this.input = {
      format: 'pub-manifest',
      entry: path.join(this.workspaceDir, MANIFEST_FILENAME),
    };
    this.exportAliases = [];
    return this.exportConfig({
      manifestPath: path.join(this.workspaceDir, MANIFEST_FILENAME),
      manifestAutoGenerate: {
        title: this.projectTitle || fallbackProjectTitle,
        author: this.projectAuthor || '',
      },
    });
  }
}

/**
 *
 * @param cliFlags
 * @param config
 * @param context
 */
export async function mergeConfig<T extends CliFlags>(
  cliFlags: T,
  config: VivliostyleConfigSchema | undefined,
  context: string,
): Promise<MergedConfig> {
  debug('context directory', context);
  debug('cliFlags', cliFlags);
  debug('vivliostyle.config.js', config);
  let parsedConfig: MergedConfig;
  if (cliFlags.input) {
    // CLIで1つの入力ファイルが指定された
    // 入力ファイルの種類によってManifestConfigのいずれかを実装するMergedConfigを返す
    const composer = new SingleInputConfigComposer(cliFlags, config, context);
    parsedConfig = await composer.compose();
  } else {
    // CLIで入力ファイルが指定されていない
    // WebPublicationManifestConfigを実装するMergedConfigを返す
    const composer = new ProjectConfigComposer(cliFlags, config, context);
    parsedConfig = await composer.compose();
  }
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

/**
 *
 * @param config
 * @param cliFlags
 */
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
