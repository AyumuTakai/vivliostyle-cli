import fs from 'node:fs';

import type jsdom from '@vivliostyle/jsdom';
import type { JSDOM } from '@vivliostyle/jsdom';
import { copy, move } from 'fs-extra/esm';
import upath from 'upath';
import serializeToXml from 'w3c-xmlserializer';
import MIMEType from 'whatwg-mimetype';

import {
  type ContentsEntry,
  type CoverEntry,
  type ManuscriptEntry,
  type ParsedEntry,
  parseTheme,
  type ParsedTheme,
  type ResolvedTaskConfig,
  type WebPublicationManifestConfig,
} from '../config/resolve.js';
import type { ArticleEntryConfig } from '../config/schema.js';
import { XML_DECLARATION } from '../constants.js';
import { getPartSpec } from '../core/parallel-spec.js';
import { Logger } from '../logger.js';
import { writePublicationManifest } from '../output/webbook.js';
import {
  DetailError,
  executeWithCleanupOnInterrupt,
  pathContains,
  pathEquals,
  toError,
  writeFileIfChanged,
} from '../util.js';
import { getCompileCache, injectStyle, listFiles } from './compile-cache.js';
import {
  collectCssPackageImports,
  collectLocalCssReferences,
  type PostcssConfig,
  resolvePackageCssEntry,
  resolvePackageCssSubpath,
  resolvePostcssConfig,
} from './css.js';
import {
  createVirtualConsole,
  generateDefaultCoverHtml,
  generateDefaultTocHtml,
  getJsdomFromString,
  getJsdomFromUrlOrFile,
  processCoverHtml,
  processManuscriptHtml,
  processTocHtml,
  ResourceLoader,
} from './html.js';
import { processMarkdown } from './markdown.js';
import {
  checkThemeInstallationNecessity,
  getLocalThemePaths,
  installThemeDependencies,
} from './theme.js';

const isContentsEntry = (entry: ParsedEntry): entry is ContentsEntry =>
  entry.rel === 'contents';
const isCoverEntry = (entry: ParsedEntry): entry is CoverEntry =>
  entry.rel === 'cover';
const isManuscriptEntry = (entry: ParsedEntry): entry is ManuscriptEntry =>
  'source' in entry;

function locateThemePath(theme: ParsedTheme, from: string): string | string[] {
  if (theme.type === 'uri') {
    return theme.location;
  }
  if (theme.type === 'file') {
    return upath.relative(from, theme.location);
  }
  if (theme.importPath) {
    return [theme.importPath].flat().map((locator) => {
      let resolvedPath;
      try {
        resolvedPath = resolvePackageCssSubpath(theme.location, locator);
      } catch (error) {
        throw new Error(
          `Could not find a style path ${locator} for the theme: ${theme.name}.`,
          { cause: error },
        );
      }
      return upath.relative(from, resolvedPath);
    });
  }
  return upath.relative(from, resolvePackageCssEntry(theme.location));
}

export async function cleanupWorkspace({
  entryContextDir,
  workspaceDir,
  themesDir,
  entries,
}: ResolvedTaskConfig): Promise<void> {
  if (
    pathEquals(workspaceDir, entryContextDir) ||
    pathContains(workspaceDir, entryContextDir) ||
    entries.some(
      (entry) =>
        entry.source?.type === 'file' &&
        pathContains(workspaceDir, entry.source.pathname),
    )
  ) {
    return;
  }
  // workspaceDir is placed on different directory; delete everything excepting theme files
  Logger.debug('cleanup workspace files', workspaceDir);
  let movedWorkspacePath: string | undefined;
  await executeWithCleanupOnInterrupt(
    'Waiting for workspace cleanup',
    async () => {
      if (pathContains(workspaceDir, themesDir) && fs.existsSync(themesDir)) {
        movedWorkspacePath = upath.join(
          upath.dirname(workspaceDir),
          `.vs-${Date.now()}`,
        );
        const movedThemePath = upath.join(
          movedWorkspacePath,
          upath.relative(workspaceDir, themesDir),
        );
        fs.mkdirSync(upath.dirname(movedThemePath), { recursive: true });
        await move(themesDir, movedThemePath);
      }
      await fs.promises.rm(workspaceDir, { recursive: true, force: true });
      if (movedWorkspacePath) {
        await move(movedWorkspacePath, workspaceDir);
      }
    },
    () => {
      if (movedWorkspacePath && fs.existsSync(movedWorkspacePath)) {
        fs.rmSync(movedWorkspacePath, { recursive: true, force: true });
      }
    },
  );
}

