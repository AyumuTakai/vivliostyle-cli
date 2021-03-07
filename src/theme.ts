import fs from 'fs';
import resolvePkg from 'resolve-pkg';
import shelljs from 'shelljs';
import path from 'upath';
import { isHttpURL, pathStartsWith } from './util';

export interface Theme {
  pushTo(indexes: SingleTheme[]): void;
  locatePath(from: string): string[];
  copyTheme(): void;
}
//export type SingleTheme = UriTheme | FileTheme | PackageTheme;
export type ParsedTheme = SingleTheme | Themes;

export function parseSingleTheme(
  locator: string | undefined,
  contextDir: string,
  workspaceDir: string,
): SingleTheme | undefined {
  if (typeof locator !== 'string' || locator == '') {
    return undefined;
  }

  // url
  const uriTheme = UriTheme.parse(locator);
  if (uriTheme) return uriTheme;

  // node_modules, local pkg
  const pkgTheme = PackageTheme.parse(locator, contextDir, workspaceDir);
  if (pkgTheme) return pkgTheme;

  // bare .css file
  const fileTheme = FileTheme.parse(locator, contextDir, workspaceDir);
  if (fileTheme) return fileTheme;
}

/**
 * Theme base class
 */
export class SingleTheme implements Theme {
  name: string;
  location: string;

  public constructor(name: string, location: string) {
    this.name = name;
    this.location = location;
  }

  /**
   * theme push to Theme indexes.
   * @param indexes
   */
  public pushTo(indexes: SingleTheme[]) {
    // if already registered, don't add it.
    if (indexes.every((theme) => theme.location !== this.location)) {
      indexes.push(this);
    }
  }

  /**
   *
   * @param from
   */
  public locatePath(from: string): string[] {
    // subclasses must implement
    return [];
  }

  /**
   * copy theme file or package to workspace
   */
  public copyTheme(): void {
    // subclasses must implement
  }

  /*

   */
  public destinationIs(path: string): boolean {
    return false;
  }
}

/**
 *
 */
export class UriTheme extends SingleTheme {
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
  public locatePath(from: string): string[] {
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
    if (isHttpURL(locator)) {
      const theme: UriTheme = new UriTheme(path.basename(locator), locator);
      return theme;
    }
  }
}

/**
 *
 */
export class FileTheme extends SingleTheme {
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
  public locatePath(from: string): string[] {
    return [path.relative(from, this.destination)];
  }

  /**
   * copy theme file to workspace
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

  /**
   *
   * @param path
   */
  public destinationIs(path: string): boolean {
    return path === this.destination;
  }
}

/**
 *
 */
export class PackageTheme extends SingleTheme {
  type: 'package' = 'package';
  destination: string;
  style: string[];

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
    style: string | string[],
  ) {
    super(name, location);
    this.destination = destination;
    this.style = Array.isArray(style) ? style : [style];
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

  /**
   *
   * @param from
   */
  public locatePath(from: string): string[] {
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
   * @param path
   */
  public destinationIs(path: string): boolean {
    return pathStartsWith(path, this.destination);
  }
}

/**
 * Collection of SingleTheme
 */
export class Themes implements Theme {
  type: 'array' = 'array';
  themeArray: SingleTheme[] = [];

  public constructor(
    locators: string[],
    contextDir: string,
    workspaceDir: string,
  ) {
    for (const locator of locators) {
      const theme = parseSingleTheme(locator, contextDir, workspaceDir);
      if (theme) {
        this.themeArray.push(theme);
      }
    }
  }

  /**
   *
   * @override
   * @param indexes
   */
  public pushTo(indexes: SingleTheme[]) {
    for (const theme of this.themeArray) {
      theme.pushTo(indexes);
    }
  }

  /**
   *
   * @param from
   */
  public locatePath(from: string): string[] {
    let styles: string[] = [];
    for (const theme of this.themeArray) {
      styles = styles.concat(theme.locatePath(from));
    }
    return styles;
  }

  /**
   * copy theme file or package to workspace
   */
  public copyTheme(): void {
    for (const theme of this.themeArray) {
      theme.copyTheme();
    }
  }
}
