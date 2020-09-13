'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
var _a;
Object.defineProperty(exports, '__esModule', { value: true });
const chalk_1 = __importDefault(require('chalk'));
const commander_1 = __importDefault(require('commander'));
const upath_1 = __importDefault(require('upath'));
const process_1 = __importDefault(require('process'));
const terminal_link_1 = __importDefault(require('terminal-link'));
const builder_1 = require('../builder');
const config_1 = require('../config');
const pdf_1 = require('../pdf');
const util_1 = require('../util');
commander_1.default
  .name('vivliostyle build')
  .description('build and create PDF file')
  .arguments('<input>')
  .option(
    '-c, --config <config_file>',
    'path to vivliostyle.config.js [vivliostyle.config.js]',
  )
  .option(
    '-o, --out-file <output file>',
    `specify output file path [<title>.pdf]`,
  )
  .option('-d, --out-dir <output directory>', `specify output directory`)
  .option('-t, --theme <theme>', 'theme path or package name')
  .option(
    '-s, --size <size>',
    `output pdf size [Letter]
preset: A5, A4, A3, B5, B4, JIS-B5, JIS-B4, letter, legal, ledger
custom(comma separated): 182mm,257mm or 8.5in,11in`,
  )
  .option(
    '-p, --press-ready',
    `make generated PDF compatible with press ready PDF/X-1a [false]`,
  )
  .option('--title <title>', 'title')
  .option('--author <author>', 'author')
  .option('--language <language>', 'language')
  .option('--verbose', 'verbose log output')
  .option('--dist-dir', 'dist dir [.vivliostyle]')
  .option(
    '--timeout <seconds>',
    `timeout limit for waiting Vivliostyle process [60s]`,
    config_1.validateTimeoutFlag,
  )
  .option(
    '--no-sandbox',
    `launch chrome without sandbox. use this option when ECONNREFUSED error occurred.`,
  )
  .option(
    '--executable-chromium <path>',
    'specify a path of executable Chrome (or Chromium) you installed',
  )
  .parse(process_1.default.argv);
build({
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
  pressReady: commander_1.default.pressReady,
  verbose: commander_1.default.verbose,
  distDir: commander_1.default.distDir,
  timeout: commander_1.default.timeout,
  sandbox: commander_1.default.sandbox,
  executableChromium: commander_1.default.executableChromium,
}).catch(util_1.gracefulError);
async function build(cliFlags) {
  util_1.startLogging('Collecting build config');
  const vivliostyleConfigPath = config_1.getVivliostyleConfigPath(
    cliFlags.configPath,
  );
  const vivliostyleConfig = config_1.collectVivliostyleConfig(
    vivliostyleConfigPath,
  );
  const context = vivliostyleConfig
    ? upath_1.default.dirname(vivliostyleConfigPath)
    : process_1.default.cwd();
  const config = await config_1.mergeConfig(
    cliFlags,
    vivliostyleConfig,
    context,
  );
  // build artifacts
  builder_1.cleanup(config.distDir);
  const { manifestPath } = await builder_1.buildArtifacts(config);
  // generate PDF
  const output = await pdf_1.buildPDF({
    ...config,
    input: manifestPath,
  });
  util_1.stopLogging('Built successfully.', '🎉');
  const formattedOutput = chalk_1.default.bold.green(
    upath_1.default.relative(process_1.default.cwd(), output),
  );
  util_1.log(
    `\n${terminal_link_1.default(formattedOutput, 'file://' + output, {
      fallback: () => formattedOutput,
    })} has been created.`,
  );
  // TODO: gracefully exit broker & source server
  process_1.default.exit(0);
}
exports.default = build;
//# sourceMappingURL=build.js.map