export async function prepareThemeDirectory(
  config: ResolvedTaskConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  const { themesDir, themeIndexes, workspaceDir } = config;
  // Backward compatibility: v8 to v9
  if (
    fs.existsSync(upath.join(themesDir, 'packages')) &&
    !fs.existsSync(upath.join(themesDir, 'node_modules'))
  ) {
    fs.renameSync(
      upath.join(themesDir, 'packages'),
      upath.join(themesDir, 'node_modules'),
    );
  }

  // Themes may import other theme packages from their CSS files, which also
  // need to be installed
  let postcssConfig: PostcssConfig | undefined;
  try {
    postcssConfig = await resolvePostcssConfig(config);
  } catch (error) {
    // A broken PostCSS config is reported by the scan after the installation
    Logger.debug('compile > skipped loading the PostCSS config %o', error);
  }
  const cssImports = await collectCssPackageImports({
    themeIndexes,
    postcssConfig,
  });
  const installTargets = new Set(themeIndexes);
  for (const specifier of cssImports.values()) {
    try {
      const theme = parseTheme({
        theme: { specifier, import: [] },
        context: workspaceDir,
        workspaceDir,
        themesDir,
      });
      if (theme.type === 'package') {
        installTargets.add(theme);
      }
    } catch (error) {
      Logger.logWarn(
        `Skipped the installation of the imported theme package: ${specifier}\n${toError(error).message}`,
      );
    }
  }

  // install theme packages
  if (
    await checkThemeInstallationNecessity({
      themesDir,
      themeIndexes: installTargets,
    })
  ) {
    using _ = Logger.startLogging('Installing theme files');
    await installThemeDependencies({
      themesDir,
      themeIndexes: installTargets,
      signal,
    });
  }

  // copy theme files, and the files they refer to with relative URLs (the
  // stylesheets they import, images and fonts)
  for (const theme of themeIndexes) {
    if (theme.type === 'file' && !pathEquals(theme.source, theme.location)) {
      fs.mkdirSync(upath.dirname(theme.location), { recursive: true });
      await copy(theme.source, theme.location);
      await copyThemeReferences(theme.source, theme.location, workspaceDir);
    }
  }

  // Return all local theme paths (symlink targets in node_modules)
  return getLocalThemePaths({ themesDir });
}

/**
 * Copies the files that a theme file refers to with relative URLs, keeping
 * their places relative to the theme file. Files that would be put out of the
 * workspace are not copied.
 */
async function copyThemeReferences(
  source: string,
  location: string,
  workspaceDir: string,
): Promise<void> {
  for (const file of collectLocalCssReferences(source)) {
    const target = upath.resolve(
      upath.dirname(location),
      upath.relative(upath.dirname(source), file),
    );
    if (!pathContains(workspaceDir, target)) {
      Logger.logWarn(
        `The file that the theme ${source} refers to is not copied, as it is out of the directory of the project: ${file}`,
      );
      continue;
    }
    if (!pathEquals(file, target)) {
      fs.mkdirSync(upath.dirname(target), { recursive: true });
      await copy(file, target);
    }
  }
}

