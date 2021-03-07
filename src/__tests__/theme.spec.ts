import * as fs from 'fs';
import path from 'path';
import { FileTheme, PackageTheme, UriTheme } from '../theme';

const rootPath = path.resolve(__dirname, '../..');
const localTmpDir = path.join(rootPath, 'tmp');
fs.mkdirSync(localTmpDir, { recursive: true });

it('test parse UriTheme', () => {
  const locator = 'http://example.jp';
  const uriTheme = UriTheme.parse(locator);

  expect(uriTheme).toBeDefined();
  const from = '';
  expect(uriTheme?.locatePath(from)).toEqual(['http://example.jp']);
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

// TODO test toc with multi-theme
// TODO test md with multi-theme
// TODO test html with multi-theme
// TODO test package-theme that has style array in multi-theme
