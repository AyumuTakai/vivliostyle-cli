import { ReplaceRule } from '@vivliostyle/vfm/lib/plugins/replace';
import chalk from 'chalk';
import fs from 'fs';
import globby from 'globby';
import toHTML from 'hast-util-to-html';
import h from 'hastscript';
import { imageSize } from 'image-size';
import { JSDOM } from 'jsdom';
import { lookup as mime } from 'mime-types';
import shelljs from 'shelljs';
import path from 'upath';
import { contextResolve, Entry, MergedConfig, ParsedEntry } from './config';
import { processMarkdown } from './markdown';
import { debug } from './util';
const sass = require('sass');

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

export function cleanup(location: string) {
  shelljs.rm('-rf', location);
}

// example: https://github.com/readium/webpub-manifest/blob/master/examples/MobyDick/manifest.json
export function generateManifest(outputPath: string, options: ManifestOption) {
  const entries: ManifestEntry[] = options.entries.map((entry) => ({
    href: entry.path,
    type: 'text/html',
    title: entry.title,
  }));
  const links: ManifestEntry[] = [];
  const resources: ManifestEntry[] = [];

  if (options.toc) {
    entries.splice(0, 0, {
      href: 'toc.html',
      rel: 'contents',
      type: 'text/html',
      title: 'Table of Contents',
    });
  }

  if (options.cover && !options.cover.endsWith('.pdf')) {
    const { width, height, type } = imageSize(options.cover);
    if (type) {
      const mimeType = mime(type);
      if (mimeType) {
        const coverPath = `cover.${type}`;
        links.push({
          rel: 'cover',
          href: coverPath,
          type: mimeType,
          width,
          height,
        });
      }
    }
  }

  const manifest = {
    '@context': 'https://readium.org/webpub-manifest/context.jsonld',
    metadata: {
      '@type': 'http://schema.org/Book',
      title: options.title,
      author: options.author,
      language: options.language,
      modified: options.modified,
    },
    links,
    readingOrder: entries,
    resources,
  };

  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
}

export function generateToC(entries: ParsedEntry[], distDir: string) {
  const items = entries.map((entry) =>
    h(
      'li',
      h(
        'a',
        { href: path.relative(distDir, entry.target) },
        entry.title || path.basename(entry.target, '.html'),
      ),
    ),
  );
  const toc = h(
    'html',
    h(
      'head',
      h('title', 'Table of Contents'),
      h('link', {
        href: 'manifest.json',
        rel: 'manifest',
        type: 'application/webpub+json',
      }),
    ),
    h('body', h('nav#toc', { role: 'doc-toc' }, h('ul', items))),
  );
  return toHTML(toc);
}

/**
 * sass(scss)をトランスパイルする
 * 生成したCSSの場所によってurl()の指定がずれてしまう
 * @param src 元ファイル
 * @param dst 保存先ファイル名
 * @param vars 上書きする変数
 */
export function transpileSass(src: string, dst: string, vars: any = null) {
  // 変数を上書きするために "with ( $name1:value1,$name2:value2, ... )"という文字列を作る
  let with_vars: string = '';
  if (vars && Object.keys(vars).length > 0) {
    with_vars = ' with (';
    for (let key in vars) {
      with_vars += `$${key}:${vars[key]},`;
    }
    with_vars = with_vars.slice(0, -1) + ')'; // 最後の,を取り除く
  }

  const result = sass.renderSync({
    // file: src,
    data: `@use '${src}' ${with_vars};`,
    outputStyle: 'expanded',
    outFile: dst,
  });
  fs.writeFileSync(dst, result.css);
}

function clearReplaceCache(entries: ParsedEntry[]) {
  for (const entry of entries) {
    if (entry.theme?.replace) {
      const replaceFile = path.join(entry.theme.location, entry.theme.replace);
      delete require.cache[replaceFile];
    }
  }
}

function importReplaceRules(entry: ParsedEntry): ReplaceRule[] | undefined {
  let replaceRules: ReplaceRule[] | undefined = undefined;
  if (entry.theme?.replace) {
    const replaceFile = path.join(entry.theme.location, entry.theme.replace);
    if (fs.existsSync(replaceFile)) {
      replaceRules = require(replaceFile).replaces;
    }
  }
  return replaceRules;
}

