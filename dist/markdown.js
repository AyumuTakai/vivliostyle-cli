'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.processMarkdown = void 0;
const vfm_1 = require('@vivliostyle/vfm');
const fs_1 = __importDefault(require('fs'));
const vfile_1 = __importDefault(require('vfile'));
function processMarkdown(filepath, options = {}) {
  const vfm = vfm_1.VFM(options);
  const processed = vfm.processSync(
    vfile_1.default({
      path: filepath,
      contents: fs_1.default.readFileSync(filepath, 'utf8'),
    }),
  );
  return processed;
}
exports.processMarkdown = processMarkdown;
//# sourceMappingURL=markdown.js.map
