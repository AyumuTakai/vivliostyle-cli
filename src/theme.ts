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

export type ParsedTheme = UriTheme | FileTheme | PackageTheme;

export interface UriTheme {
  type: 'uri';
  name: string;
  location: string;
}

export interface FileTheme {
  type: 'file';
  name: string;
  location: string;
  destination: string;
}

export interface PackageTheme {
  type: 'package';
  name: string;
  location: string;
  destination: string;
  style: string;
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
  private cliTheme: ParsedTheme | undefined;
  // theme specified in the theme field of the vivliostyle.config.js
  private configTheme: ParsedTheme | undefined;

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
  private static parseURL(locator: string) {
    if (ThemeManager.isURL(locator)) {
      const theme: UriTheme = {
        type: 'uri',
        name: path.basename(locator),
        location: locator,
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
  ): ParsedTheme | undefined {
    const stylePath = path.resolve(contextDir, locator);
    const sourceRelPath = path.relative(contextDir, stylePath);
    const theme: FileTheme = {
      type: 'file',
      name: path.basename(locator),
      location: stylePath,
      destination: path.resolve(workspaceDir, sourceRelPath),
    };
    return theme;
  }

  /**
   * parse theme locator
   * @param locator "theme"
   * @param contextDir
   * @param workspaceDir
   */
  static parseTheme(
    locator: string | undefined,
    contextDir: string,
    workspaceDir: string,
  ): ParsedTheme | undefined {
    if (typeof locator !== 'string' || locator == '') {
      return undefined;
    }

    return (
      ThemeManager.parseURL(locator) ?? // url
      ThemeManager.parseModules(locator, contextDir, workspaceDir) ?? // node_modules, local pkg
      ThemeManager.parseBareCssFile(locator, contextDir, workspaceDir)
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
   * theme from vivliostyle.config.js
   * @param config
   * @param contextDir
   * @param workspaceDir
   */
  setConfigTheme(
    config: VivliostyleConfigSchema | undefined,
    contextDir: string,
    workspaceDir: string,
  ) {
    if (config) {
      this.configTheme = ThemeManager.parseTheme(
        config.theme,
        contextDir,
        workspaceDir,
      );
    }
  }

  /**
   * theme from cli flags
   * @param cliFlags
   * @param workspaceDir
   */
  setCliTheme(cliFlags: CliFlags, workspaceDir: string) {
    this.cliTheme = ThemeManager.parseTheme(
      cliFlags.theme,
      process.cwd(),
      workspaceDir,
    );
  }

  /**
   * theme for each entry
   * @param metadata
   * @param entry
   * @param contextDir
   * @param workspaceDir
   */
  resolveEntryTheme(
    metadata: { title?: string; theme?: ParsedTheme },
    entry: EntryObject | ContentsEntryObject | undefined,
    contextDir: string,
    workspaceDir: string,
  ): ParsedTheme | undefined {
    const theme =
      ThemeManager.parseTheme(entry?.theme, contextDir, workspaceDir) ??
      metadata.theme ??
      this.rootTheme();
    this.addTheme(theme);
    return theme;
  }

  /**
   * theme specified in the CLI or config
   * @return array of themes
   */
  rootTheme(): ParsedTheme | undefined {
    const theme = this.cliTheme ?? this.configTheme;
    this.addTheme(theme);
    return theme;
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
  ): ParsedTheme | undefined {
    const theme =
      ThemeManager.parseTheme(entry.theme, context, workspaceDir) ??
      this.rootTheme();
    this.addTheme(theme);
    return theme;
  }

  /**
   * single input file has no entry theme
   * @param metadata
   */
  singleInputTheme(metadata: {
    title?: string;
    theme?: ParsedTheme;
  }): ParsedTheme | undefined {
    const theme = metadata.theme ?? this.rootTheme();
    this.addTheme(theme);
    return theme;
  }

  /**
   * copy style files to destination
   */
  copyThemes(): void {
    for (const theme of this) {
      if (theme.type === 'file') {
        if (theme.location !== theme.destination) {
          shelljs.mkdir('-p', path.dirname(theme.destination));
          shelljs.cp(theme.location, theme.destination);
        }
      } else if (theme.type === 'package') {
        shelljs.mkdir('-p', theme.destination);
        shelljs.cp('-r', path.join(theme.location, '*'), theme.destination);
      }
    }
  }
}
