import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import terminalLink from 'terminal-link';
import upath from 'upath';
import { type PreviewServer, build as viteBuild } from 'vite';
import { cyan, gray } from 'yoctocolors';

import { setupConfigFromFlags } from '../commands/cli-flags.js';
import { loadVivliostyleConfig, warnDeprecatedConfig } from '../config/load.js';
import { mergeConfig, mergeInlineConfig } from '../config/merge.js';
import { isWebPubConfig, resolveTaskConfig } from '../config/resolve.js';
import type { ParsedVivliostyleInlineConfig } from '../config/schema.js';
import { resolveViteConfig } from '../config/vite.js';
import { buildPDFWithContainer } from '../container.js';
import { isUnicodeSupported, Logger, randomBookSymbol } from '../logger.js';
import { buildPDF } from '../output/pdf.js';
import { buildWebPublication } from '../output/webbook.js';
import { copyAssets } from '../processor/asset.js';
import {
  createCompileCache,
  setCompileCache,
} from '../processor/compile-cache.js';
import {
  cleanupWorkspace,
  compile,
  prepareThemeDirectory,
} from '../processor/compile.js';
import { validateThemeCssDependencies } from '../processor/css.js';
import { createViteServer, generateCmykReserveMap } from '../server.js';
import { cwd, runCleanupHandlers } from '../util.js';
import { tryParallelBuild } from './parallel-build.js';
import { defaultJobs } from './parallel-layout.js';
import { applyPartSpec, takeSecretEnv } from './parallel-part.js';
import { readPartSpec, setPartSpec } from './parallel-spec.js';

export async function build(
  givenInlineConfig: ParsedVivliostyleInlineConfig,
  { containerForkMode = false }: { containerForkMode?: boolean } = {},
): Promise<void> {
  // A child process of a parallel build does what the parent process tells (see parallel-spec.ts)
  const partSpec = givenInlineConfig.partSpec
    ? readPartSpec(givenInlineConfig.partSpec)
    : undefined;
  setPartSpec(partSpec);
  const inlineConfig: ParsedVivliostyleInlineConfig = partSpec
    ? {
        ...givenInlineConfig,
        ...partSpec.inlineConfig,
        ...takeSecretEnv(process.env),
      }
    : givenInlineConfig;
  Logger.setLogOptions({ ...inlineConfig, containerForkMode });
  if (containerForkMode) {
    Logger.setLogPrefix(gray('[Docker]'));
  }
  Logger.debug('build > inlineConfig %O', inlineConfig);

  const loadedConfig = await loadVivliostyleConfig(inlineConfig);
  let vivliostyleConfig = loadedConfig ?? setupConfigFromFlags(inlineConfig);
  warnDeprecatedConfig(vivliostyleConfig, inlineConfig);
  vivliostyleConfig = mergeInlineConfig(vivliostyleConfig, {
    ...inlineConfig,
    quick: false,
  });
  if (partSpec) {
    vivliostyleConfig = {
      ...vivliostyleConfig,
      tasks: vivliostyleConfig.tasks.map((task) =>
        applyPartSpec(task, partSpec),
      ),
    };
  }
  const { inlineOptions } = vivliostyleConfig;
  Logger.debug('build > vivliostyleConfig %O', vivliostyleConfig);

  for (const [i, task] of vivliostyleConfig.tasks.entries()) {
    using _ = Logger.startLogging('Start building');

    let config = resolveTaskConfig(task, inlineOptions);
    Logger.debug('build > config %O', config);

    const logBuilt = (output: string) => {
      const formattedOutput = cyan(
        upath.relative(inlineConfig.cwd ?? cwd, output),
      );
      Logger.logSuccess(
        `Finished building ${terminalLink(
          formattedOutput,
          pathToFileURL(output).href,
          {
            fallback: () => formattedOutput,
          },
        )}`,
      );
    };

    // Build the book in parts, in parallel processes, unless it is turned off. If the book has not been
    // examined yet, it is examined by this build, which is not parallel (see `learn` below).
    let learn = false;
    const parallelOptions = task.parallel === false ? undefined : task.parallel;
    const requestedJobs = inlineConfig.jobs ?? parallelOptions?.jobs;
    if (
      task.parallel !== false &&
      (requestedJobs === undefined || requestedJobs > 1) &&
      !partSpec &&
      !containerForkMode
    ) {
      const options = {
        task,
        config,
        inlineConfig,
        hasConfigFile: loadedConfig !== undefined && loadedConfig !== null,
        jobs: requestedJobs ?? defaultJobs(),
        explicit: requestedJobs !== undefined || parallelOptions !== undefined,
      };
      const result = await tryParallelBuild(options);
      if ('output' in result) {
        logBuilt(result.output);
        continue;
      }
      if (!result.silent) {
        Logger.logWarn(`The book is not built in parallel. ${result.reason}`);
      }
      learn = result.learn === true;
    }

    setCompileCache(createCompileCache({ task, config, inlineConfig }));

    const viteConfig = await resolveViteConfig({
      ...config,
      mode: 'build',
    });

    let server: PreviewServer | undefined;
    if (!containerForkMode) {
      // build dependents first
      Logger.debug('build > viteConfig.configFile %s', viteConfig.configFile);
      if (viteConfig.configFile && typeof config.serverRootDir === 'string') {
        using _ = Logger.suspendLogging('Building Vite project');
        await viteBuild({
          configFile: viteConfig.configFile,
          root: config.serverRootDir,
        });
      }

      if (!inlineConfig.disableServerStartup) {
        server = await createViteServer({
          config,
          viteConfig,
          inlineConfig,
          mode: 'build',
        });

        const addressInfo = server.httpServer?.address();
        if (addressInfo && typeof addressInfo !== 'string') {
          const actualPort = addressInfo.port;
          vivliostyleConfig = mergeConfig(vivliostyleConfig, {
            temporaryFilePrefix: config.temporaryFilePrefix,
            server: {
              ...server.config.preview,
              port: actualPort,
            },
          });
          config = resolveTaskConfig(
            vivliostyleConfig.tasks[i],
            vivliostyleConfig.inlineOptions,
          );
        }
      }

      // build artifacts
      if (isWebPubConfig(config)) {
        await cleanupWorkspace(config);
        await prepareThemeDirectory(config, inlineConfig.signal);
        await validateThemeCssDependencies(config);
        await compile(config);
        if (partSpec?.compiledMark) {
          fs.writeFileSync(partSpec.compiledMark, '');
        }
        await copyAssets(config);
      }

      // Write CMYK reserve map if configured
      generateCmykReserveMap(config);
    }

    // generate files
    for (const target of config.outputs) {
      let output: string | null = null;
      const { format } = target;
      if (format === 'pdf') {
        if (!containerForkMode && target.renderMode === 'docker') {
          output = await buildPDFWithContainer({
            target,
            config,
            inlineConfig,
          });
        } else {
          output = await buildPDF({
            target,
            config,
            signal: inlineConfig.signal,
            learn,
          });
        }
      } else if (format === 'webpub' || format === 'epub') {
        output = await buildWebPublication({ target, config });
      }
      if (output && !containerForkMode) {
        logBuilt(output);
      }
    }

    await server?.close();
  }

  await runCleanupHandlers();
  if (!containerForkMode) {
    const num = vivliostyleConfig.tasks.flatMap((t) => t.output ?? []).length;
    const symbol = isUnicodeSupported
      ? `${num > 1 ? '📚' : randomBookSymbol} `
      : '';
    Logger.log(`${symbol}Built successfully!`);
  }
}
