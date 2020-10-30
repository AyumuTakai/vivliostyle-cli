'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.mergeConfig = exports.getVivliostyleConfigPath = exports.collectVivliostyleConfig = exports.parseTheme = exports.contextResolve = exports.validateTimeoutFlag = void 0;
const ajv_1 = __importDefault(require('ajv'));
const fs_1 = __importDefault(require('fs'));
const jsdom_1 = require('jsdom');
const pkg_up_1 = __importDefault(require('pkg-up'));
const process_1 = __importDefault(require('process'));
const puppeteer_1 = __importDefault(require('puppeteer'));
const resolve_pkg_1 = __importDefault(require('resolve-pkg'));
const upath_1 = __importDefault(require('upath'));
const markdown_1 = require('./markdown');
const vivliostyle_config_schema_json_1 = __importDefault(
  require('./schema/vivliostyle.config.schema.json'),
);
const util_1 = require('./util');
const DEFAULT_TIMEOUT = 2 * 60 * 1000; // 2 minutes
function validateTimeoutFlag(val) {
  return Number.isFinite(+val) && +val > 0 ? +val * 1000 : DEFAULT_TIMEOUT;
}
exports.validateTimeoutFlag = validateTimeoutFlag;
function contextResolve(context, loc) {
  return loc && upath_1.default.resolve(context, loc);
}
exports.contextResolve = contextResolve;
function normalizeEntry(e) {
  if (typeof e === 'object') {
    return e;
  }
  return { path: e };
}
// parse theme locator
function parseTheme(locator, contextDir) {
  if (typeof locator !== 'string' || locator == '') {
    return undefined;
  }
  // url
  if (/^https?:\/\//.test(locator)) {
    return {
      type: 'uri',
      name: upath_1.default.basename(locator),
      location: locator,
    };
  }
  const stylePath = upath_1.default.resolve(contextDir, locator);
  // node_modules, local pkg
  const pkgRootDir = resolve_pkg_1.default(locator, { cwd: contextDir });
  if (
    !(pkgRootDir === null || pkgRootDir === void 0
      ? void 0
      : pkgRootDir.endsWith('.css'))
  ) {
    const packageJson = pkgJson(
      pkgRootDir !== null && pkgRootDir !== void 0 ? pkgRootDir : stylePath,
    );
    const style = parseStyleLocator(packageJson, locator);
    const replace = parseReplaceLocator(packageJson);
    if (style) {
      return {
        type: 'package',
        name: style.name,
        location:
          pkgRootDir !== null && pkgRootDir !== void 0 ? pkgRootDir : stylePath,
        style: style.maybeStyle,
        replace,
      };
    }
  }
  // bare .css file
  return {
    type: 'file',
    name: upath_1.default.basename(locator),
    location: stylePath,
  };
}
exports.parseTheme = parseTheme;
function pkgJson(pkgRootDir) {
  if (!pkgRootDir) {
    return undefined;
  }
  const pkgJsonPath = upath_1.default.join(pkgRootDir, 'package.json');
  if (!fs_1.default.existsSync(pkgJsonPath)) {
    return undefined;
  }
  const packageJson = JSON.parse(
    fs_1.default.readFileSync(pkgJsonPath, 'utf8'),
  );
  return packageJson;
}
function parseStyleLocator(packageJson, locator) {
  var _a, _b, _c, _d, _e, _f, _g;
  const maybeStyle =
    (_e =
      (_d =
        (_c =
          (_b =
            (_a =
              packageJson === null || packageJson === void 0
                ? void 0
                : packageJson.vivliostyle) === null || _a === void 0
              ? void 0
              : _a.theme) === null || _b === void 0
            ? void 0
            : _b.style) !== null && _c !== void 0
          ? _c
          : packageJson.style) !== null && _d !== void 0
        ? _d
        : packageJson.main) !== null && _e !== void 0
      ? _e
      : (_g =
          (_f =
            packageJson === null || packageJson === void 0
              ? void 0
              : packageJson.vivliostyle) === null || _f === void 0
            ? void 0
            : _f.theme) === null || _g === void 0
      ? void 0
      : _g.stylesheet; // TODO: remove theme.stylesheet
  if (!maybeStyle) {
    throw new Error(
      `invalid style file: ${maybeStyle} while parsing ${locator}`,
    );
  }
  return { name: packageJson.name, maybeStyle };
}
function parseReplaceLocator(packageJson) {
  var _a, _b, _c;
  const replace =
    (_c =
      (_b =
        (_a =
          packageJson === null || packageJson === void 0
            ? void 0
            : packageJson.vivliostyle) === null || _a === void 0
          ? void 0
          : _a.theme) === null || _b === void 0
        ? void 0
        : _b.replace) !== null && _c !== void 0
      ? _c
      : undefined;
  return replace;
}
function parsePageSize(size) {
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
      format: width !== null && width !== void 0 ? width : 'Letter',
    };
  }
}
function parseFileMetadata(type, sourcePath) {
  var _a, _b;
  const sourceDir = upath_1.default.dirname(sourcePath);
  let title;
  let theme;
  if (type === 'markdown') {
    const file = markdown_1.processMarkdown(sourcePath);
    title = file.data.title;
    theme = parseTheme(file.data.theme, sourceDir);
  } else {
    const {
      window: { document },
    } = new jsdom_1.JSDOM(fs_1.default.readFileSync(sourcePath));
    title =
      (_b =
        (_a = document.querySelector('title')) === null || _a === void 0
          ? void 0
          : _a.textContent) !== null && _b !== void 0
        ? _b
        : undefined;
    const link = document.querySelector('link[rel="stylesheet"]');
    theme = parseTheme(
      link === null || link === void 0 ? void 0 : link.href,
      sourceDir,
    );
  }
  return { title, theme };
}
function collectVivliostyleConfig(configPath) {
  if (!fs_1.default.existsSync(configPath)) {
    return undefined;
  }
  const config = require(configPath);
  const ajv = ajv_1.default();
  const valid = ajv.validate(vivliostyle_config_schema_json_1.default, config);
  if (!valid) {
    throw new Error('Invalid vivliostyle.config.js');
  }
  return config;
}
exports.collectVivliostyleConfig = collectVivliostyleConfig;
function getVivliostyleConfigPath(configPath) {
  const cwd = process_1.default.cwd();
  return configPath
    ? upath_1.default.resolve(cwd, configPath)
    : upath_1.default.join(cwd, 'vivliostyle.config.js');
}
exports.getVivliostyleConfigPath = getVivliostyleConfigPath;
async function mergeConfig(cliFlags, config, context) {
  var _a,
    _b,
    _c,
    _d,
    _e,
    _f,
    _g,
    _h,
    _j,
    _k,
    _l,
    _m,
    _o,
    _p,
    _q,
    _r,
    _s,
    _t,
    _u,
    _v,
    _w;
  const pkgJsonPath = await pkg_up_1.default();
  const pkgJson = pkgJsonPath ? util_1.readJSON(pkgJsonPath) : undefined;
  const projectTitle =
    (_b =
      (_a = cliFlags.title) !== null && _a !== void 0
        ? _a
        : config === null || config === void 0
        ? void 0
        : config.title) !== null && _b !== void 0
      ? _b
      : pkgJson === null || pkgJson === void 0
      ? void 0
      : pkgJson.name;
  if (!projectTitle) {
    throw new Error('title not defined');
  }
  const projectAuthor =
    (_d =
      (_c = cliFlags.author) !== null && _c !== void 0
        ? _c
        : config === null || config === void 0
        ? void 0
        : config.author) !== null && _d !== void 0
      ? _d
      : pkgJson === null || pkgJson === void 0
      ? void 0
      : pkgJson.author;
  util_1.debug('cliFlags', cliFlags);
  util_1.debug('vivliostyle.config.js', config);
  const entryContextDir = upath_1.default.resolve(
    cliFlags.input
      ? '.'
      : (_e = contextResolve(
          context,
          config === null || config === void 0 ? void 0 : config.entryContext,
        )) !== null && _e !== void 0
      ? _e
      : '.',
  );
  const distDir = upath_1.default.resolve(
    (_g =
      (_f =
        cliFlags === null || cliFlags === void 0
          ? void 0
          : cliFlags.distDir) !== null && _f !== void 0
        ? _f
        : contextResolve(
            context,
            config === null || config === void 0 ? void 0 : config.distDir,
          )) !== null && _g !== void 0
      ? _g
      : '.vivliostyle',
  );
  const artifactDir = upath_1.default.join(distDir, 'artifacts');
  const format =
    (_h = config === null || config === void 0 ? void 0 : config.format) !==
      null && _h !== void 0
      ? _h
      : 'pdf';
  const outDir =
    (_j = cliFlags.outDir) !== null && _j !== void 0
      ? _j
      : contextResolve(
          context,
          config === null || config === void 0 ? void 0 : config.outDir,
        );
  const outFile =
    (_k = cliFlags.outFile) !== null && _k !== void 0
      ? _k
      : contextResolve(
          context,
          config === null || config === void 0 ? void 0 : config.outFile,
        );
  if (outDir && outFile) {
    throw new Error('outDir and outFile cannot be combined.');
  }
  const outputFile = `${projectTitle}.${format}`;
  const outputPath = outDir
    ? upath_1.default.resolve(outDir, outputFile)
    : outFile !== null && outFile !== void 0
    ? outFile
    : upath_1.default.resolve(outputFile);
  const language =
    (_l = config === null || config === void 0 ? void 0 : config.language) !==
      null && _l !== void 0
      ? _l
      : 'en';
  const sizeFlag =
    (_m = cliFlags.size) !== null && _m !== void 0
      ? _m
      : config === null || config === void 0
      ? void 0
      : config.size;
  const size = sizeFlag ? parsePageSize(sizeFlag) : undefined;
  const toc =
    typeof (config === null || config === void 0 ? void 0 : config.toc) ===
    'string'
      ? contextResolve(
          context,
          config === null || config === void 0 ? void 0 : config.toc,
        )
      : (config === null || config === void 0 ? void 0 : config.toc) !==
        undefined
      ? config.toc
      : false;
  const cover =
    (_o = contextResolve(
      context,
      config === null || config === void 0 ? void 0 : config.cover,
    )) !== null && _o !== void 0
      ? _o
      : undefined;
  const pressReady =
    (_q =
      (_p = cliFlags.pressReady) !== null && _p !== void 0
        ? _p
        : config === null || config === void 0
        ? void 0
        : config.pressReady) !== null && _q !== void 0
      ? _q
      : false;
  const verbose =
    (_r = cliFlags.verbose) !== null && _r !== void 0 ? _r : false;
  const timeout =
    (_t =
      (_s = cliFlags.timeout) !== null && _s !== void 0
        ? _s
        : config === null || config === void 0
        ? void 0
        : config.timeout) !== null && _t !== void 0
      ? _t
      : DEFAULT_TIMEOUT;
  const sandbox = (_u = cliFlags.sandbox) !== null && _u !== void 0 ? _u : true;
  const executableChromium =
    (_v = cliFlags.executableChromium) !== null && _v !== void 0
      ? _v
      : puppeteer_1.default.executablePath();
  const themeIndexes = [];
  const rootTheme =
    (_w = parseTheme(cliFlags.theme, process_1.default.cwd())) !== null &&
    _w !== void 0
      ? _w
      : parseTheme(
          config === null || config === void 0 ? void 0 : config.theme,
          context,
        );
  if (rootTheme) {
    themeIndexes.push(rootTheme);
  }
  function parseEntry(entry) {
    var _a, _b, _c, _d;
    const sourcePath = upath_1.default.resolve(entryContextDir, entry.path); // abs
    const sourceDir = upath_1.default.dirname(sourcePath); // abs
    const contextEntryPath = upath_1.default.relative(
      entryContextDir,
      sourcePath,
    ); // rel
    const targetPath = upath_1.default
      .resolve(artifactDir, contextEntryPath)
      .replace(/\.md$/, '.html');
    const targetDir = upath_1.default.dirname(targetPath);
    const type = sourcePath.endsWith('.html') ? 'html' : 'markdown';
    const metadata = parseFileMetadata(type, sourcePath);
    const title =
      (_b =
        (_a = entry.title) !== null && _a !== void 0 ? _a : metadata.title) !==
        null && _b !== void 0
        ? _b
        : projectTitle;
    const theme =
      (_d =
        (_c = parseTheme(entry.theme, sourceDir)) !== null && _c !== void 0
          ? _c
          : metadata.theme) !== null && _d !== void 0
        ? _d
        : themeIndexes[0];
    if (theme && themeIndexes.every((t) => t.location !== theme.location)) {
      themeIndexes.push(theme);
    }
    return {
      type,
      source: { path: sourcePath, dir: sourceDir },
      target: { path: targetPath, dir: targetDir },
      title,
      theme,
    };
  }
  const rawEntries = cliFlags.input
    ? [cliFlags.input]
    : config
    ? Array.isArray(config.entry)
      ? config.entry
      : config.entry
      ? [config.entry]
      : []
    : [];
  const entries = rawEntries.map(normalizeEntry).map(parseEntry);
  const parsedConfig = {
    entryContextDir,
    artifactDir,
    distDir,
    outputPath,
    entries,
    themeIndexes,
    pressReady,
    size,
    projectTitle,
    projectAuthor,
    language,
    toc,
    cover,
    format,
    verbose,
    timeout,
    sandbox,
    executableChromium,
  };
  util_1.debug('parsedConfig', parsedConfig);
  return parsedConfig;
}
exports.mergeConfig = mergeConfig;
//# sourceMappingURL=config.js.map
