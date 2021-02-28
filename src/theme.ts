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

/**
 * Theme base class
 */
class Theme {
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
   * @param path
   * @protected
   */
  protected renameSCSStoCSS(path: string) {
    return path.replace(/\.scss$/, '.css');
  }

  /**
   * sass(scss)をトランスパイルする
   * 生成したCSSの場所によってurl()の指定がずれてしまう
   * @param src 元ファイル
   * @param dst 保存先ファイル名
   * @param vars 上書きする変数
   */
  protected transpileSass(src: string, dst: string, vars: any = null) {
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
    fs.promises
      .mkdir(path.dirname(dst), { recursive: true })
      .then(() => {
        fs.writeFileSync(dst, result.css);
      })
      .catch(console.error);
  }
}

/**
 *
 */
export class UriTheme extends Theme {
  type: 'uri' = 'uri';
  name: string;
  location: string;
  vars?: any | undefined;

  /**
   *
   * @param name
   * @param location
   * @param vars
   */
  public constructor(
    name: string,
    location: string,
    vars: any | undefined = undefined,
  ) {
    super();
    this.name = name;
    this.location = location;
    this.vars = vars;
  }

  /**
   *
   * @param from
   */
  public locateThemePath(from: string): string {
    return this.location;
  }

  /**
   *
   */
  public copyTheme() {
    // nothing to do
  }

  /**
   *
   * @param locator
   * @param themeVars
   */
  public static parse(locator: string, themeVars: any): UriTheme | undefined {
    if (this.isURL(locator)) {
      const theme: UriTheme = new UriTheme(
        path.basename(locator),
        locator,
        themeVars,
      );
      return theme;
    }
  }
}

/**
 *
 */
export class FileTheme extends Theme {
  type: 'file' = 'file';
  name: string;
  location: string;
  destination: string;
  vars?: any | undefined;

  /**
   *
   * @param name
   * @param location
   * @param destination
   * @param vars
   */
  public constructor(
    name: string,
    location: string,
    destination: string,
    vars: any | undefined = undefined,
  ) {
    super();
    this.name = name;
    this.location = location;
    this.destination = destination;
    this.vars = vars;
  }

  /**
   *
   * @param from
   */
  public locateThemePath(from: string): string {
    return path.relative(from, this.destination);
  }

  /**
   *
   */
  public copyTheme(): void {
    if (this.name.endsWith('.scss')) {
      const vars = this.vars;
      this.destination = this.renameSCSStoCSS(this.destination);
      this.transpileSass(this.location, this.destination, vars);
    } else {
      if (this.location !== this.destination) {
        shelljs.mkdir('-p', path.dirname(this.destination));
        shelljs.cp(this.location, this.destination);
      }
    }
  }

  /**
   *
   * @param locator
   * @param contextDir
   * @param workspaceDir
   * @param themeVars
   */
  public static parse(
    locator: string,
    contextDir: string,
    workspaceDir: string,
    themeVars: any,
  ): FileTheme | undefined {
    const stylePath = path.resolve(contextDir, locator);
    const sourceRelPath = path.relative(contextDir, stylePath);
    const theme = new FileTheme(
      path.basename(locator),
      stylePath,
      path.resolve(workspaceDir, sourceRelPath),
      themeVars,
    );
    return theme;
  }
}

/**
 *
 */
export class PackageTheme extends Theme {
  type: 'package' = 'package';
  name: string;
  location: string;
  destination: string;
  style: string;
  vars?: any | undefined;

  /**
   *
   * @param name
   * @param location
   * @param destination
   * @param style
   * @param vars
   */
  public constructor(
    name: string,
    location: string,
    destination: string,
    style: string,
    vars: any | undefined = undefined,
  ) {
    super();
    this.name = name;
    this.location = location;
    this.destination = destination;
    this.style = style;
    this.vars = vars;
  }

