import { ReplaceRule } from '@vivliostyle/vfm/lib/plugins/replace';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import chalk from 'chalk';
import fs from 'fs';
import globby from 'globby';
import { imageSize } from 'image-size';
import { lookup as mime } from 'mime-types';
import shelljs from 'shelljs';
import path from 'upath';
import {
  ManuscriptEntry,
  MergedConfig,
  WebPublicationManifestConfig,
} from './config';
import { TOC_TITLE } from './const';
import { generateTocHtml, isTocHtml, processManuscriptHtml } from './html';
import { processMarkdown } from './markdown';
import type {
  PublicationLinks,
  PublicationManifest,
} from './schema/pubManifest';
import {
  publicationSchemaId,
  publicationSchemas,
} from './schema/pubManifest.schema';
import type { EntryObject } from './schema/vivliostyle.config';
import { ParsedTheme, ThemeManager } from './theme';
import { debug, log } from './util';

export function cleanup(location: string) {
  debug('cleanup file', location);
  shelljs.rm('-rf', location);
}

// https://www.w3.org/TR/pub-manifest/
export function generateManifest(
  outputPath: string,
  entryContextDir: string,
  options: {
    title?: string;
    author?: string;
    language?: string | null;
    modified: string;
    entries: EntryObject[];
    cover?: string;
  },
) {
  const entries: PublicationLinks[] = options.entries.map((entry) => ({
    url: entry.path,
    title: entry.title,
    ...(entry.encodingFormat && { encodingFormat: entry.encodingFormat }),
    ...(entry.rel && { rel: entry.rel }),
    ...(entry.rel === 'contents' && { type: 'LinkedResource' }),
  }));
  const links: PublicationLinks[] = [];
  const resources: PublicationLinks[] = [];

  if (options.cover) {
    const { width, height, type } = imageSize(
      path.resolve(entryContextDir, options.cover),
    );
    let mimeType: string | false = false;
    if (type) {
      mimeType = mime(type);
      if (mimeType) {
        links.push({
          rel: 'cover',
          url: options.cover,
          encodingFormat: mimeType,
          width,
          height,
        });
      }
    }
    if (!type || !mimeType) {
      log(
        `\n${chalk.yellow('Cover image ')}${chalk.bold.yellow(
          `"${options.cover}"`,
        )}${chalk.yellow(
          ' was set in your configuration but couldn’t detect the image metadata. Please check a valid cover file is placed.',
        )}`,
      );
    }
  }

  const publication: PublicationManifest = {
    '@context': ['https://schema.org', 'https://www.w3.org/ns/pub-context'],
    type: 'Book',
    conformsTo: 'https://github.com/vivliostyle/vivliostyle-cli',
    author: options.author,
    ...(options.language && { inLanguage: options.language }),
    dateModified: options.modified,
    name: options.title,
    readingOrder: entries,
    resources,
    links,
  };

  fs.writeFileSync(outputPath, JSON.stringify(publication, null, 2));
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  ajv.addSchema(publicationSchemas);
  const valid = ajv.validate(publicationSchemaId, publication);
  if (!valid) {
    throw new Error(
      `Validation of pubManifest failed. Please check the schema: ${outputPath}`,
    );
  }
}

function clearReplaceCache(entries: ManuscriptEntry[]) {
  for (const entry of entries) {
    if (!entry.theme || entry.theme.length == 0) continue;
    for (const theme of entry.theme) {
      if (theme.replace) {
        const replaceFile = path.join(theme.location, theme.replace);
        delete require.cache[replaceFile];
      }
    }
  }
}

function importReplaceRules(entry: ManuscriptEntry): ReplaceRule[] | undefined {
  if (!entry.theme || entry.theme.length == 0) return;
  let replaceRules: ReplaceRule[] | undefined = undefined;
  for (const theme of entry.theme) {
    if (theme.replace) {
      const replaceFile = path.join(theme.location, theme.replace);
      if (fs.existsSync(replaceFile)) {
        const replaces: ReplaceRule[] | undefined = require(replaceFile)
          .replaces as ReplaceRule[] | undefined;
        if (replaces && replaces.length > 0) {
          if (!replaceRules) {
            replaceRules = [];
          }
          replaceRules = replaceRules?.concat(replaces);
        }
      }
    }
  }
  return replaceRules;
}

