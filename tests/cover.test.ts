import execa from 'execa';
import fileType from 'file-type';
import fs from 'fs';
import path from 'upath';

const rootPath = path.resolve(__dirname, '..');
const packageJSON = require(path.join(rootPath, 'package.json'));
const cliPath = path.join(rootPath, packageJSON.bin.vivliostyle);
const fixtureRoot = path.resolve(__dirname, 'fixtures/cover');

const localTmpDir = path.join(rootPath, 'tmp');
fs.mkdirSync(localTmpDir, { recursive: true });

function cleanUp(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

function vivliostyleCLI(args: string[]) {
  return execa(cliPath, args, { cwd: fixtureRoot });
}

it('png cover', async () => {
  const outputPath = path.join(localTmpDir, 'test-cover.png.pdf');
  cleanUp(outputPath);

  try {
    const response = await vivliostyleCLI([
      'build',
      '-o',
      outputPath,
      '-c',
      'png.vivliostyle.config.js',
    ]);
    expect(response.stdout).toContain('has been created');
  } catch (err) {
    throw err.stderr;
  }

  // mimetype test
  const type = await fileType.fromFile(outputPath);
  expect(type!.mime).toEqual('application/pdf');
}, 20000);

it('pdf cover', async () => {
  const outputPath = path.join(localTmpDir, 'test-cover.pdf.pdf');
  cleanUp(outputPath);

  try {
    const response = await vivliostyleCLI([
      'build',
      '-o',
      outputPath,
      '-c',
      'pdf.vivliostyle.config.js',
    ]);
    expect(response.stdout).toContain('has been created');
  } catch (err) {
    throw err.stderr;
  }

  // mimetype test
  const type = await fileType.fromFile(outputPath);
  expect(type!.mime).toEqual('application/pdf');
}, 20000);