export async function transformManuscript(
  entry: ParsedEntry,
  {
    entryContextDir,
    workspaceDir,
    viewerInput: { manifestPath },
    title,
    entries,
    language,
    vfmOptions,
    rootUrl,
  }: ResolvedTaskConfig & { viewerInput: WebPublicationManifestConfig },
): Promise<string | undefined> {
  const source =
    isContentsEntry(entry) || isCoverEntry(entry)
      ? entry.template
      : entry.source;
  // In a parallel build, take the output of a build that has compiled this entry already.
  const precompiledDirs = getPartSpec()?.precompiledDirs;
  if (precompiledDirs && isManuscriptEntry(entry)) {
    const relativeTarget = upath.relative(workspaceDir, entry.target);
    for (const dir of precompiledDirs) {
      const precompiled = upath.join(dir, relativeTarget);
      if (fs.existsSync(precompiled)) {
        fs.mkdirSync(upath.dirname(entry.target), { recursive: true });
        fs.copyFileSync(precompiled, entry.target);
        return;
      }
    }
  }
  let content: JSDOM | undefined;
  let resourceLoader: ResourceLoader | undefined;
  let resourceUrl: string | undefined;

  // calculate style path
  const style = entry.themes.flatMap((theme) =>
    locateThemePath(theme, upath.dirname(entry.target)),
  );

  if (source?.type === 'file') {
    if (source.documentProcessor) {
      // Process with a configured document processor
      const vfile = await processMarkdown(
        source.documentProcessor.processorFactory,
        source.documentProcessor.metadataReader,
        source.pathname,
        {
          ...vfmOptions,
          style,
          title: entry.title,
          language: language ?? undefined,
        },
      );
      content = getJsdomFromString({ html: String(vfile) });
    } else if (
      source.contentType === 'text/html' ||
      source.contentType === 'application/xhtml+xml'
    ) {
      content = await getJsdomFromUrlOrFile({ src: source.pathname });
      content = await processManuscriptHtml(content, {
        style,
        title: entry.title,
        contentType: source.contentType,
        language,
      });
    } else {
      if (!pathEquals(source.pathname, entry.target)) {
        await copy(source.pathname, entry.target);
      }
    }
  } else if (source?.type === 'uri') {
    resourceUrl = /^https?:/v.test(source.href)
      ? source.href
      : `${rootUrl}${source.href}`;
    resourceLoader = new ResourceLoader();
    try {
      await getJsdomFromUrlOrFile({
        src: resourceUrl,
        resourceLoader,
        virtualConsole: createVirtualConsole((error) => {
          Logger.logError(`Failed to fetch resources: ${error.detail}`);
        }),
      });
    } catch (error) {
      const thrownError = toError(error);
      throw new DetailError(
        `Failed to fetch the content from ${resourceUrl}`,
        thrownError.stack ?? thrownError.message,
      );
    }

    const contentFetcher = resourceLoader.fetcherMap.get(resourceUrl);
    if (contentFetcher) {
      const buffer = await contentFetcher;
      const contentType = contentFetcher.response?.headers['content-type'];
      if (!contentType || new MIMEType(contentType).essence !== 'text/html') {
        throw new Error(`The content is not an HTML document: ${resourceUrl}`);
      }
      content = getJsdomFromString({ html: buffer.toString('utf8') });
      content = await processManuscriptHtml(content, {
        style,
        title: entry.title,
        contentType: 'text/html',
        language,
      });
    }
  } else if (entry.rel === 'contents') {
    content = getJsdomFromString({
      html: generateDefaultTocHtml({
        language,
        title,
      }),
    });
    content = await processManuscriptHtml(content, {
      style,
      title,
      contentType: 'text/html',
      language,
    });
  } else if (entry.rel === 'cover') {
    content = getJsdomFromString({
      html: generateDefaultCoverHtml({ language, title: entry.title }),
    });
    content = await processManuscriptHtml(content, {
      style,
      title: entry.title,
      contentType: 'text/html',
      language,
    });
  }

  if (!content) {
    return;
  }

  if (isContentsEntry(entry)) {
    const contentsEntry = entry;
    // oxlint-disable-next-line unicorn/no-array-callback-reference -- pass the type guard directly to narrow the filtered array
    const manuscriptEntries = entries.filter(isManuscriptEntry);
    content = await processTocHtml(content, {
      entries: manuscriptEntries,
      manifestPath,
      distDir: upath.dirname(contentsEntry.target),
      tocTitle: contentsEntry.tocTitle,
      compose: contentsEntry.compose,
      sectionDepth: contentsEntry.sectionDepth,
      styleOptions: contentsEntry,
      transform: contentsEntry.transform,
    });
  }

  if (isCoverEntry(entry)) {
    const coverEntry = entry;
    content = await processCoverHtml(content, {
      imageSrc: upath.relative(
        upath.join(
          entryContextDir,
          upath.relative(workspaceDir, coverEntry.target),
          '..',
        ),
        coverEntry.coverImageSrc,
      ),
      imageAlt: coverEntry.coverImageAlt,
      styleOptions: coverEntry,
    });
  }

  let html;
  if (content.window.document.contentType === 'application/xhtml+xml') {
    html = `${XML_DECLARATION}\n${serializeToXml(content.window.document)}`;
  } else {
    html = content.serialize();
  }
  const htmlBuffer = Buffer.from(html, 'utf8');
  if (
    !source ||
    (source.type === 'file' && !pathEquals(source.pathname, entry.target))
  ) {
    writeFileIfChanged(entry.target, htmlBuffer);
  }

  if (source?.type === 'uri' && resourceLoader && resourceUrl) {
    const fetcher = resourceLoader.fetcherMap.get(resourceUrl);
    /* v8 ignore next 3 */
    if (!fetcher) {
      throw new Error(`Failed to locate the fetched content: ${resourceUrl}`);
    }
    const { response } = fetcher;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- jsdom's AbortablePromise is a Promise augmented with abort()/response, assembled below
    const contentFetcher = Promise.resolve(
      htmlBuffer,
    ) as jsdom.AbortablePromise<Buffer>;
    contentFetcher.abort = () => {};
    contentFetcher.response = response;
    resourceLoader.fetcherMap.set(resourceUrl, contentFetcher);

    await ResourceLoader.saveFetchedResources({
      fetcherMap: resourceLoader.fetcherMap,
      rootUrl: resourceUrl,
      outputDir: source.rootDir,
    });
  }

  return html;
}

