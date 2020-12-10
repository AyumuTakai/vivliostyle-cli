import chokidar from 'chokidar';
import program from 'commander';
import puppeteer from 'puppeteer';
import path from 'upath';
import { buildArtifacts } from '../builder';
import {
  CliFlags,
  collectVivliostyleConfig,
  getVivliostyleConfigPath,
  mergeConfig,
} from '../config';
import { getBrokerUrl, launchSourceAndBrokerServer } from '../server';
import {
  debug,
  gracefulError,
  launchBrowser,
  logSuccess,
  startLogging,
  stopLogging,
} from '../util';

export interface PreviewCliFlags extends CliFlags {}

program
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

let timer: NodeJS.Timeout;

preview({
  input: program.args?.[0],
  configPath: program.config,
  outDir: program.outDir,
  outFile: program.outFile,
  theme: program.theme,
  size: program.size,
  title: program.title,
  author: program.author,
  language: program.language,
  verbose: program.verbose,
  timeout: program.timeout,
  sandbox: program.sandbox,
  executableChromium: program.executableChromium,
}).catch(gracefulError);

export default async function preview(cliFlags: PreviewCliFlags) {
  startLogging('Preparing preview');

  const vivliostyleConfigPath = getVivliostyleConfigPath(cliFlags.configPath);
  const vivliostyleConfig = collectVivliostyleConfig(vivliostyleConfigPath);

  const context = vivliostyleConfig
    ? path.dirname(vivliostyleConfigPath)
    : process.cwd();

  const config = await mergeConfig(cliFlags, vivliostyleConfig, context);

  // build artifacts
  const { manifestPath } = await buildArtifacts(config);

  const [source, broker] = await launchSourceAndBrokerServer(config.distDir);

  const url = getBrokerUrl({
    sourceIndex: path.relative(config.distDir, manifestPath),
    sourcePort: source.port,
    brokerPort: broker.port,
  });

  debug(
    `Executing Chromium path: ${
      config.executableChromium || puppeteer.executablePath()
    }`,
  );
  const browser = await launchBrowser({
    headless: false,
    executablePath: config.executableChromium || puppeteer.executablePath(),
    args: [config.sandbox ? '' : '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 0, height: 0 });
  await page.goto(url);

  stopLogging('Up and running ([ctrl+c] to quit)', '🚀');

  function handleChangeEvent(path: string) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      startLogging(`Rebuilding ${path}`);
      // build artifacts
      buildArtifacts(config);
      page.reload();
      logSuccess(`Built ${path}`);
    }, 2000);
  }

  chokidar
    .watch('**', {
      ignored: (p: string) => {
        return /node_modules|\.git/.test(p) || p.startsWith(config.distDir);
      },
      cwd: context,
    })
    .on('all', (event, path) => {
      if (!/\.(md|markdown|html?|css|scss|jpe?g|png|gif|svg)$/i.test(path))
        return;
      handleChangeEvent(path);
    });
}
