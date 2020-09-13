'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
var _a;
Object.defineProperty(exports, '__esModule', { value: true });
const chokidar_1 = __importDefault(require('chokidar'));
const commander_1 = __importDefault(require('commander'));
const upath_1 = __importDefault(require('upath'));
const puppeteer_1 = __importDefault(require('puppeteer'));
const builder_1 = require('../builder');
const config_1 = require('../config');
const server_1 = require('../server');
const util_1 = require('../util');
commander_1.default
  .name('vivliostyle preview')
  .description('launch preview server')
  .arguments('<input>')
  .option('-c, --config <config_file>', 'path to vivliostyle.config.js')
  .option('-t, --theme <theme>', 'theme path or package name')
  .option(
    '-s, --size <size>',
    `output pdf size [Letter]
preset: A5, A4, A3, B5, B4, JIS-B5, JIS-B4, letter, legal, ledger
custom(comma separated): 182mm,257mm or 8.5in,11in`,
  )
  .option('--title <title>', 'title')
  .option('--author <author>', 'author')
  .option('--language <language>', 'language')
  .option('--verbose', 'verbose log output')
  .option(
    '--no-sandbox',
    `launch chrome without sandbox (use this option to avoid ECONNREFUSED error)`,
  )
  .option(
    '--executable-chromium <path>',
    'specify a path of executable Chrome(Chromium) you installed',
  )
  .parse(process.argv);
let timer;
preview({
  input:
    (_a = commander_1.default.args) === null || _a === void 0 ? void 0 : _a[0],
  configPath: commander_1.default.config,
  outDir: commander_1.default.outDir,
  outFile: commander_1.default.outFile,
  theme: commander_1.default.theme,
  size: commander_1.default.size,
  title: commander_1.default.title,
  author: commander_1.default.author,
  language: commander_1.default.language,
  verbose: commander_1.default.verbose,
  timeout: commander_1.default.timeout,
  sandbox: commander_1.default.sandbox,
  executableChromium: commander_1.default.executableChromium,
}).catch(util_1.gracefulError);
async function preview(cliFlags) {
  util_1.startLogging('Preparing preview');
  const vivliostyleConfigPath = config_1.getVivliostyleConfigPath(
    cliFlags.configPath,
  );
  const vivliostyleConfig = config_1.collectVivliostyleConfig(
    vivliostyleConfigPath,
  );
  const context = vivliostyleConfig
    ? upath_1.default.dirname(vivliostyleConfigPath)
    : process.cwd();
  const config = await config_1.mergeConfig(
    cliFlags,
    vivliostyleConfig,
    context,
  );
  // build artifacts
  const { manifestPath } = await builder_1.buildArtifacts(config);
  const [source, broker] = await server_1.launchSourceAndBrokerServer(
    config.distDir,
  );
  const url = server_1.getBrokerUrl({
    sourceIndex: upath_1.default.relative(config.distDir, manifestPath),
    sourcePort: source.port,
    brokerPort: broker.port,
  });
  util_1.debug(
    `Executing Chromium path: ${
      config.executableChromium || puppeteer_1.default.executablePath()
    }`,
  );
  const browser = await util_1.launchBrowser({
    headless: false,
    executablePath:
      config.executableChromium || puppeteer_1.default.executablePath(),
    args: [config.sandbox ? '' : '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 0, height: 0 });
  await page.goto(url);
  util_1.stopLogging('Up and running ([ctrl+c] to quit)', '🚀');
  function handleChangeEvent(path) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      util_1.startLogging(`Rebuilding ${path}`);
      // build artifacts
      builder_1.buildArtifacts(config);
      page.reload();
      util_1.logSuccess(`Built ${path}`);
    }, 2000);
  }
  chokidar_1.default
    .watch('**', {
      ignored: (p) => {
        return /node_modules|\.git/.test(p) || p.startsWith(config.distDir);
      },
      cwd: context,
    })
    .on('all', (event, path) => {
      if (!/\.(md|markdown|html?|css|jpe?g|png|gif|svg)$/i.test(path)) return;
      handleChangeEvent(path);
    });
}
exports.default = preview;
//# sourceMappingURL=preview.js.map