  /**
   *
   * @param from
   */
  public locateThemePath(from: string): string {
    return path.relative(from, path.join(this.destination, this.style));
  }

  /**
   *
   */
  public copyTheme() {
    shelljs.mkdir('-p', this.destination);
    shelljs.cp('-r', path.join(this.location, '*'), this.destination);
    if (this.style.endsWith('.scss')) {
      const vars = this.vars;
      const src = path.join(this.location, this.style);
      this.style = this.renameSCSStoCSS(this.style);
      const dst = path.join(this.destination, this.style);
      this.transpileSass(src, dst, vars);
    }
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
  private static parseStyleLocator(
    pkgRootDir: string,
    locator: string,
  ): { name: string; maybeStyle: string } | undefined {
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
    return { name: packageJson.name, maybeStyle };
  }

  /**
   *
   * @param locator
   * @param contextDir
   * @param workspaceDir
   * @param themeVars
   */
  public static parse(
    locator: string,
    contextDir: string,
    workspaceDir: string,
    themeVars: any,
  ): PackageTheme | undefined {
    if (!locator) return;
    const pkgRootDir = resolvePkg(locator, { cwd: contextDir });
    if (!pkgRootDir?.endsWith('.css')) {
      const location = pkgRootDir ?? path.resolve(contextDir, locator);
      const style = PackageTheme.parseStyleLocator(location, locator);
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
          themeVars,
        );
        return theme;
      }
    }
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
   *
   * @param locators ["theme1","theme2"] | "theme" | undefined
   * @param contextDir
   * @param workspaceDir
   * @param themeVars
   */
  static parseThemes(
    locators: string[] | string | undefined,
    contextDir: string,
    workspaceDir: string,
    themeVars: any | undefined = undefined,
  ): ParsedTheme[] {
    const themes: ParsedTheme[] = [];

    if (!locators) return themes;

    if (Array.isArray(locators)) {
      locators.forEach((locator) => {
        const theme = ThemeManager.parseTheme(
          locator,
          contextDir,
          workspaceDir,
          themeVars,
        );
        if (theme) {
          themes.push(theme);
        }
      });
    } else {
      const theme = ThemeManager.parseTheme(
        locators,
        contextDir,
        workspaceDir,
        themeVars,
      );
      if (theme) {
        themes.push(theme);
      }
    }
    return themes;
  }

  /**
   * parse theme locator
   * @param locator "theme"
   * @param contextDir
   * @param workspaceDir
   * @param themeVars
   */
  private static parseTheme(
    locator: string | undefined,
    contextDir: string,
    workspaceDir: string,
    themeVars: any | undefined = undefined,
  ): ParsedTheme | undefined {
    if (typeof locator !== 'string' || locator == '') {
      return undefined;
    }
    return (
      UriTheme.parse(locator, themeVars) ?? // url
      PackageTheme.parse(locator, contextDir, workspaceDir, themeVars) ?? // node_modules, local pkg
      FileTheme.parse(locator, contextDir, workspaceDir, themeVars) ?? // bare .css file
      undefined
    );
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
  private addUsedThemes(themes: ParsedTheme[]): void {
    for (const theme of themes) {
      this.addUsedTheme(theme);
    }
  }

  /**
   * theme from vivliostyle.config.js
   * @param config
   * @param contextDir
   * @param workspaceDir
   * @param themeVars
   */
  setConfigTheme(
    config: VivliostyleConfigSchema | undefined,
    contextDir: string,
    workspaceDir: string,
    themeVars: any | undefined = undefined,
  ): void {
    if (config) {
      const themes = ThemeManager.parseThemes(
        config.theme,
        contextDir,
        workspaceDir,
        themeVars,
      );
      this.configThemes = this.configThemes.concat(themes);
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
    this.addUsedThemes(themes);
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
    this.addUsedThemes(themes);
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
    this.addUsedThemes(themes);
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
    this.addUsedThemes(themes);
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
