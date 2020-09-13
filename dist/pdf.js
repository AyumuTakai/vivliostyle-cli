'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.buildPDF = void 0;
const chalk_1 = __importDefault(require('chalk'));
const fs_1 = __importDefault(require('fs'));
const upath_1 = __importDefault(require('upath'));
const shelljs_1 = __importDefault(require('shelljs'));
const terminal_link_1 = __importDefault(require('terminal-link'));
const url_1 = __importDefault(require('url'));
const postprocess_1 = require('./postprocess');
const server_1 = require('./server');
const util_1 = require('./util');
async function buildPDF({
  input,
  distDir,
  outputPath,
  size,
  executableChromium,
  sandbox,
  verbose,
  timeout,
  pressReady,
  entryContextDir,
  entries,
}) {
  util_1.logUpdate(`Launching build environment`);
  const stat = await util_1.statFile(input);
  const root =
    distDir || (stat.isDirectory() ? input : upath_1.default.dirname(input));
  const sourceIndex = await util_1.findEntryPointFile(input, root);
  const outputFile =
    fs_1.default.existsSync(outputPath) &&
    fs_1.default.statSync(outputPath).isDirectory()
      ? upath_1.default.resolve(outputPath, 'output.pdf')
      : outputPath;
  const outputSize = size;
  const [source, broker] = await server_1.launchSourceAndBrokerServer(root);
  const sourcePort = source.port;
  const brokerPort = broker.port;
  const navigateURL = server_1.getBrokerUrl({
    sourcePort,
    sourceIndex,
    brokerPort,
    outputSize,
  });
  util_1.debug('brokerURL', navigateURL);
  util_1.debug(`Executing Chromium path: ${executableChromium}`);
  const browser = await util_1.launchBrowser({
    headless: true,
    executablePath: executableChromium,
    // Why `--no-sandbox` flag? Running Chrome as root without --no-sandbox is not supported. See https://crbug.com/638180.
    args: [sandbox ? '' : '--no-sandbox'],
  });
  const version = await browser.version();
  util_1.debug(chalk_1.default.green('success'), `version=${version}`);
  util_1.logUpdate('Building pages');
  const page = await browser.newPage();
  page.on('pageerror', (error) => {
    util_1.logError(chalk_1.default.red(error.message));
  });
  page.on('console', (msg) => {
    if (/time slice/.test(msg.text())) return;
    if (!verbose) return;
    util_1.logInfo(msg.text());
  });
  let lastEntry;
  function stringifyEntry(entry) {
    const formattedSourcePath = chalk_1.default.bold.cyan(
      upath_1.default.relative(entryContextDir, entry.source.path),
    );
    return `${terminal_link_1.default(
      formattedSourcePath,
      'file://' + entry.source.path,
      {
        fallback: () => formattedSourcePath,
      },
    )} ${entry.title ? chalk_1.default.gray(entry.title) : ''}`;
  }
  const building = (e) => `${stringifyEntry(e)}`;
  const built = (e) => `${stringifyEntry(e)}`;
  function handleEntry(response) {
    const entry = entries.find(
      (entry) =>
        upath_1.default.relative(distDir, entry.target.path) ===
        url_1.default.parse(response.url()).pathname.substring(1),
    );
    if (entry) {
      if (!lastEntry) {
        lastEntry = entry;
        return util_1.logUpdate(building(entry));
      }
      util_1.logSuccess(built(lastEntry));
      util_1.startLogging(building(entry));
      lastEntry = entry;
    }
  }
  page.on('response', (response) => {
    util_1.debug(
      chalk_1.default.gray('broker:response'),
      chalk_1.default.green(response.status().toString()),
      response.url(),
    );
    handleEntry(response);
    if (300 > response.status() && 200 <= response.status()) return;
    util_1.logError(
      chalk_1.default.red(`${response.status()}`, response.url()),
    );
    util_1.startLogging();
    // debug(chalk.red(`${response.status()}`, response.url()));
  });
  await page.goto(navigateURL, { waitUntil: 'networkidle0' });
  await page.waitFor(() => !!window.coreViewer);
  const metadata = await loadMetadata(page);
  const toc = await loadTOC(page);
  await page.emulateMediaType('print');
  await page.waitForFunction(
    () => window.coreViewer.readyState === 'complete',
    {
      polling: 1000,
      timeout,
    },
  );
  util_1.logSuccess(built(lastEntry));
  util_1.startLogging('Building PDF');
  const pdf = await page.pdf({
    margin: {
      top: 0,
      bottom: 0,
      right: 0,
      left: 0,
    },
    printBackground: true,
    preferCSSPageSize: true,
  });
  await browser.close();
  util_1.logUpdate('Processing PDF');
  shelljs_1.default.mkdir('-p', upath_1.default.dirname(outputFile));
  const post = await postprocess_1.PostProcess.load(pdf);
  await post.metadata(metadata);
  await post.toc(toc);
  await post.save(outputFile, { pressReady });
  return outputFile;
}
exports.buildPDF = buildPDF;
async function loadMetadata(page) {
  return page.evaluate(() => window.coreViewer.getMetadata());
}
// Show and hide the TOC in order to read its contents.
// Chromium needs to see the TOC links in the DOM to add
// the PDF destinations used during postprocessing.
async function loadTOC(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        function listener(payload) {
          if (payload.a !== 'toc') {
            return;
          }
          window.coreViewer.removeListener('done', listener);
          window.coreViewer.showTOC(false);
          resolve(window.coreViewer.getTOC());
        }
        window.coreViewer.addListener('done', listener);
        window.coreViewer.showTOC(true);
      }),
  );
}
//# sourceMappingURL=pdf.js.map