export async function buildArtifacts({
  entryContextDir,
  workspaceDir,
  artifactDir,
  projectTitle,
  themeIndexes,
  entries,
  projectAuthor,
  language,
  toc,
  cover,
}: MergedConfig) {
  if (entries.length === 0) {
    throw new Error(
      `Missing entry.
Run ${chalk.green.bold('vivliostyle init')} to create ${chalk.bold(
        'vivliostyle.config.js',
      )}`,
    );
  }

  debug('entries', entries);
  debug('themes', themeIndexes);

  // clear cache if replace.js
  clearReplaceCache(entries);
  // populate entries
  shelljs.mkdir('-p', artifactDir);
  for (const entry of entries) {
    shelljs.mkdir('-p', path.dirname(entry.target));

    // calculate style path
    let style;
    switch (entry?.theme?.type) {
      case 'uri':
        style = entry.theme.location;
        break;
      case 'file':
        style = path.relative(
          path.dirname(entry.target),
          path.join(workspaceDir, 'themes', entry.theme.name),
        );
        break;
      case 'package':
        style = path.relative(
          path.dirname(entry.target),
          path.join(
            workspaceDir,
            'themes',
            'packages',
            entry.theme.name,
            entry.theme.style,
          ),
        );
    }

    let compiledEntry;
    if (entry.type === 'html') {
      // compile html
      const dom = new JSDOM(fs.readFileSync(entry.source, 'utf8'));
      const {
        window: { document },
      } = dom;
      if (!document) {
        throw new Error('Invalid HTML document: ' + entry.source);
      }

      const titleEl = document.querySelector('title');
      if (titleEl && entry.title) {
        titleEl.innerHTML = entry.title;
      }

      const linkEl = document.querySelector<HTMLLinkElement>(
        'link[rel="stylesheet"',
      );
      if (linkEl && style) {
        linkEl.href = style;
      }

      const html = dom.serialize();
      compiledEntry = html;
    } else {
      const replaceRules = importReplaceRules(entry);
      // compile markdown
      const vfile = processMarkdown(entry.source, {
        style,
        title: entry.title,
        replace: replaceRules,
      });
      compiledEntry = String(vfile);
    }

    fs.writeFileSync(entry.target, compiledEntry);
  }

  // copy theme
  const themeRoot = path.join(workspaceDir, 'themes');
  shelljs.mkdir('-p', path.join(themeRoot, 'packages'));
  for (const theme of themeIndexes) {
    switch (theme.type) {
      case 'file':
        if (theme.name.endsWith('.scss')) {
          const src = path.resolve(
            path.join(themeRoot, 'packages'),
            theme.location,
          );
          const dst = path.resolve(themeRoot, theme.name);
          const vars = theme.vars;
          transpileSass(src, dst, vars);
        } else {
          shelljs.cp(theme.location, themeRoot);
        }
        break;
      case 'package':
        const target = path.join(themeRoot, 'packages', theme.name);
        const targetDir = path.dirname(target);
        shelljs.mkdir('-p', target);
        shelljs.cp('-r', path.join(theme.location, '*'), target);
        if (theme.style.endsWith('.scss')) {
          const src = path.join(theme.location, theme.style);
          const dst = path.join(target, theme.style);
          const vars = theme.vars;
          transpileSass(src, dst, vars);
        }
    }
  }

  // copy image assets
  const assets = await globby(entryContextDir, {
    caseSensitiveMatch: false,
    followSymbolicLinks: false,
    gitignore: true,
    expandDirectories: {
      extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif'],
    },
  });
  debug('images', assets);
  for (const asset of assets) {
    const target = path.join(
      artifactDir,
      path.relative(entryContextDir, asset),
    );
    shelljs.mkdir('-p', path.dirname(target));
    shelljs.cp(asset, target);
  }

  // copy cover
  if (cover) {
    const { ext } = path.parse(cover);
    shelljs.cp(cover, path.join(workspaceDir, `cover${ext}`));
  }

  // generate manifest
  const manifestPath = path.join(workspaceDir, 'manifest.json');
  generateManifest(manifestPath, {
    title: projectTitle,
    author: projectAuthor,
    language,
    toc,
    cover,
    entries: entries.map((entry) => ({
      title: entry.title,
      path: path.relative(workspaceDir, entry.target),
    })),
    modified: new Date().toISOString(),
  });

  // generate toc
  if (toc) {
    const distTocPath = path.join(workspaceDir, 'toc.html');
    if (typeof toc === 'string') {
      shelljs.cp(contextResolve(entryContextDir, toc)!, distTocPath);
    } else {
      const tocString = generateToC(entries, workspaceDir);
      fs.writeFileSync(distTocPath, tocString);
    }
  }
  return { manifestPath };
}
