import { ReplaceRule } from '@vivliostyle/vfm/lib/plugins/replace';
import fs from 'fs';
import resolvePkg from 'resolve-pkg';
import shelljs from 'shelljs';
import path from 'upath';
import { CliFlags } from './config';
import {
  ContentsEntryObject,
  EntryObject,
  VivliostyleConfigSchema,
} from './schema/vivliostyle.config';
const sass = require('sass');

export type ParsedTheme = UriTheme | FileTheme | PackageTheme;
export type PreProcess = (filename: string, contents: string) => string;

/**
 * Theme base class
 */
export class Theme {
  name: string;
  location: string;
  scripts?: string;
  preprocess: PreProcess | undefined;
  replace: ReplaceRule[];

  public constructor(name: string, location: string) {
    this.name = name;
    this.location = location;
    this.preprocess = undefined;
    this.replace = [];
  }

  /**
   * check url string
   * @param str
   * @private
   */
  protected static isURL(str: string) {
    return /^https?:\/\//.test(str);
  }

  /**
   *
   * @param from
   */
  public locateThemePath(from: string): string[] {
    // subclasses must implement
    return [];
  }

  /**
   * copy theme file or package to workspace
   */
  public copyTheme(): void {
    // subclasses must implement
  }

  /**
   * traspile scss
   * @param src source file path
   * @param vars overwrite variables
   */
  public static transpileSass(src: string, vars: any = null): string {
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
      data: `@use '${path.basename(src)}' ${with_vars};`,
      outputStyle: 'expanded',
      includePaths: [path.dirname(src)],
    });
    return result.css.toString();
  }
}

/**
 *
 */
export class UriTheme extends Theme {
  type: 'uri' = 'uri';

  /**
   *
   * @param name
   * @param location
   */
  public constructor(name: string, location: string) {
    super(name, location);
  }

  /**
   *
   * @param from
   * @return uri string
   */
  public locateThemePath(from: string): string[] {
    return [this.location];
  }

  /**
   * nothing to do
   */
  public copyTheme() {
    // nothing to do
  }

  /**
   * create URITheme instance from URI
   * @param locator
   */
  public static parse(locator: string): UriTheme | undefined {
    if (this.isURL(locator)) {
      const theme: UriTheme = new UriTheme(path.basename(locator), locator);
      return theme;
    }
  }
}

/**
 *
 */
export class FileTheme extends Theme {
  type: 'file' = 'file';
  destination: string;

  /**
   *
   * @param name
   * @param location
   * @param destination
   */
  public constructor(name: string, location: string, destination: string) {
    super(name, location);
    this.destination = destination;
  }

  /**
   * ThemePath(relative path)
   * @param from
   */
  public locateThemePath(from: string): string[] {
    return [path.relative(from, this.destination)];
  }

  /**
   * copy theme file to workspace
   */
  public copyTheme(): void {
    if (this.location !== this.destination) {
      shelljs.mkdir('-p', path.dirname(this.destination));
      if (this.location.endsWith('.scss')) {
        this.destination = this.destination.replace(/.scss$/, '.css');
        const css = Theme.transpileSass(this.location);
        fs.writeFileSync(this.destination, css);
      } else {
        shelljs.cp(this.location, this.destination);
      }
    }
  }

  /**
   *
   * @param locator
   * @param contextDir
   * @param workspaceDir
   */
  public static parse(
    locator: string,
    contextDir: string,
    workspaceDir: string,
  ): FileTheme | undefined {
    const stylePath = path.resolve(contextDir, locator);
    const sourceRelPath = path.relative(contextDir, stylePath);
    const theme = new FileTheme(
      path.basename(locator),
      stylePath,
      path.resolve(workspaceDir, sourceRelPath),
    );
    return theme;
  }
}

/**
 *
 */
export class PackageTheme extends Theme {
  type: 'package' = 'package';
  destination: string;
  style: string[];

  /**
   *
   * @param name
   * @param location
   * @param destination
   * @param style
   * @param scripts
   */
  public constructor(
    name: string,
    location: string,
    destination: string,
    style: string | string[],
    scripts?: string,
  ) {
    super(name, location);
    this.destination = destination;
    this.style = Array.isArray(style) ? style : [style];
    this.scripts = scripts;
    if (this.scripts) {
      const scriptsPath = path.resolve(this.location, this.scripts);
      const script = require(scriptsPath);
      if (script) {
        this.preprocess = script.preprocess ?? undefined;
        this.replace = script.replace ?? [];
      }
    }
  }

