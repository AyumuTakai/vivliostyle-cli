#!/usr/bin/env node
'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
const commander_1 = __importDefault(require('commander'));
const fs_1 = __importDefault(require('fs'));
const upath_1 = require('upath');
const resolve_pkg_1 = __importDefault(require('resolve-pkg'));
const util_1 = require('./util');
const { version: cliVersion } = util_1.readJSON(
  upath_1.join(__dirname, '../package.json'),
);
const { version: coreVersion } = JSON.parse(
  fs_1.default.readFileSync(
    resolve_pkg_1.default('@vivliostyle/core', { cwd: __dirname }) +
      '/package.json',
    'utf8',
  ),
);
const version = `cli: ${cliVersion}
core: ${coreVersion}`;
commander_1.default
  .name('vivliostyle')
  .version(version, '-v, --version')
  .command('init', 'create vivliostyle config', {
    executableFile: 'commands/init',
  })
  .command('build', 'build and create PDF file', {
    executableFile: 'commands/build',
  })
  .command('preview', 'launch preview server', {
    executableFile: 'commands/preview',
  })
  .parse(process.argv);
//# sourceMappingURL=cli.js.map
