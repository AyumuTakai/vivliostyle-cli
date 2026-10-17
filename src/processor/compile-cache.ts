// A cache of the HTML that the documents of a book are compiled to (the option `compileCache`).
//
// The key of a document is made of what the document is compiled from: the source, the options of the compile,
// and the code of the config (the files in the directory of the config file, and the lock file, since the document
// processor and the plugins are functions that cannot be hashed). The cache does not know what a plugin reads from
// outside (time, environment variables, network, files in other directories), so it is an option.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

import upath from 'upath';

import { locateVivliostyleConfig } from '../config/load.js';
import type { ResolvedTaskConfig } from '../config/resolve.js';
import type {
  ParsedBuildTask,
  ParsedVivliostyleInlineConfig,
} from '../config/schema.js';
import { Logger } from '../logger.js';
import { cliVersion } from '../util.js';

const FORMAT_VERSION = 1;
const DEFAULT_MAX_SIZE = 512 * 1024 * 1024;
/** The files of the config side are not looked for any more when there are more than these. */
const MAX_FILES = 5000;
const MAX_VISITED = 50_000;
const MAX_BYTES = 20 * 1024 * 1024;
const CODE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.json',
]);
const LOCK_FILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
];

export interface CompileCacheSettings {
  /** Paths of the sources (relative to the entry context) that are not cached. */
  exclude: string[];
  /** The size of the cache, in bytes; the oldest files are removed when the cache is bigger. */
  maxSize: number;
}

/** Reads `512MB`, `1.5 GB`, or a number of bytes. */
export function parseSize(size?: number | string): number {
  if (typeof size === 'number' && Number.isFinite(size) && size >= 0) {
    return size;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/iv.exec(String(size ?? ''));
  if (!match) {
    return DEFAULT_MAX_SIZE;
  }
  const units: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
  };
  const unit = units[(match[2] ?? 'b').toLowerCase()];
  return Math.round(Number(match[1]) * unit);
}

function findLockFile(configDir: string): string | undefined {
  let dir = upath.resolve(configDir);
  for (let i = 0; i < 4; i++) {
    for (const name of LOCK_FILES) {
      if (fs.existsSync(upath.join(dir, name))) {
        return upath.join(dir, name);
      }
    }
    const parent = upath.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * A hash of the code of the config: the scripts and the JSON files in the directory of the config file, and the lock
 * file of the project. Returns nothing if there are too many files to look at.
 */
export function hashConfigSide({
  configDir,
  ignoredDirs = [],
}: {
  configDir: string;
  /** Directories that are not looked at (the workspace and the outputs), as absolute paths */
  ignoredDirs?: string[];
}): string | undefined {
  const hash = createHash('sha256');
  const ignored = new Set(ignoredDirs.map((dir) => upath.resolve(dir)));
  const files: string[] = [];
  let visited = 0;
  let bytes = 0;
  const addFile = (path: string): boolean => {
    bytes += fs.statSync(path).size;
    if (bytes > MAX_BYTES) {
      return false;
    }
    files.push(path);
    return true;
  };

  const walk = (dir: string): boolean => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++visited > MAX_VISITED) {
        return false;
      }
      const path = upath.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (
          dirent.name === 'node_modules' ||
          dirent.name.startsWith('.') ||
          ignored.has(path)
        ) {
          continue;
        }
        if (!walk(path)) {
          return false;
        }
      } else if (
        dirent.isFile() &&
        CODE_EXTENSIONS.has(upath.extname(dirent.name).toLowerCase()) &&
        (files.length >= MAX_FILES || !addFile(path))
      ) {
        return false;
      }
    }
    return true;
  };

  try {
    if (!walk(configDir)) {
      return undefined;
    }
    // The lock file of the project, which is in the directory of the config or in one of its parents
    const lock = findLockFile(configDir);
    if (lock && !addFile(lock)) {
      return undefined;
    }
    for (const path of files.toSorted()) {
      hash.update(upath.relative(configDir, path));
      hash.update('\0');
      hash.update(fs.readFileSync(path));
      hash.update('\0');
    }
  } catch (error) {
    Logger.debug(
      'compile cache > could not read the files of the config',
      error,
    );
    return undefined;
  }
  return hash.digest('hex');
}

/** The directory of the cache: the cache directory of the project if it has node_modules, or of the OS. */
export function compileCacheDir(entryContextDir: string): string {
  const modulesDir = upath.join(entryContextDir, 'node_modules');
  if (fs.existsSync(modulesDir)) {
    return upath.join(modulesDir, '.cache/vivliostyle-cli/compile');
  }
  const project = createHash('sha256')
    .update(upath.resolve(entryContextDir))
    .digest('hex')
    .slice(0, 16);
  return upath.join(
    process.env.XDG_CACHE_HOME ?? upath.join(os.homedir(), '.cache'),
    'vivliostyle-cli',
    project,
    'compile',
  );
}

export interface CompileKeyInput {
  /** The bytes of the source */
  source: Uint8Array;
  /** Everything else that the compile of the document depends on, as JSON-serializable values */
  options: unknown;
}