  /**
   *
   * @param locator
   * @param contextDir
   * @param workspaceDir
   * @private
   */
  public static parse(
    locator: string,
    contextDir: string,
    workspaceDir: string,
  ): PackageTheme | undefined {
    if (!locator) return;
    const pkgRootDir = resolvePkg(locator, { cwd: contextDir });
    if (!pkgRootDir?.endsWith('.css')) {
      const location = pkgRootDir ?? path.resolve(contextDir, locator);
      const style = PackageTheme.parseStyleLocator(location, locator);
      const scripts = style?.scripts;
      if (style) {
        const destination = path.join(
          workspaceDir,
          'themes/packages',
          style.name,
        );
        const theme = new PackageTheme(
          style.name,
          location,
          destination,
          style.maybeStyle,
          scripts,
        );
        return theme;
      }
    }
  }

  /**
   *
   * @param from
   */
  public locateThemePath(from: string): string[] {
    return this.style.map((sty) => {
      return path.relative(from, path.join(this.destination, sty));
    });
  }

  /**
   * copy theme package to workspace
   */
  public copyTheme() {
    shelljs.mkdir('-p', this.destination);
    shelljs.cp('-r', path.join(this.location, '*'), this.destination);
    this.style = this.style.map((sty) => {
      if (sty.endsWith('.scss')) {
        const src = path.resolve(this.location, sty);
        sty = sty.replace(/.scss$/, '.css');
        const dst = path.resolve(this.destination, sty);
        const css = Theme.transpileSass(src);
        shelljs.mkdir('-p', path.dirname(dst));
        fs.writeFileSync(dst, css);
      }
      return sty;
    });
  }

  /**
   *
   * @param packageJson
   * @private
   */
  private static parseScriptsLocator(packageJson: any): string | undefined {
    const scripts = packageJson?.vivliostyle?.theme?.scripts ?? undefined;
    return scripts;
  }

  /**
   * parse theme locator
   * 1. specified in the theme field of the vivliostyle.config.js
   * 2. specified in the style field of the package.json
   * 3. specified in the main field of the package.json
   * If more than one type is specified, the order of priority is 1 > 2 > 3
   * @param pkgRootDir
   * @param locator
   * @throws Error if invalid style file
   */
  static parseStyleLocator(
    pkgRootDir: string,
    locator: string,
  ):
    | { name: string; maybeStyle: string; scripts: string | undefined }
    | undefined {
    const pkgJsonPath = path.join(pkgRootDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      return undefined;
    }

    const packageJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

    const maybeStyle =
      packageJson?.vivliostyle?.theme?.style ??
      packageJson.style ??
      packageJson.main;

    if (!maybeStyle) {
      throw new Error(
        `invalid style file: ${maybeStyle} while parsing ${locator}`,
      );
    }

    const scripts = PackageTheme.parseScriptsLocator(packageJson);

    return { name: packageJson.name, maybeStyle, scripts };
  }
}

/**
 * Theme management class
 * There are four types of themes, which are applied exclusively to each document file.
 * 1. specified in the theme field of the vivliostyle.config.js
 * 2. specified by the argument of cli
 * 3. specified in the .md file's metadata
 * 4. specified in the entry field of the vivliostyle.config.js
 * If more than one type is specified, the order of priority is 4 > 3 > 2 > 1
 */
export class ThemeManager extends Array<ParsedTheme> {
  // theme specified by the argument of cli
  private cliThemes: ParsedTheme[] = [];
  // theme specified in the theme field of the vivliostyle.config.js
  private configThemes: ParsedTheme[] = [];

  /**
   * parse theme locator
   * @param locator "theme"
   * @param contextDir
   * @param workspaceDir
   */
  private static parseTheme(
    locator: string | undefined,
    contextDir: string,
    workspaceDir: string,
  ): ParsedTheme | undefined {
    if (typeof locator !== 'string' || locator == '') {
      return undefined;
    }

    return (
      UriTheme.parse(locator) ?? // url
      PackageTheme.parse(locator, contextDir, workspaceDir) ?? // node_modules, local pkg
      FileTheme.parse(locator, contextDir, workspaceDir) ?? // bare .css file
      undefined
    );
  }

