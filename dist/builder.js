'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.buildArtifacts = exports.generateToC = exports.generateManifest = exports.cleanup = void 0;
const chalk_1 = __importDefault(require('chalk'));
const fs_1 = __importDefault(require('fs'));
const globby_1 = __importDefault(require('globby'));
const hast_util_to_html_1 = __importDefault(require('hast-util-to-html'));
const hastscript_1 = __importDefault(require('hastscript'));
const image_size_1 = require('image-size');
const jsdom_1 = require('jsdom');
const mime_types_1 = require('mime-types');
const shelljs_1 = __importDefault(require('shelljs'));
const upath_1 = __importDefault(require('upath'));
const config_1 = require('./config');
const markdown_1 = require('./markdown');
const util_1 = require('./util');
function cleanup(location) {
  shelljs_1.default.rm('-rf', location);
}
exports.cleanup = cleanup;
// example: https://github.com/readium/webpub-manifest/blob/master/examples/MobyDick/manifest.json
function generateManifest(outputPath, options) {
  const entries = options.entries.map((entry) => ({
    href: entry.path,
    type: 'text/html',
    title: entry.title,
  }));
  const links = [];
  const resources = [];
  if (options.toc) {
    entries.splice(0, 0, {
      href: 'toc.html',
      rel: 'contents',
      type: 'text/html',
      title: 'Table of Contents',
    });
  }
  if (options.cover) {
    const { width, height, type } = image_size_1.imageSize(options.cover);
    if (type) {
      const mimeType = mime_types_1.lookup(type);
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
  fs_1.default.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
}
exports.generateManifest = generateManifest;
function generateToC(entries, distDir) {
  const items = entries.map((entry) =>
    hastscript_1.default(
      'li',
      hastscript_1.default(
        'a',
        { href: upath_1.default.relative(distDir, entry.target.path) },
        entry.title || upath_1.default.basename(entry.target.path, '.html'),
      ),
    ),
  );
  const toc = hastscript_1.default(
    'html',
    hastscript_1.default(
      'head',
      hastscript_1.default('title', 'Table of Contents'),
      hastscript_1.default('link', {
        href: 'manifest.json',
        rel: 'manifest',
        type: 'application/webpub+json',
      }),
    ),
    hastscript_1.default(
      'body',
      hastscript_1.default(
        'nav#toc',
        { role: 'doc-toc' },
        hastscript_1.default('ul', items),
      ),
    ),
  );
  return hast_util_to_html_1.default(toc);
}
exports.generateToC = generateToC;
async function buildArtifacts({
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
}) {
  var _a, _b;
  if (entries.length === 0) {
    throw new Error(`Missing entry.
Run ${chalk_1.default.green.bold(
      'vivliostyle init',
    )} to create ${chalk_1.default.bold('vivliostyle.config.js')}`);
  }
  util_1.debug('entries', entries);
  util_1.debug('themes', themeIndexes);
  // populate entries
  shelljs_1.default.mkdir('-p', artifactDir);
  for (const entry of entries) {
    shelljs_1.default.mkdir('-p', entry.target.dir);
    // calculate style path
    let style;
    switch (
      (_a = entry === null || entry === void 0 ? void 0 : entry.theme) ===
        null || _a === void 0
        ? void 0
        : _a.type
    ) {
      case 'uri':
        style = entry.theme.location;
        break;
      case 'file':
        style = upath_1.default.relative(
          entry.target.dir,
          upath_1.default.join(distDir, 'themes', entry.theme.name),
        );
        break;
      case 'package':
        style = upath_1.default.relative(
          entry.target.dir,
          upath_1.default.join(
            distDir,
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
      const dom = new jsdom_1.JSDOM(
        fs_1.default.readFileSync(entry.source.path, 'utf8'),
      );
      const {
        window: { document },
      } = dom;
      if (!document) {
        throw new Error('Invalid HTML document: ' + entry.source.path);
      }
      const titleEl = document.querySelector('title');
      if (titleEl && entry.title) {
        titleEl.innerHTML = entry.title;
      }
      const linkEl = document.querySelector('link[rel="stylesheet"');
      if (linkEl && style) {
        linkEl.href = style;
      }
      const html = dom.serialize();
      compiledEntry = html;
    } else {
      // compile markdown
      let replace = undefined;
      if ((_b = entry.theme) === null || _b === void 0 ? void 0 : _b.replace) {
        const replaceFile = upath_1.default.join(
          entry.theme.location,
          entry.theme.replace,
        );
        replace = require(replaceFile);
      }
      const vfile = markdown_1.processMarkdown(entry.source.path, {
        style,
        title: entry.title,
        replace: replace,
      });
      compiledEntry = String(vfile);
    }
    fs_1.default.writeFileSync(entry.target.path, compiledEntry);
  }
  // copy theme
  const themeRoot = upath_1.default.join(distDir, 'themes');
  shelljs_1.default.mkdir('-p', upath_1.default.join(themeRoot, 'packages'));
  for (const theme of themeIndexes) {
    switch (theme.type) {
      case 'file':
        shelljs_1.default.cp(theme.location, themeRoot);
        break;
      case 'package':
        const target = upath_1.default.join(themeRoot, 'packages', theme.name);
        const targetDir = upath_1.default.dirname(target);
        shelljs_1.default.mkdir('-p', targetDir);
        shelljs_1.default.cp('-r', theme.location, target);
    }
  }
  // copy image assets
  const assets = await globby_1.default(entryContextDir, {
    caseSensitiveMatch: false,
    followSymbolicLinks: false,
    gitignore: true,
    expandDirectories: {
      extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif'],
    },
  });
  util_1.debug('images', assets);
  for (const asset of assets) {
    const target = upath_1.default.join(
      artifactDir,
      upath_1.default.relative(entryContextDir, asset),
    );
    shelljs_1.default.mkdir('-p', upath_1.default.dirname(target));
    shelljs_1.default.cp(asset, target);
  }
  // copy cover
  if (cover) {
    const { ext } = upath_1.default.parse(cover);
    shelljs_1.default.cp(cover, upath_1.default.join(distDir, `cover${ext}`));
  }
  // generate manifest
  const manifestPath = upath_1.default.join(distDir, 'manifest.json');
  generateManifest(manifestPath, {
    title: projectTitle,
    author: projectAuthor,
    language,
    toc,
    cover,
    entries: entries.map((entry) => ({
      title: entry.title,
      path: upath_1.default.relative(distDir, entry.target.path),
    })),
    modified: new Date().toISOString(),
  });
  // generate toc
  if (toc) {
    const distTocPath = upath_1.default.join(distDir, 'toc.html');
    if (typeof toc === 'string') {
      shelljs_1.default.cp(
        config_1.contextResolve(entryContextDir, toc),
        distTocPath,
      );
    } else {
      const tocString = generateToC(entries, distDir);
      fs_1.default.writeFileSync(distTocPath, tocString);
    }
  }
  return { manifestPath };
}
exports.buildArtifacts = buildArtifacts;
//# sourceMappingURL=builder.js.map
