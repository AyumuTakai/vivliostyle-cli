import * as fs from 'fs';
import path from 'path';
import {
  FileTheme,
  PackageTheme,
  Theme,
  ThemeManager,
  UriTheme,
} from '../theme';

const rootPath = path.resolve(__dirname, '../..');
const localTmpDir = path.join(rootPath, 'tmp');
fs.mkdirSync(localTmpDir, { recursive: true });

it('test parse UriTheme', () => {
  const locator = 'http://example.jp';
  const uriTheme = UriTheme.parse(locator);

  expect(uriTheme).toBeDefined();
  const from = '';
  expect(uriTheme?.locateThemePath(from)).toEqual(['http://example.jp']);
});

it('test parse FileTheme', () => {
  const locator = 'style.css';
  const contextDir = './src/';
  const workspaceDir = './dst/';
  const fileTheme = FileTheme.parse(locator, contextDir, workspaceDir);
  if (fileTheme) {
    const location = path.relative(process.cwd(), fileTheme.location);
    const destination = path.relative(process.cwd(), fileTheme.destination);
    expect(location).toBe('src/style.css');
    expect(destination).toBe('dst/style.css');
  }
});

it('test parse PackageTheme', () => {
  const locator = '@vivliostyle/theme-bunko';
  const contextDir = './examples/theme-preset';
  const workspaceDir = './tmp';
  const packageTheme = PackageTheme.parse(locator, contextDir, workspaceDir);

  expect(packageTheme).toBeDefined();
  expect(packageTheme?.style).toEqual(['./theme.css']);

  // package has array of style
  const locator2 = './theme_ms';
  const contextDir2 = __dirname;
  const packageTheme2 = PackageTheme.parse(locator2, contextDir2, workspaceDir);

  expect(packageTheme2).toBeDefined();
  expect(packageTheme2?.style).toEqual(['theme.css', 'theme2.css']);
});

it('test ThemeManager', () => {
  const themeManager = new ThemeManager();

  expect(themeManager).toBeDefined();
});

it('test import preprocess scripts', () => {
  const locator = './src/__tests__/theme';
  const contextDir = './';
  const workspaceDir = './tmp';
  const packageTheme = PackageTheme.parse(locator, contextDir, workspaceDir);
  expect(packageTheme).toBeDefined();
  expect(packageTheme?.scripts).toBe('scripts.js');
  expect(packageTheme?.preprocess).toBeDefined();
});

it('test import replace rules', () => {
  const locator = './src/__tests__/theme';
  const contextDir = './';
  const workspaceDir = './tmp';
  const packageTheme = PackageTheme.parse(locator, contextDir, workspaceDir);
  expect(packageTheme).toBeDefined();
  expect(packageTheme?.scripts).toBe('scripts.js');
  expect(packageTheme?.replace.length).toBe(1);
});

it('test scss transpile', () => {
  const src = path.resolve(__dirname, 'scss/simple.scss'); // body: { h1: { color: blue; } }
  const dst = path.resolve(localTmpDir, 'simple.scss.css');
  const css = Theme.transpileSass(src);
  expect(css).toBe('body h1 {\n  color: blue;\n}');
});

it('test scss transpile with variables', () => {
  const src = path.resolve(__dirname, 'scss/withVars.scss');

  // transpile without external variables
  const dstWithoutVars = path.resolve(localTmpDir, 'no_vars.scss.css');
  const css = Theme.transpileSass(src);
  expect(css).toBe('body h1 {\n  color: blue;\n}');

  // transpile with external variables
  const dstWithVars = path.resolve(localTmpDir, 'vars.scss.css');
  const cssWithVars = Theme.transpileSass(src, { color: 'red' });
  expect(cssWithVars).toBe('body h1 {\n  color: red;\n}');
});

it('test scss transpile in FileTheme', () => {
  const locator = 'simple.scss';
  const contextDir = path.resolve(__dirname, 'scss');
  const workspaceDir = localTmpDir;
  const fileTheme = FileTheme.parse(locator, contextDir, workspaceDir);

  fileTheme?.copyTheme(); // and transpile
  const cssPath = path.resolve(workspaceDir, 'simple.css');
  expect(fs.existsSync(cssPath)).toBeTruthy();
  const css = fs.readFileSync(cssPath, 'utf-8');
  expect(css).toBeDefined();
  expect(css).toBe('body h1 {\n  color: blue;\n}');
});

it('test scss transpile in PackageTheme', () => {
  const locator = 'scss';
  const contextDir = __dirname;
  const workspaceDir = localTmpDir;
  const packageTheme = PackageTheme.parse(locator, contextDir, workspaceDir);

  expect(packageTheme).toBeDefined();
  expect(packageTheme?.style).toEqual(['./withVars.scss']);

  packageTheme?.copyTheme();

  const cssPath = path.resolve(
    workspaceDir,
    'themes/packages/themeWithScss',
    'withVars.css',
  );
  expect(fs.existsSync(cssPath)).toBeTruthy();
  const css = fs.readFileSync(cssPath, 'utf-8');
  expect(css).toBeDefined();
  expect(css).toBe('body h1 {\n  color: blue;\n}');
});