  /**
   *
   * @param locators ["theme1","theme2"] | "theme" | undefined
   * @param contextDir
   * @param workspaceDir
   */
  static parseThemes(
    locators: string[] | string | undefined,
    contextDir: string,
    workspaceDir: string,
  ): ParsedTheme[] {
    const themes: ParsedTheme[] = [];

    const parse_theme = (locator: string | undefined) => {
      const theme = ThemeManager.parseTheme(locator, contextDir, workspaceDir);
      if (theme) {
        themes.push(theme);
      }
    };

    if (Array.isArray(locators)) {
      for (const locator of locators) {
        parse_theme(locator);
      }
    } else {
      parse_theme(locators);
    }
    return themes;
  }

  /**
   * add theme to themeIndexes
   * @param theme
   */
  private addUsedTheme(theme: ParsedTheme | undefined): void {
    // if already registered, don't add it.
    if (theme && this.every((t) => t.location !== theme.location)) {
      this.push(theme);
    }
  }

  /**
   *
   * @param themes
   * @private
   */
  private addThemes(themes: ParsedTheme[]): void {
    themes.map((t) => this.addUsedTheme(t));
  }

  /**
   * theme from vivliostyle.config.js
   * @param config
   * @param contextDir
   * @param workspaceDir
   */
  setConfigTheme(
    config: VivliostyleConfigSchema | undefined,
    contextDir: string,
    workspaceDir: string,
  ): void {
    if (config) {
      this.configThemes = this.configThemes.concat(
        ThemeManager.parseThemes(config.theme, contextDir, workspaceDir),
      );
    }
  }

  /**
   * theme from cli flags
   * @param cliFlags
   * @param workspaceDir
   */
  setCliTheme(cliFlags: CliFlags, workspaceDir: string) {
    const themes = ThemeManager.parseThemes(
      cliFlags.theme,
      process.cwd(),
      workspaceDir,
    );
    if (themes) {
      this.cliThemes = this.cliThemes.concat(themes);
    }
  }

  /**
   * theme for each entry
   * @param metadata
   * @param entry
   * @param contextDir
   * @param workspaceDir
   */
  resolveEntryTheme(
    metadata: { title?: string; theme?: ParsedTheme[] },
    entry: EntryObject | ContentsEntryObject | undefined,
    contextDir: string,
    workspaceDir: string,
  ): ParsedTheme[] {
    const entryThemes = ThemeManager.parseThemes(
      entry?.theme,
      contextDir,
      workspaceDir,
    );
    const themes =
      entryThemes.length != 0
        ? entryThemes
        : metadata.theme && metadata.theme?.length != 0
        ? metadata.theme
        : this.rootTheme();
    this.addThemes(themes);
    return themes;
  }

  /**
   * theme specified in the CLI or config
   * @return array of themes
   */
  rootTheme(): ParsedTheme[] {
    const themes =
      this.cliThemes.length != 0
        ? this.cliThemes
        : this.configThemes.length != 0
        ? this.configThemes
        : [];
    this.addThemes(themes);
    return themes;
  }

  /**
   * Theme for table of contents
   * Table of contents cannot be themed by metadata
   * @param entry
   * @param context
   * @param workspaceDir
   * @return theme specified in root theme or entry theme
   */
  tocTheme(
    entry: EntryObject | ContentsEntryObject,
    context: string,
    workspaceDir: string,
  ): ParsedTheme[] {
    const entryThemes = ThemeManager.parseThemes(
      entry.theme,
      context,
      workspaceDir,
    );
    const themes = entryThemes.length != 0 ? entryThemes : this.rootTheme();
    this.addThemes(themes);
    return themes;
  }

  /**
   * single input file has no entry theme
   * @param metadata
   */
  singleInputTheme(metadata: {
    title?: string;
    theme?: ParsedTheme[];
  }): ParsedTheme[] {
    const themes =
      metadata.theme && metadata.theme.length != 0
        ? metadata.theme
        : this.rootTheme();
    this.addThemes(themes);
    return themes;
  }

  /**
   * copy style files to destination
   */
  public copyThemes(): void {
    for (const theme of this) {
      theme.copyTheme();
    }
  }
}