export class CompileCache {
  readonly dir: string;
  private readonly environment: string;
  private readonly settings: CompileCacheSettings;
  private readonly entryContextDir: string;
  hits = 0;
  misses = 0;

  constructor({
    dir,
    environment,
    entryContextDir,
    settings,
  }: {
    dir: string;
    /** The hash of the code of the config */
    environment: string;
    entryContextDir: string;
    settings: CompileCacheSettings;
  }) {
    this.dir = dir;
    this.environment = environment;
    this.entryContextDir = entryContextDir;
    this.settings = settings;
  }

  /** Whether the document with the source file is cached. */
  isExcluded(sourcePath: string): boolean {
    const relative = upath.relative(this.entryContextDir, sourcePath);
    return this.settings.exclude.some(
      (pattern) =>
        relative === pattern ||
        upath.basename(relative) === pattern ||
        relative.startsWith(`${pattern.replace(/\/$/v, '')}/`),
    );
  }

  key({ source, options }: CompileKeyInput): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          FORMAT_VERSION,
          cliVersion,
          process.versions.node.split('.')[0],
          this.environment,
          options,
        ]),
      )
      .update('\0')
      .update(source)
      .digest('hex');
  }

  private path(key: string): string {
    return upath.join(this.dir, `${key}.html`);
  }

  get(key: string): string | undefined {
    const path = this.path(key);
    try {
      const html = fs.readFileSync(path, 'utf8');
      const now = new Date();
      fs.utimesSync(path, now, now);
      this.hits++;
      return html;
    } catch {
      this.misses++;
      return undefined;
    }
  }

  set(key: string, html: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Written to another file first: documents are compiled by processes at the same time
      const temporary = this.path(`${key}.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(temporary, html);
      fs.renameSync(temporary, this.path(key));
    } catch (error) {
      Logger.debug('compile cache > could not write', error);
    }
  }

  /** Removes the oldest files when the cache is bigger than the limit. */
  prune(): void {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith('.html'))
        .map((name) => {
          const stat = fs.statSync(upath.join(this.dir, name));
          return { name, size: stat.size, time: stat.mtimeMs };
        })
        .toSorted((a, b) => b.time - a.time);
      let total = 0;
      for (const file of files) {
        total += file.size;
        if (total > this.settings.maxSize) {
          fs.rmSync(upath.join(this.dir, file.name), { force: true });
        }
      }
    } catch {
      // nothing to remove
    }
  }
}

/**
 * Makes the cache for the build of the task, if it is turned on by `compileCache`.
 * Returns nothing if it is off, or if the code of the config cannot be known.
 */
export function createCompileCache({
  task,
  config,
  inlineConfig,
}: {
  task: ParsedBuildTask;
  config: ResolvedTaskConfig;
  inlineConfig: Pick<
    ParsedVivliostyleInlineConfig,
    'config' | 'configData' | 'cwd'
  >;
}): CompileCache | undefined {
  const option = task.compileCache;
  if (!option) {
    return undefined;
  }
  const settings: CompileCacheSettings = {
    exclude: option === true ? [] : (option.exclude ?? []),
    maxSize: parseSize(option === true ? undefined : option.maxSize),
  };
  let environment = '';
  if (inlineConfig.configData) {
    Logger.logWarn(
      'The compile cache is not used: the config is not in a file, so the code of it cannot be known.',
    );
    return undefined;
  }
  const configPath = locateVivliostyleConfig(inlineConfig);
  if (configPath) {
    const configDir = upath.dirname(configPath);
    const outputDirs = config.outputs
      .map((output) => upath.dirname(upath.resolve(output.path)))
      .filter((dir) => upath.resolve(dir) !== upath.resolve(configDir));
    const hash = hashConfigSide({
      configDir,
      ignoredDirs: [config.workspaceDir, ...outputDirs],
    });
    if (!hash) {
      Logger.logWarn(
        'The compile cache is not used: there are too many files beside the config file to know the code of it.',
      );
      return undefined;
    }
    environment = hash;
  }
  return new CompileCache({
    dir: compileCacheDir(config.entryContextDir),
    environment,
    entryContextDir: config.entryContextDir,
    settings,
  });
}

let current: CompileCache | undefined;

export function setCompileCache(cache: CompileCache | undefined): void {
  current = cache;
}

export function getCompileCache(): CompileCache | undefined {
  return current;
}

/**
 * Lists the files under the directory, relative to it. It is used to find the files that the compile of a
 * document writes besides the HTML.
 */
export function listFiles(dir: string): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((dirent) => dirent.isFile())
        .map((dirent) => upath.join(dirent.parentPath, dirent.name)),
    );
  } catch {
    return new Set();
  }
}

/**
 * Puts a `<style>` element in the head of the HTML. The page numbers of a part of a parallel build are given so.
 */
export function injectStyle(html: string, css: string): string {
  const style = `<style>${css}</style>`;
  const end = /<\/head\s*>/iv.exec(html);
  if (end) {
    return html.slice(0, end.index) + style + html.slice(end.index);
  }
  const start = /<head(?:\s[^>]*)?>/iv.exec(html);
  if (start) {
    const at = start.index + start[0].length;
    return html.slice(0, at) + style + html.slice(at);
  }
  throw new Error('The document has no head to put a style in.');
}
