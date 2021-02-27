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

export interface UriTheme {
  type: 'uri';
  name: string;
  location: string;
  vars?: any | undefined;
}

export interface FileTheme {
  type: 'file';
  name: string;
  location: string;
  destination: string;
  vars?: any | undefined;
}

export interface PackageTheme {
  type: 'package';
  name: string;
  location: string;
  destination: string;
  style: string;
  vars?: any | undefined;
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
   * check url string
   * @param str
   * @private
   */
  private static isURL(str: string) {
    return /^https?:\/\//.test(str);
  }

  /**
   * create UriTheme
   * @param locator
   * @private
   */
  private static parseURL(
    locator: string,
    themeVars: any | undefined = undefined,
  ) {
    if (ThemeManager.isURL(locator)) {
      const theme: UriTheme = {
        type: 'uri',
        name: path.basename(locator),
        location: locator,
        vars: themeVars,
      };
      return theme;
    }
  }

  /**
   * create PackageTheme
   * @param locator
   * @param contextDir
   * @param workspaceDir
   * @private
   */
  private static parseModules(
    locator: string,
    contextDir: string,
    workspaceDir: string,
    themeVars: any | undefined = undefined,
  ): ParsedTheme | undefined {
    const pkgRootDir = resolvePkg(locator, { cwd: contextDir });
    if (!pkgRootDir?.endsWith('.css')) {
      const location = pkgRootDir ?? path.resolve(contextDir, locator);
      const style = ThemeManager.parseStyleLocator(location, locator);
      if (style) {
        const theme: PackageTheme = {
          type: 'package',
          name: style.name,
          location: location,
          destination: path.join(workspaceDir, 'themes/packages', style.name),
          style: style.maybeStyle,
          vars: themeVars,
        };
        return theme;
      }
    }
  }

  /**
   * create FileTheme
   * @param locator
   * @param contextDir
   * @param workspaceDir
   * @private
   */
  private static parseBareCssFile(
    locator: string,
    contextDir: string,
    workspaceDir: string,
    themeVars: any | undefined = undefined,
  ): ParsedTheme | undefined {
    const stylePath = path.resolve(contextDir, locator);
    const sourceRelPath = path.relative(contextDir, stylePath);
    const theme: FileTheme = {
      type: 'file',
      name: path.basename(locator),
      location: stylePath,
      destination: path.resolve(workspaceDir, sourceRelPath),
      vars: themeVars,
    };
    return theme;
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
    themeVars: any | undefined = undefined,
  ): ParsedTheme[] {
    const themes: ParsedTheme[] = [];
    if (Array.isArray(locators)) {
      locators.forEach((locator) => {
        const theme = ThemeManager.parseTheme(
          locator,
          contextDir,
          workspaceDir,
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
      ThemeManager.parseURL(locator, themeVars) ?? // url
      ThemeManager.parseModules(locator, contextDir, workspaceDir, themeVars) ?? // node_modules, local pkg
      ThemeManager.parseBareCssFile(
        locator,
        contextDir,
        workspaceDir,
        themeVars,
      )
    ); // bare .css file
  }

  /**
   * add theme to themeIndexes
   * @param theme
   */
  private addTheme(theme: ParsedTheme | undefined): void {
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
    themes.map((t) => this.addTheme(t));
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
    themeVars: any | undefined = undefined,
  ) {
    if (config) {
      this.configThemes = this.configThemes.concat(
        ThemeManager.parseThemes(
          config.theme,
          contextDir,
          workspaceDir,
          themeVars,
        ),
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
   * sass(scss)をトランスパイルする
   * 生成したCSSの場所によってurl()の指定がずれてしまう
   * @param src 元ファイル
   * @param dst 保存先ファイル名
   * @param vars 上書きする変数
   */
  private transpileSass(src: string, dst: string, vars: any = null) {
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
  /**
   * copy style files to destination
   */
  public copyThemes(): void {
    for (const theme of this) {
      if (theme.type === 'file') {
        if (theme.name.endsWith('.scss')) {
          const vars = theme.vars;
          theme.destination = theme.destination.replace(/\.scss$/, '.css');
          this.transpileSass(theme.location, theme.destination, vars);
          theme.location = theme.location.replace(/\.scss$/, '.css');
          theme.name = theme.name.replace(/\.scss$/, '.css');
        } else {
          if (theme.location !== theme.destination) {
            shelljs.mkdir('-p', path.dirname(theme.destination));
            shelljs.cp(theme.location, theme.destination);
          }
        }
      } else if (theme.type === 'package') {
        shelljs.mkdir('-p', theme.destination);
        shelljs.cp('-r', path.join(theme.location, '*'), theme.destination);
        if (theme.style.endsWith('.scss')) {
          const vars = theme.vars;
          const src = path.join(theme.location, theme.style);
          theme.style = theme.style.replace(/\.scss$/, '.css');
          const dst = path.join(theme.destination, theme.style);
          this.transpileSass(src, dst, vars);
        }
      }
    }
  }
}
