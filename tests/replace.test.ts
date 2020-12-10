import execa from 'execa';
import fileType from 'file-type';
import fs from 'fs';
import path from 'upath';

const rootPath = path.resolve(__dirname, '..');
const packageJSON = require(path.join(rootPath, 'package.json'));
const cliPath = path.join(rootPath, packageJSON.bin.vivliostyle);
const fixtureRoot = path.resolve(__dirname, 'fixtures/replace');

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

it('replace', async () => {
  const outputPath = path.join(localTmpDir, 'test-replace.pdf');
  cleanUp(outputPath);

  try {
    const response = await vivliostyleCLI(['build', '-o', outputPath]);
    expect(response.stdout).toContain('has been created');
  } catch (err) {
    throw err.stderr;
  }

  // mimetype test
  const type = await fileType.fromFile(outputPath);
  expect(type!.mime).toEqual('application/pdf');
}, 20000);
