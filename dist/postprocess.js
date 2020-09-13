'use strict';
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        Object.defineProperty(o, k2, {
          enumerable: true,
          get: function () {
            return m[k];
          },
        });
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, 'default', { enumerable: true, value: v });
      }
    : function (o, v) {
        o['default'] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null)
      for (var k in mod)
        if (k !== 'default' && Object.hasOwnProperty.call(mod, k))
          __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
  };
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.PostProcess = void 0;
const fs_1 = __importDefault(require('fs'));
const os_1 = __importDefault(require('os'));
const upath_1 = __importDefault(require('upath'));
const pdf_lib_1 = require('pdf-lib');
const pressReadyModule = __importStar(require('press-ready'));
const uuid_1 = require('uuid');
const util_1 = require('./util');
const prefixes = {
  dcterms: 'http://purl.org/dc/terms/',
  meta: 'http://idpf.org/epub/vocab/package/meta/#',
};
const metaTerms = {
  title: `${prefixes.dcterms}title`,
  creator: `${prefixes.dcterms}creator`,
  description: `${prefixes.dcterms}description`,
  subject: `${prefixes.dcterms}subject`,
  contributor: `${prefixes.dcterms}contributor`,
  language: `${prefixes.dcterms}language`,
  role: `${prefixes.meta}role`,
  created: `${prefixes.meta}created`,
  date: `${prefixes.meta}date`,
};
class PostProcess {
  constructor(document) {
    this.document = document;
  }
  static async load(pdf) {
    const document = await pdf_lib_1.PDFDocument.load(pdf);
    return new PostProcess(document);
  }
  async save(output, { pressReady = false }) {
    const input = pressReady
      ? upath_1.default.join(
          os_1.default.tmpdir(),
          `vivliostyle-cli-${uuid_1.v1()}.pdf`,
        )
      : output;
    const pdf = await this.document.save();
    await fs_1.default.promises.writeFile(input, pdf);
    if (pressReady) {
      util_1.stopLogging('Running press-ready', '🚀');
      await pressReadyModule.build({ input, output });
      util_1.startLogging();
    }
  }
  async metadata(tree) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    this.document.setProducer('Vivliostyle');
    const title =
      (_a = tree[metaTerms.title]) === null || _a === void 0 ? void 0 : _a[0].v;
    if (title) {
      this.document.setTitle(title);
    }
    const author =
      (_c =
        (_b = tree[metaTerms.creator]) === null || _b === void 0
          ? void 0
          : _b.map((item) => item.v)) === null || _c === void 0
        ? void 0
        : _c.join('; ');
    if (author) {
      this.document.setAuthor(author);
    }
    const subject =
      (_d = tree[metaTerms.description]) === null || _d === void 0
        ? void 0
        : _d[0].v;
    if (subject) {
      this.document.setSubject(subject);
    }
    const keywords =
      (_e = tree[metaTerms.subject]) === null || _e === void 0
        ? void 0
        : _e.map((item) => item.v);
    if (keywords) {
      this.document.setKeywords(keywords);
    }
    const creator =
      (_g =
        (_f = tree[metaTerms.contributor]) === null || _f === void 0
          ? void 0
          : _f.find((item) => {
              var _a, _b;
              return (
                ((_b =
                  (_a = item.r) === null || _a === void 0
                    ? void 0
                    : _a[metaTerms.role]) === null || _b === void 0
                  ? void 0
                  : _b[0].v) === 'bkp'
              );
            })) === null || _g === void 0
        ? void 0
        : _g.v;
    if (creator) {
      this.document.setCreator(creator);
    }
    const language =
      (_h = tree[metaTerms.language]) === null || _h === void 0
        ? void 0
        : _h[0].v;
    if (language) {
      this.document.setLanguage(language);
    }
    const creation =
      (_j = tree[metaTerms.created] || tree[metaTerms.date]) === null ||
      _j === void 0
        ? void 0
        : _j[0].v;
    const creationDate = creation && new Date(creation);
    if (creationDate) {
      this.document.setCreationDate(creationDate);
    }
  }
  async toc(items) {
    if (!items || !items.length) {
      return;
    }
    const addRefs = (items, parentRef) =>
      items.map((item) => {
        const ref = this.document.context.nextRef();
        return {
          ...item,
          parentRef,
          ref,
          children: addRefs(item.children, ref),
        };
      });
    const countAll = (items) =>
      items.reduce((sum, item) => sum + countAll(item.children), items.length);
    const addObjectsToPDF = (items) => {
      for (const [i, item] of items.entries()) {
        const child = pdf_lib_1.PDFDict.withContext(this.document.context);
        child.set(
          pdf_lib_1.PDFName.of('Title'),
          pdf_lib_1.PDFHexString.fromText(item.title),
        );
        child.set(pdf_lib_1.PDFName.of('Dest'), pdf_lib_1.PDFName.of(item.id));
        child.set(pdf_lib_1.PDFName.of('Parent'), item.parentRef);
        const prev = items[i - 1];
        if (prev) {
          child.set(pdf_lib_1.PDFName.of('Prev'), prev.ref);
        }
        const next = items[i + 1];
        if (next) {
          child.set(pdf_lib_1.PDFName.of('Next'), next.ref);
        }
        if (item.children.length) {
          child.set(pdf_lib_1.PDFName.of('First'), item.children[0].ref);
          child.set(
            pdf_lib_1.PDFName.of('Last'),
            item.children[item.children.length - 1].ref,
          );
          child.set(
            pdf_lib_1.PDFName.of('Count'),
            pdf_lib_1.PDFNumber.of(countAll(item.children)),
          );
        }
        this.document.context.assign(item.ref, child);
        addObjectsToPDF(item.children);
      }
    };
    const outlineRef = this.document.context.nextRef();
    const itemsWithRefs = addRefs(items, outlineRef);
    addObjectsToPDF(itemsWithRefs);
    const outline = pdf_lib_1.PDFDict.withContext(this.document.context);
    outline.set(pdf_lib_1.PDFName.of('First'), itemsWithRefs[0].ref);
    outline.set(
      pdf_lib_1.PDFName.of('Last'),
      itemsWithRefs[itemsWithRefs.length - 1].ref,
    );
    outline.set(
      pdf_lib_1.PDFName.of('Count'),
      pdf_lib_1.PDFNumber.of(countAll(itemsWithRefs)),
    );
    this.document.context.assign(outlineRef, outline);
    this.document.catalog.set(pdf_lib_1.PDFName.of('Outlines'), outlineRef);
  }
}
exports.PostProcess = PostProcess;
//# sourceMappingURL=postprocess.js.map
