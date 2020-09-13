'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.preview = exports.build = void 0;
const build_1 = __importDefault(require('./commands/build'));
exports.build = build_1.default;
const preview_1 = __importDefault(require('./commands/preview'));
exports.preview = preview_1.default;
//# sourceMappingURL=index.js.map