/**
 * Compiles the entry, using the compile cache if it is on, and puts the styles that the parallel build gives
 * (the page numbers of the part) in the compiled document.
 */
async function transformManuscriptWithCache(
  entry: ParsedEntry,
  config: ResolvedTaskConfig & { viewerInput: WebPublicationManifestConfig },
): Promise<string | undefined> {
  const { workspaceDir, entryContextDir, language, vfmOptions } = config;
  const source = isManuscriptEntry(entry) ? entry.source : undefined;
  const cache = getCompileCache();
  const spec = getPartSpec();
  const cacheable =
    cache !== undefined &&
    source?.type === 'file' &&
    !spec?.precompiledDirs &&
    (source.documentProcessor !== undefined ||
      source.contentType === 'text/html' ||
      source.contentType === 'application/xhtml+xml') &&
    !pathEquals(source.pathname, entry.target) &&
    !cache.isExcluded(source.pathname);

  const css =
    source?.type === 'file'
      ? spec?.inlineStyles?.find((style) =>
          pathEquals(
            source.pathname,
            upath.resolve(entryContextDir, style.path),
          ),
        )?.css
      : undefined;
  const write = (html: string): string => {
    if (css === undefined) {
      return html;
    }
    const styled = injectStyle(html, css);
    writeFileIfChanged(entry.target, Buffer.from(styled, 'utf8'));
    return styled;
  };

  if (!cacheable || !source || source.type !== 'file') {
    const html = await transformManuscript(entry, config);
    return html === undefined ? html : write(html);
  }

  const key = cache.key({
    source: fs.readFileSync(source.pathname),
    options: {
      processor: source.documentProcessor ? 'document-processor' : 'html',
      contentType: source.contentType,
      target: upath.relative(workspaceDir, entry.target),
      style: entry.themes.flatMap((theme) =>
        locateThemePath(theme, upath.dirname(entry.target)),
      ),
      title: entry.title,
      language,
      vfmOptions,
      rel: entry.rel,
    },
  });
  const cached = cache.get(key);
  if (cached !== undefined) {
    Logger.debug('compile cache > hit', source.pathname);
    fs.mkdirSync(upath.dirname(entry.target), { recursive: true });
    writeFileIfChanged(entry.target, Buffer.from(cached, 'utf8'));
    return write(cached);
  }

  Logger.debug('compile cache > miss', source.pathname);
  const before = listFiles(workspaceDir);
  const html = await transformManuscript(entry, config);
  if (html === undefined) {
    return html;
  }
  // A plugin may write other files; they would be missing when the HTML is taken from the cache
  const written = [...listFiles(workspaceDir)].filter(
    (path) => !before.has(path) && !pathEquals(path, entry.target),
  );
  if (written.length > 0) {
    Logger.debug(
      'compile cache > not kept, because other files were written',
      written,
    );
  } else {
    cache.set(key, html);
  }
  return write(html);
}

export function generateManifest({
  entryContextDir,
  workspaceDir,
  viewerInput: { manifestPath },
  title,
  author,
  entries,
  language,
  readingProgression,
  cover,
}: ResolvedTaskConfig & { viewerInput: WebPublicationManifestConfig }): void {
  const manifestEntries: ArticleEntryConfig[] = entries.map((entry) => ({
    title: (isContentsEntry(entry) && entry.tocTitle) || entry.title,
    path: upath.relative(workspaceDir, entry.target),
    encodingFormat:
      !('contentType' in entry) ||
      entry.contentType === 'text/markdown' ||
      entry.contentType === 'text/x-vivliostyle-custom' ||
      entry.contentType === 'text/html'
        ? undefined
        : entry.contentType,
    rel: entry.rel,
  }));
  writePublicationManifest(manifestPath, {
    title,
    author,
    language,
    readingProgression,
    cover: cover && {
      url: upath.relative(entryContextDir, cover.src),
      name: cover.name,
    },
    entries: manifestEntries,
    modified: new Date().toISOString(),
  });
}

export async function compile(
  config: ResolvedTaskConfig & { viewerInput: WebPublicationManifestConfig },
): Promise<void> {
  const tocEntries: ParsedEntry[] = [];
  for (const entry of config.entries) {
    if (entry.rel === 'contents') {
      // To transpile the table of contents, all dependent entries must be transpiled in advance
      tocEntries.push(entry);
      continue;
    }
    await transformManuscriptWithCache(entry, config);
  }
  for (const entry of tocEntries) {
    await transformManuscriptWithCache(entry, config);
  }
  const cache = getCompileCache();
  if (cache) {
    Logger.debug(`compile cache > ${cache.hits} hits, ${cache.misses} misses`);
    cache.prune();
  }

  // generate manifest
  if (config.viewerInput.needToGenerateManifest) {
    generateManifest(config);
  }
}
