'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.launchSourceServer = exports.launchBrokerServer = exports.launchSourceAndBrokerServer = exports.startEndpoint = exports.getBrokerUrl = void 0;
const fs_1 = __importDefault(require('fs'));
const http_1 = __importDefault(require('http'));
const upath_1 = __importDefault(require('upath'));
const serve_handler_1 = __importDefault(require('serve-handler'));
const url_1 = __importDefault(require('url'));
const util_1 = require('./util');
function getBrokerUrl({
  sourcePort,
  sourceIndex,
  brokerPort,
  loadMode = 'book',
  outputSize,
}) {
  const sourceURL = url_1.default.format({
    protocol: 'http',
    hostname: 'localhost',
    port: sourcePort,
    pathname: sourceIndex,
  });
  return url_1.default.format({
    protocol: 'http',
    hostname: 'localhost',
    port: brokerPort,
    pathname: '/broker/index.html',
    query: {
      render: sourceURL,
      loadMode,
      ...outputSize,
    },
  });
}
exports.getBrokerUrl = getBrokerUrl;
function startEndpoint({ root, before = [] }) {
  const serve = (req, res) =>
    serve_handler_1.default(req, res, {
      public: root,
      cleanUrls: false,
      directoryListing: false,
      headers: [
        {
          source: '**',
          headers: [
            {
              key: 'access-control-allow-headers',
              value: 'Origin, X-Requested-With, Content-Type, Accept, Range',
            },
            {
              key: 'access-control-allow-origin',
              value: '*',
            },
            {
              key: 'cache-control',
              value: 'no-cache, no-store, must-revalidate',
            },
          ],
        },
      ],
    });
  const listener = before.reduceRight(
    (prv, cur) => (req, res) => cur(req, res, () => prv(req, res)),
    serve,
  );
  return http_1.default.createServer(listener);
}
exports.startEndpoint = startEndpoint;
async function launchSourceAndBrokerServer(root) {
  try {
    const source = await launchSourceServer(root);
    const broker = await launchBrokerServer().catch((e) => {
      source.server.close();
      throw e;
    });
    return [source, broker];
  } catch (e) {
    throw e;
  }
}
exports.launchSourceAndBrokerServer = launchSourceAndBrokerServer;
function launchBrokerServer() {
  return new Promise(async (resolve) => {
    const port = await util_1.findAvailablePort();
    util_1.debug(`Launching broker server... http://localhost:${port}`);
    const beforeHook = async (req, res, next) => {
      // Provide node_modules
      if (req.url && req.url.startsWith('/node_modules')) {
        const pathName = url_1.default.parse(req.url).pathname;
        const moduleName = pathName.substr(14).replace('..', '');
        const basePathCandidates = require.resolve.paths(moduleName) || [];
        for (const basePath of basePathCandidates) {
          try {
            const resolvedPath = upath_1.default.resolve(basePath, moduleName);
            await fs_1.default.promises.access(resolvedPath);
            const stream = fs_1.default.createReadStream(resolvedPath);
            stream.pipe(res); // send module to client
            return;
          } catch (e) {
            if (e.code === 'ENOENT') {
              continue;
            } else {
              throw e;
            }
          }
        }
      }
      next(); // module not found
    };
    const server = startEndpoint({
      root: upath_1.default.resolve(__dirname, '..'),
      before: [beforeHook],
    });
    server.listen(port, 'localhost', () => {
      ['exit', 'SIGNIT', 'SIGTERM'].forEach((sig) => {
        process.on(sig, () => {
          server.close();
        });
      });
      resolve({ server, port });
    });
  });
}
exports.launchBrokerServer = launchBrokerServer;
function launchSourceServer(root) {
  return new Promise(async (resolve) => {
    const port = await util_1.findAvailablePort();
    util_1.debug(`Launching source server... http://localhost:${port}`);
    const server = startEndpoint({ root });
    server.listen(port, 'localhost', () => {
      ['exit', 'SIGNIT', 'SIGTERM'].forEach((sig) => {
        process.on(sig, () => {
          server.close();
        });
      });
      resolve({ server, port });
    });
  });
}
exports.launchSourceServer = launchSourceServer;
//# sourceMappingURL=server.js.map
