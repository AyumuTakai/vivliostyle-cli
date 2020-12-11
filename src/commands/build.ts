import chalk from 'chalk';
import program from 'commander';
import * as fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import process from 'process';
import terminalLink from 'terminal-link';
import path from 'upath';
import { buildArtifacts, cleanup } from '../builder';
import {
  CliFlags,
  collectVivliostyleConfig,
  getVivliostyleConfigPath,
  mergeConfig,
  validateTimeoutFlag,
} from '../config';
import { buildPDF } from '../pdf';
import { gracefulError, log, startLogging, stopLogging } from '../util';

export interface BuildCliFlags extends CliFlags {}

program
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
    validateTimeoutFlag,
  )
  .option(
    '--no-sandbox',
    `launch chrome without sandbox. use this option when ECONNREFUSED error occurred.`,
  )
  .option(
    '--executable-chromium <path>',
    'specify a path of executable Chrome (or Chromium) you installed',
  )
  .parse(process.argv);

build({
  input: program.args?.[0],
  configPath: program.config,
  outDir: program.outDir,
  outFile: program.outFile,
  theme: program.theme,
  size: program.size,
  title: program.title,
  author: program.author,
  language: program.language,
  pressReady: program.pressReady,
  verbose: program.verbose,
  distDir: program.distDir,
  timeout: program.timeout,
  sandbox: program.sandbox,
  executableChromium: program.executableChromium,
}).catch(gracefulError);

/**
 * カバーとして指定されたPDFファイルを出力結果のPDFファイルの先頭に結合する
 * @param coverPath カバーとして結合するPDFファイルのパス
 * @param srcPath 出力結果のPDFファイル
 */
async function mergeCover(coverPath: string | undefined, srcPath: string) {
  // 出力結果のPDF
  const sourcePDF = await PDFDocument.load(fs.readFileSync(srcPath));
  if (!sourcePDF) {
    return;
  }
  const firstPage = sourcePDF.getPage(0);
  const width = firstPage.getWidth();
  const height = firstPage.getHeight();
  const mergedPdf = await PDFDocument.create();

  let coverPDF: PDFDocument | null = null;
  if (coverPath?.endsWith('.pdf')) {
    // 指定されたカバーがPDFならそのまま追加
    coverPDF = await PDFDocument.load(fs.readFileSync(coverPath));
  } else if (coverPath?.endsWith('.png')) {
    // .pngなら新規にPDFを生成して画像を貼り付ける
    coverPDF = await PDFDocument.create();
    const page = coverPDF.addPage([width, height]);
    const buf: Buffer = fs.readFileSync(coverPath!);
    const image = await coverPDF?.embedPng(buf);
    page.drawImage(image, { x: 0, y: 0, width: width, height: height });
  }

  if (coverPDF != null) {
    const copiedPagesA = await mergedPdf.copyPages(
      coverPDF,
      coverPDF.getPageIndices(),
    );
    copiedPagesA.forEach((page) => mergedPdf.addPage(page));
    // 空白ページを追加
    mergedPdf.addPage([width, height]);
  }

  const copiedPagesB = await mergedPdf.copyPages(
    sourcePDF,
    sourcePDF.getPageIndices(),
  );

  // 削除対象のページ以外をマージする
  console.log('extract');
  const pdf = require('pdf-extraction');
  function render_page(pageData: any) {
    //check documents https://mozilla.github.io/pdf.js/
    let render_options = {
      //replaces all occurrences of whitespace with standard spaces (0x20). The default value is `false`.
      normalizeWhitespace: false,
      //do not attempt to combine same line TextItem's. The default value is `false`.
      disableCombineTextItems: false,
    };

    return pageData
      .getTextContent(render_options)
      .then(function (textContent: any) {
        let lastY = 0,
          text = '';
        for (let item of textContent.items) {
          //console.log(item.str);
          if (lastY == item.transform[5] || !lastY) {
            text += item.str;
          } else {
            text += '\n' + item.str;
          }
          lastY = item.transform[5];
        }
        if (!(text && text.includes('@DELETE@'))) {
          mergedPdf.addPage(copiedPagesB[pageData.pageIndex]);
        }
        return text;
      });
  }
  let options = {
    pagerender: render_page,
  };
  pdf(fs.readFileSync(srcPath), options);

  const mergedPdfFile = await mergedPdf.save();
  fs.writeFileSync(srcPath, mergedPdfFile);
}

export default async function build(cliFlags: BuildCliFlags) {
  startLogging('Collecting build config');

  const vivliostyleConfigPath = getVivliostyleConfigPath(cliFlags.configPath);
  const vivliostyleConfig = collectVivliostyleConfig(vivliostyleConfigPath);

  const context = vivliostyleConfig
    ? path.dirname(vivliostyleConfigPath)
    : process.cwd();

  const config = await mergeConfig(cliFlags, vivliostyleConfig, context);

  // build artifacts
  cleanup(config.distDir);
  const { manifestPath } = await buildArtifacts(config);

  // generate PDF
  const output = await buildPDF({
    ...config,
    input: manifestPath,
  });

  // 表紙を結合する
  await mergeCover(config.cover, output);

  stopLogging('Built successfully.', '🎉');

  const formattedOutput = chalk.bold.green(
    path.relative(process.cwd(), output),
  );
  log(
    `\n${terminalLink(formattedOutput, 'file://' + output, {
      fallback: () => formattedOutput,
    })} has been created.`,
  );

  // TODO: gracefully exit broker & source server
  process.exit(0);
}
