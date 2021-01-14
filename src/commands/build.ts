import chalk from 'chalk';
import * as fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import process from 'process';
import shelljs from 'shelljs';
import terminalLink from 'terminal-link';
import path from 'upath';
import { buildArtifacts } from '../builder';
import { collectVivliostyleConfig, mergeConfig } from '../config';
import { buildPDF } from '../pdf';
import {
  gracefulError,
  log,
  startLogging,
  stopLogging,
  useTmpDirectory,
} from '../util';
import { BuildCliFlags, setupBuildParserProgram } from './build.parser';

try {
  const program = setupBuildParserProgram();
  program.parse(process.argv);
  build({
    input: program.args?.[0],
    configPath: program.config,
    targets: program.targets,
    theme: program.theme,
    size: program.size,
    title: program.title,
    author: program.author,
    language: program.language,
    pressReady: program.pressReady,
    verbose: program.verbose,
    timeout: program.timeout,
    sandbox: program.sandbox,
    executableChromium: program.executableChromium,
  }).catch(gracefulError);
} catch (err) {
  gracefulError(err);
}

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

  const loadedConf = collectVivliostyleConfig(cliFlags);
  const { vivliostyleConfig, vivliostyleConfigPath } = loadedConf;
  cliFlags = loadedConf.cliFlags;

  const context = vivliostyleConfig
    ? path.dirname(vivliostyleConfigPath)
    : process.cwd();

  const [tmpDir, clear] = await useTmpDirectory();

  try {
    const config = await mergeConfig(
      cliFlags,
      vivliostyleConfig,
      context,
      tmpDir,
    );

    // build artifacts
    const { manifestPath } = await buildArtifacts(config);

    // generate files
    for (const target of config.outputs) {
      let output: string | null = null;
      if (target.format === 'pdf') {
        output = await buildPDF({
          ...config,
          input: manifestPath,
          output: target.path,
        });
        // 表紙を結合する
        if (config.cover) {
          await mergeCover(config.cover, output);
        }
      } else if (target.format === 'webbook') {
        const silentMode = shelljs.config.silent;
        shelljs.config.silent = true;
        const stderr =
          shelljs.mkdir('-p', target.path).stderr ||
          shelljs.cp('-r', path.join(config.workspaceDir, '*'), target.path)
            .stderr;
        if (stderr) {
          throw new Error(stderr);
        }
        shelljs.config.silent = silentMode;
        output = target.path;
      } else if (target.format === 'pub-manifest') {
        // TODO
      }
      if (output) {
        const formattedOutput = chalk.bold.green(
          path.relative(process.cwd(), output),
        );
        log(
          `\n${terminalLink(formattedOutput, 'file://' + output, {
            fallback: () => formattedOutput,
          })} has been created.`,
        );
      }
    }

    stopLogging('Built successfully.', '🎉');

    process.exit(0);
  } finally {
    clear();
  }
}
