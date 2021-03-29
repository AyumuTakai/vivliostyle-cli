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

const fileExistsSync = (file: string | undefined) => {
  if (!file) throw new Error('invalid filepath');
  try {
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (err) {
    return false;
  }
};

const rmDirRecursive = (path: string) => {
  if (!fs.existsSync(path)) return;
  fs.readdirSync(path).forEach((file: string, index: number) => {
    const curPath = path + '/' + file;
    if (fs.lstatSync(curPath).isDirectory()) {
      // recurse
      rmDirRecursive(curPath);
    } else {
      // delete file
      fs.unlinkSync(curPath);
    }
  });
  fs.rmdirSync(path);
};

/*
 *  UriTheme class
 */

it('test UriTheme', () => {
  const locator = 'http://example.jp'; //  accept uri begins 'http://' or 'https://'
  const uriTheme = UriTheme.parse(locator);

  expect(uriTheme?.type).toEqual('uri');

  const from = 'anywhere';
  expect(uriTheme?.locateThemePath(from)).toEqual(['http://example.jp']);
  expect(uriTheme?.location).toEqual('http://example.jp');
  expect(uriTheme?.name).toEqual('example.jp');
  // expect(uriTheme?.destination).toBeUndefined(); // UriTheme has no destination property
  uriTheme?.copyTheme(); // do nothing

  // scripts
  expect(uriTheme?.scripts).toBeUndefined(); // script file path
  expect(uriTheme?.preprocess).toBeUndefined();
  expect(uriTheme?.replaces).toStrictEqual([]); // empty ReplaceRule[]
});

it('test UriTheme with invalid locator', () => {
  const locator = 'not_uri_string';
  const uriTheme = UriTheme.parse(locator);
  expect(uriTheme).toBeUndefined();
});

/*
 *  FileTheme class
 */

it('test FileTheme', () => {
  const locator = 'style.css';
  const contextDir = __dirname;
  const workspaceDir = path.join(localTmpDir, '/fileTheme/dst/');
  const fileTheme = FileTheme.parse(locator, contextDir, workspaceDir);

  expect(fileTheme?.type).toEqual('file');

  const from = process.cwd();
  expect(fileTheme?.locateThemePath(from)).toEqual([
    'tmp/fileTheme/dst/style.css',
  ]); // cwd/tmp/fileTheme/dst/style.css
  expect(fileTheme?.location).toBe(path.join(__dirname, 'style.css'));
  expect(fileTheme?.name).toEqual('style.css');
  expect(fileTheme?.destination).toBe(
    path.join(localTmpDir, '/fileTheme/dst/style.css'),
  );
  expect(fileExistsSync(fileTheme?.destination)).toBeFalsy(); // cwd/tmp/fileTheme/dst/style.css is not exists
  fileTheme?.copyTheme();
  expect(fileExistsSync(fileTheme?.destination)).toBeTruthy(); // cwd/tmp/fileTheme/dst/style.css is exists

  // scripts
  expect(fileTheme?.scripts).toBeUndefined(); // script file path
  expect(fileTheme?.preprocess).toBeUndefined();
  expect(fileTheme?.replaces).toStrictEqual([]); // empty ReplaceRule[]
});

it('test FileTheme with invalid locator', () => {
  const locator = 'invalid/file/path';
  const fileTheme = FileTheme.parse(locator, '', '');
  expect(fileTheme).toBeDefined(); // 存在しないパスを指定してもエラーになることはない
  // TODO: 間違ったファイルパスを指定された場合はどこでエラーになるか調べる。
  //  parseした時点でファイルが存在しなければエラーにしたほうが良い?
  //  もしかしたらcssファイルをスクリプトで生成することがあるかも?
  //  単純にundefinedを返すだけだとThemeManager.parseで問題になりそう。
});

/*
 * PackageTheme class
 */

it('test PackageTheme', () => {
  const locator = '@vivliostyle/theme-bunko';
  const contextDir = './examples/theme-preset';
  const workspaceDir = './tmp';
  const packageTheme = PackageTheme.parse(locator, contextDir, workspaceDir);
  const from = process.cwd();

  if (
    fileExistsSync(
      path.join(localTmpDir, 'themes/packages/@vivliostyle/theme-bunko'),
    )
  ) {
    rmDirRecursive(
      path.join(localTmpDir, 'themes/packages/@vivliostyle/theme-bunko'),
    );
  }
  expect(packageTheme).toBeDefined();
  expect(packageTheme?.style).toEqual(['./theme.css']);
  expect(packageTheme?.locateThemePath(from)).toEqual([
    'tmp/themes/packages/@vivliostyle/theme-bunko/theme.css',
  ]); // cwd/tmp/themes/packages/@vivliostyle/theme-bunko/theme.css
  expect(packageTheme?.location).toBe(
    path.join(
      process.cwd(),
      'examples/theme-preset/node_modules/@vivliostyle/theme-bunko',
    ),
  );
  expect(packageTheme?.type).toEqual('package');
  expect(packageTheme?.name).toEqual('@vivliostyle/theme-bunko');
  expect(packageTheme?.destination).toBe(
    'tmp/themes/packages/@vivliostyle/theme-bunko',
  );
  expect(fileExistsSync(packageTheme?.destination)).toBeFalsy(); // cwd/tmp/themes/packages/@vivliostyle/theme-bunko is not exists
  packageTheme?.copyTheme();
  expect(fileExistsSync(packageTheme?.destination)).toBeTruthy(); // cwd/tmp/themes/packages/@vivliostyle/theme-bunko is exists
  expect(fileExistsSync(path.join(packageTheme!.destination, 'theme.css')));

  // scripts
  expect(packageTheme?.scripts).toBeUndefined(); // script file path
  expect(packageTheme?.preprocess).toBeUndefined();
  expect(packageTheme?.replaces).toStrictEqual([]); // empty ReplaceRule[]

  // package has array of style
  const locator2 = './theme_ms';
  const contextDir2 = __dirname;
  const packageTheme2 = PackageTheme.parse(locator2, contextDir2, workspaceDir);

  expect(packageTheme2).toBeDefined();
  expect(packageTheme2?.style).toEqual(['theme.css', 'theme2.css']);
});

/*
 * ThemeManager class
 */

it('test ThemeManager', () => {
  const workspaceDir: string = './tmp';
  const contextDir: string = './examples/theme-preset';

  const themes = ThemeManager.parseThemes(
    ['http://example.com', 'style.css', '@vivliostyle/theme-bunko'],
    contextDir,
    workspaceDir,
  );

  const uriTheme = themes[0];
  expect(uriTheme?.type).toBe('uri');
  const fileTheme = themes[1];
  expect(fileTheme?.type).toBe('file');
  const packageTheme = themes[2];
  expect(packageTheme?.type).toBe('package');
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
  expect(packageTheme?.replaces.length).toBe(1);
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
