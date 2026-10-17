import * as v from 'valibot';

import { ArticleEntryConfig, type ParsedBuildTask } from '../config/schema.js';
import type { PartSpec } from './parallel-spec.js';

/**
 * Changes a build task as a child process of a parallel build is instructed (see `PartSpec`).
 */
const articleEntry = (file: { path: string; theme?: string[] }) =>
  v.parse(ArticleEntryConfig, file);

export function applyPartSpec(
  task: ParsedBuildTask,
  spec: PartSpec,
): ParsedBuildTask {
  let entry: ParsedBuildTask['entry'];
  if ('range' in spec.entries) {
    const [from, to] = spec.entries.range;
    entry = task.entry.slice(from, to);
  } else if ('files' in spec.entries) {
    entry = spec.entries.files.map((file) => articleEntry(file));
  } else {
    entry = task.entry;
  }

  const result: ParsedBuildTask = {
    ...task,
    entry: [
      ...(spec.leadingFiles ?? []).map((file) => articleEntry(file)),
      ...entry,
    ],
    output: [{ path: spec.output.path, format: spec.output.format }],
    workspaceDir: spec.workspaceDir,
  };
  // The parallel option applies to the parent process only
  delete result.parallel;
  if (spec.withoutTocAndCover) {
    delete result.toc;
    delete result.cover;
  }
  return result;
}

/** The inline options that must not be written to a file. */
export const SECRET_INLINE_OPTIONS = ['proxyUser', 'proxyPass'] as const;

/** Name of the environment variable that hands a secret option over to a child process. */
export const secretEnvName = (
  option: (typeof SECRET_INLINE_OPTIONS)[number],
): string =>
  `VS_CLI_PARALLEL_${option.replaceAll(/[A-Z]/gv, (c) => `_${c}`).toUpperCase()}`;

/** The secret options, to be set in the environment of a child process. */
export function secretEnv(inlineConfig: {
  proxyUser?: string;
  proxyPass?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const option of SECRET_INLINE_OPTIONS) {
    const value = inlineConfig[option];
    if (value !== undefined) {
      env[secretEnvName(option)] = value;
    }
  }
  return env;
}

/** Reads the secret options back from the environment of a child process, and removes them from it. */
export function takeSecretEnv(
  env: NodeJS.ProcessEnv,
): Partial<Record<(typeof SECRET_INLINE_OPTIONS)[number], string>> {
  const result: Partial<
    Record<(typeof SECRET_INLINE_OPTIONS)[number], string>
  > = {};
  for (const option of SECRET_INLINE_OPTIONS) {
    const name = secretEnvName(option);
    if (env[name] !== undefined) {
      result[option] = env[name];
      // oxlint-disable-next-line typescript/no-dynamic-delete -- the secret is removed from the environment
      delete env[name];
    }
  }
  return result;
}

/** The inline options that can be handed to a child process as JSON. */
export function serializeInlineConfig(
  inlineConfig: object,
): Record<string, unknown> {
  const excluded = new Set([
    'signal',
    'logger',
    'stdin',
    'stdout',
    'stderr',
    'output',
    'partSpec',
    'jobs',
    'configData',
    // Secrets are not written to the spec file; they are handed over by the environment
    ...SECRET_INLINE_OPTIONS,
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inlineConfig)) {
    if (
      excluded.has(key) ||
      value === undefined ||
      typeof value === 'function'
    ) {
      continue;
    }
    try {
      JSON.stringify(value);
    } catch {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Orders the parts so that the ones that take longer (judged by the pages of the previous build)
 * come first, and no big part is left for the end. Parts of the same size keep their order.
 * @param bounds the indexes of the entries that start each part, followed by the number of entries
 * @param docPages the number of the pages of each entry, if known
 */
export function orderPartsHeavyFirst(
  parts: readonly number[],
  bounds: readonly number[],
  docPages: readonly (number | undefined)[],
): number[] {
  const pagesOf = (index: number) => {
    let pages = 0;
    for (let i = bounds[index]; i < bounds[index + 1]; i++) {
      pages += docPages[i] ?? 0;
    }
    return pages;
  };
  return parts
    .map((index) => ({ index, pages: pagesOf(index) }))
    .toSorted((a, b) => b.pages - a.pages || a.index - b.index)
    .map(({ index }) => index);
}
