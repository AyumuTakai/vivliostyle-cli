import { FileTheme, PackageTheme, ThemeManager, UriTheme } from '../theme';

it('test parse UriTheme', () => {
  const locator = 'http://example.jp';
  const uriTheme = UriTheme.parse(locator);

  expect(uriTheme).toBeDefined();
});

it('test parse FileTheme', () => {
  const locator = 'style.css';
  const contextDir = './';
  const workspaceDir = './';
  const fileTheme = FileTheme.parse(locator, contextDir, workspaceDir);

  expect(fileTheme).toBeDefined();
});

it('test parse PackageTheme', () => {
  const locator = '@vivliostyle/theme-bunko';
  const contextDir = './examples/theme-preset';
  const workspaceDir = './tmp';
  const packageTheme = PackageTheme.parse(locator, contextDir, workspaceDir);

  expect(packageTheme).toBeDefined();
  expect(packageTheme?.style).toBe('./theme.css');
});

it('test ThemeManager', () => {
  const themeManager = new ThemeManager();

  expect(themeManager).toBeDefined();
});

it('test import preprocess scripts', () => {
  const locator = './textlint';
  const contextDir = './examples/multi-theme';
  const workspaceDir = './tmp';
  const packageTheme = PackageTheme.parse(locator, contextDir, workspaceDir);

  expect(packageTheme).toBeDefined();
  expect(packageTheme?.scripts).toBe('scripts.js');
});