export async function compile(
  {
    entryContextDir,
    workspaceDir,
    manifestPath,
    manifestAutoGenerate,
    themeIndexes,
    entries,
    language,
    cover,
    input,
  }: MergedConfig & WebPublicationManifestConfig,
  { reload = false }: { reload?: boolean } = {},
): Promise<void> {
  debug('entries', entries);
  debug('themes', themeIndexes);

  if (
    !reload &&
    path.relative(workspaceDir, entryContextDir).startsWith('..')
  ) {
    // workspaceDir is placed on different directory
    cleanup(workspaceDir);
  }

  const locateThemePath = (
    from: string,
    theme?: ParsedTheme[],
  ): string[] | undefined => {
    if (!theme) return;
    return theme?.map((t) => t.locateThemePath(from));
  };

  const generativeContentsEntry = entries.find(
    (e) => !('source' in e) && e.rel === 'contents',
  );
  if (
    generativeContentsEntry &&
    fs.existsSync(generativeContentsEntry.target) &&
    !isTocHtml(generativeContentsEntry.target)
  ) {
    throw new Error(
      `${generativeContentsEntry.target} is set as a destination to create a ToC HTML file, but there is already a document other than the ToC file in this location. Please move this file, or set a 'toc' option in vivliostyle.config.js to specify another destination for the ToC file.`,
    );
  }

  const contentEntries = entries.filter(
    (e): e is ManuscriptEntry => 'source' in e,
  );

  // clear cache if replace.js
  clearReplaceCache(contentEntries);

  for (const entry of contentEntries) {
    shelljs.mkdir('-p', path.dirname(entry.target));

    // copy theme
    const themeManager = themeIndexes as ThemeManager;
    themeManager.copyThemes();

    // calculate style path
    const style = locateThemePath(path.dirname(entry.target), entry.theme);
    if (entry.type === 'text/markdown') {
      const replaceRules = importReplaceRules(entry);
      // compile markdown
      const vfile = processMarkdown(entry.source, {
        style,
        title: entry.title,
        language: language ?? undefined,
        replace: replaceRules,
      });
      const compiledEntry = String(vfile);
      fs.writeFileSync(entry.target, compiledEntry);
    } else if (
      entry.type === 'text/html' ||
      entry.type === 'application/xhtml+xml'
    ) {
      if (entry.source !== entry.target) {
        const html = processManuscriptHtml(entry.source, {
          style,
          title: entry.title,
          contentType: entry.type,
          language,
        });
        fs.writeFileSync(entry.target, html);
      }
    } else {
      if (entry.source !== entry.target) {
        shelljs.cp(entry.source, entry.target);
      }
    }
  }

  // copy theme
  (themeIndexes as ThemeManager).copyThemes();

  // generate toc
  if (generativeContentsEntry) {
    const style = locateThemePath(workspaceDir, generativeContentsEntry.theme);
    const tocString = generateTocHtml({
      entries: contentEntries,
      manifestPath,
      distDir: path.dirname(generativeContentsEntry.target),
      title: manifestAutoGenerate?.title,
      tocTitle: generativeContentsEntry.title ?? TOC_TITLE,
      style,
    });
    fs.writeFileSync(generativeContentsEntry.target, tocString);
  }

  // generate manifest
  if (manifestAutoGenerate) {
    generateManifest(manifestPath, entryContextDir, {
      ...manifestAutoGenerate,
      language,
      cover: cover && path.relative(entryContextDir, cover),
      entries: entries.map((entry) => ({
        title: entry.title,
        path: path.relative(workspaceDir, entry.target),
        encodingFormat:
          !('type' in entry) ||
          entry.type === 'text/markdown' ||
          entry.type === 'text/html'
            ? undefined
            : entry.type,
        rel: entry.rel,
      })),
      modified: new Date().toISOString(),
    });
  }
}

export async function copyAssets({
  entryContextDir,
  workspaceDir,
  includeAssets,
}: MergedConfig): Promise<void> {
  if (entryContextDir === workspaceDir) {
    return;
  }
  const relWorkspaceDir = path.relative(entryContextDir, workspaceDir);
  const assets = await globby(includeAssets, {
    cwd: entryContextDir,
    ignore: relWorkspaceDir ? [path.join(relWorkspaceDir, '**/*')] : undefined,
    caseSensitiveMatch: false,
    followSymbolicLinks: false,
    gitignore: true,
  });
  debug('assets', assets);
  for (const asset of assets) {
    const target = path.join(workspaceDir, asset);
    shelljs.mkdir('-p', path.dirname(target));
    shelljs.cp(path.resolve(entryContextDir, asset), target);
  }
}

export function checkOverwriteViolation(
  { entryContextDir, workspaceDir }: MergedConfig,
  target: string,
  fileInformation: string,
) {
  if (!path.relative(target, entryContextDir).startsWith('..')) {
    throw new Error(
      `${target} is set as output destination of ${fileInformation}, however, this output path will overwrite the manuscript file(s). Please specify other paths.`,
    );
  }
  if (!path.relative(target, workspaceDir).startsWith('..')) {
    throw new Error(
      `${target} is set as output destination of ${fileInformation}, however, this output path will overwrite the working directory of Vivliostyle. Please specify other paths.`,
    );
  }
}
