'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
const chalk_1 = __importDefault(require('chalk'));
const commander_1 = __importDefault(require('commander'));
const fs_1 = __importDefault(require('fs'));
const upath_1 = __importDefault(require('upath'));
const util_1 = require('../util');
commander_1.default
  .name('vivliostyle init')
  .description('create vivliostyle config file')
  .option('--title <title>', 'title')
  .option('--author <author>', 'author')
  .option('--language, -l <language>', 'language')
  .option('--size, -s <size>', 'paper size')
  .option('--theme, -t <theme>', 'theme')
  .parse(process.argv);
init({
  title: commander_1.default.title,
  author: commander_1.default.author,
  language: commander_1.default.language,
  size: commander_1.default.size,
  theme: commander_1.default.theme,
}).catch(util_1.gracefulError);
async function init(cliFlags) {
  const vivliostyleConfigPath = upath_1.default.join(
    process.cwd(),
    'vivliostyle.config.js',
  );
  if (fs_1.default.existsSync(vivliostyleConfigPath)) {
    return util_1.log(
      `${chalk_1.default.yellow(
        'vivliostyle.config.js already exists. aborting.',
      )}`,
    );
  }
  // prettier-ignore
  const vivliostyleConfig = `module.exports = {
  title: '${cliFlags.title || 'Principia'}', // populated into 'manifest.json', default to 'title' of the first entry or 'name' in 'package.json'.
  author: '${cliFlags.author || 'Isaac Newton'}', // default to 'author' in 'package.json' or undefined
  language: '${cliFlags.language || 'la'}', // default to 'en'
  size: '${cliFlags.size || 'A4'}',
  theme: '${cliFlags.theme || ''}', // .css or local dir or npm package. default to undefined
  entry: [ // **required field**
    // 'introduction.md', // 'title' is automatically guessed from the file (frontmatter > first heading)
    // {
    //   path: 'epigraph.md',
    //   title: 'おわりに', // title can be overwritten (entry > file),
    //   theme: '@vivliostyle/theme-whatever' // theme can be set indivisually. default to root 'theme'
    // },
    // 'glossary.html' // html is also acceptable
  ], // 'entry' can be 'string' or 'object' if there's only single markdown file
  // entryContext: './manuscripts', // default to '.' (relative to 'vivliostyle.config.js')
  // outFile: './output.pdf', // path to generated pdf file. cannot be used with outDir.
  // outDir: './output', // path to the directory where the generated pdf is located. filename is picked from 'title'. cannot be used with outFile.
  // toc: true, // whether generate and include toc.html or not (does not affect manifest.json), default to 'false'. if 'string' given, use it as a custom toc.html.
  // format: 'pdf', // reserved for future usage. default to 'pdf'.
  // distDir: './build', // default to '.vivliostyle',
};
`;
  fs_1.default.writeFileSync(vivliostyleConfigPath, vivliostyleConfig);
  util_1.log(
    `Successfully created ${chalk_1.default.cyan('vivliostyle.config.js')}`,
  );
}
exports.default = init;
//# sourceMappingURL=init.js.map
