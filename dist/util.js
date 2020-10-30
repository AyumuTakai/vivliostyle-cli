'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.launchBrowser = exports.findEntryPointFile = exports.findAvailablePort = exports.statFile = exports.readJSON = exports.gracefulError = exports.logInfo = exports.logError = exports.logSuccess = exports.logUpdate = exports.log = exports.stopLogging = exports.startLogging = exports.debug = void 0;
const chalk_1 = __importDefault(require('chalk'));
const debug_1 = __importDefault(require('debug'));
const fs_1 = __importDefault(require('fs'));
const ora_1 = __importDefault(require('ora'));
const upath_1 = __importDefault(require('upath'));
const portfinder_1 = __importDefault(require('portfinder'));
const puppeteer_1 = __importDefault(require('puppeteer'));
const util_1 = __importDefault(require('util'));
exports.debug = debug_1.default('vs-cli');
const ora = ora_1.default({ color: 'blue', spinner: 'circle' });
function startLogging(text) {
  ora.start(text);
}
exports.startLogging = startLogging;
function stopLogging(text, symbol) {
  if (!text) {
    ora.stop();
    return;
  }
  ora.stopAndPersist({ text, symbol });
}
exports.stopLogging = stopLogging;
function log(...obj) {
  console.log(...obj);
}
exports.log = log;
function logUpdate(...obj) {
  ora.text = obj.join(' ');
}
exports.logUpdate = logUpdate;
function logSuccess(...obj) {
  ora.succeed(obj.join(' '));
}
exports.logSuccess = logSuccess;
function logError(...obj) {
  ora.fail(obj.join(' '));
}
exports.logError = logError;
function logInfo(...obj) {
  ora.info(obj.join(' '));
}
exports.logInfo = logInfo;
function gracefulError(err) {
  const message = `${chalk_1.default.red.bold('Error:')} ${err.message}`;
  if (ora.isSpinning) {
    ora.fail(message);
  } else {
    console.error(message);
  }
  console.log(
    chalk_1.default.gray(`
If you think this is a bug, please report at https://github.com/vivliostyle/vivliostyle-cli/issues`),
  );
  process.exit(1);
}
exports.gracefulError = gracefulError;
function readJSON(path) {
  try {
    return JSON.parse(fs_1.default.readFileSync(path, 'utf8'));
  } catch (err) {
    return undefined;
  }
}
exports.readJSON = readJSON;
async function statFile(filePath) {
  try {
    return util_1.default.promisify(fs_1.default.stat)(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Specified input doesn't exists: ${filePath}`);
    }
    throw err;
  }
}
exports.statFile = statFile;
function findAvailablePort() {
  portfinder_1.default.basePort = 13000;
  return portfinder_1.default.getPortPromise();
}
exports.findAvailablePort = findAvailablePort;
async function findEntryPointFile(target, root) {
  const stat = fs_1.default.statSync(target);
  if (!stat.isDirectory()) {
    return upath_1.default.relative(root, target);
  }
  const files = fs_1.default.readdirSync(target);
  const index = [
    'index.html',
    'index.htm',
    'index.xhtml',
    'index.xht',
  ].find((n) => files.includes(n));
  if (index) {
    return upath_1.default.relative(
      root,
      upath_1.default.resolve(target, index),
    );
  }
  // give up finding entrypoint
  return upath_1.default.relative(root, target);
}
exports.findEntryPointFile = findEntryPointFile;
async function launchBrowser(options) {
  // process listener of puppeteer won't handle signal
  // because it doesn't support subprocess which is spawned by CLI
  const browser = await puppeteer_1.default.launch({
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    ...options,
  });
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
    process.on(sig, () => {
      browser.close();
      process.exit(1);
    });
  });
  return browser;
}
exports.launchBrowser = launchBrowser;
//# sourceMappingURL=util.js.map
