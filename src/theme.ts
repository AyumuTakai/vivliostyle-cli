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
   * @param from
   */
  public locateThemePath(from: string): string {
    return '';
  }

  /**
   *
   */
  public copyTheme(): void {
    // nothing to do
  }
}

/**
 *
 */
export class UriTheme extends Theme {
  type: 'uri' = 'uri';
  name: string;
  location: string;

  /**
   *
   * @param name
   * @param location
   */
  public constructor(name: string, location: string) {
    super();
    this.name = name;
    this.location = location;
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
  name: string;
  location: string;
  destination: string;

  /**
   *
   * @param name
   * @param location
   * @param destination
   */
  public constructor(name: string, location: string, destination: string) {
    super();
    this.name = name;
    this.location = location;
    this.destination = destination;
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
    if (this.location !== this.destination) {
      shelljs.mkdir('-p', path.dirname(this.destination));
      shelljs.cp(this.location, this.destination);
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
  name: string;
  location: string;
  destination: string;
  style: string;

  /**
   *
   * @param name
   * @param location
   * @param destination
   * @param style
   */
  public constructor(
    name: string,
    location: string,
    destination: string,
    style: string,
  ) {
    super();
    this.name = name;
    this.location = location;
    this.destination = destination;
    this.style = style;
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
  private cliTheme: ParsedTheme | undefined;
  // theme specified in the theme field of the vivliostyle.config.js
  private configTheme: ParsedTheme | undefined;

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
      UriTheme.parse(locator) ?? // url
      PackageTheme.parse(locator, contextDir, workspaceDir) ?? // node_modules, local pkg
      FileTheme.parse(locator, contextDir, workspaceDir) ?? // bare .css file
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
      const theme = ThemeManager.parseTheme(
        config.theme,
        contextDir,
        workspaceDir,
      );
      this.configTheme = theme;
    }
  }

  /**
   * theme from cli flags
   * @param cliFlags
   * @param workspaceDir
   */
  setCliTheme(cliFlags: CliFlags, workspaceDir: string) {
    const theme = ThemeManager.parseTheme(
      cliFlags.theme,
      process.cwd(),
      workspaceDir,
    );
    if (theme) {
      this.cliTheme = theme;
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
    metadata: { title?: string; theme?: ParsedTheme },
    entry: EntryObject | ContentsEntryObject | undefined,
    contextDir: string,
    workspaceDir: string,
  ): ParsedTheme | undefined {
    const entryTheme = ThemeManager.parseTheme(
      entry?.theme,
      contextDir,
      workspaceDir,
    );
    const theme = entryTheme ?? metadata.theme ?? this.rootTheme();
    this.addUsedTheme(theme);
    return theme;
  }

  /**
   * theme specified in the CLI or config
   * @return array of themes
   */
  rootTheme(): ParsedTheme | undefined {
    const theme = this.cliTheme ?? this.configTheme ?? undefined;
    this.addUsedTheme(theme);
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
    const entryTheme = ThemeManager.parseTheme(
      entry.theme,
      context,
      workspaceDir,
    );
    const theme = entryTheme ?? this.rootTheme();
    this.addUsedTheme(theme);
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
    this.addUsedTheme(theme);
    return theme;
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
