import * as v from 'valibot';

import {
  ArticleEntryConfig,
  type ParsedBuildTask,
  ThemeSpecifier,
} from '../config/schema.js';
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
  const withTheme = (
    entry: ParsedBuildTask['entry'][number],
    extraTheme: string[] | undefined,
  ): ParsedBuildTask['entry'][number] => {
    if (!extraTheme || extraTheme.length === 0) {
      return entry;
    }
    // An entry without its own theme uses the theme of the task
    const theme = entry.theme ?? task.theme ?? [];
    return {
      ...entry,
      theme: [...theme, ...v.parse(ThemeSpecifier, extraTheme)],
    };
  };

  let entry: ParsedBuildTask['entry'];
  if ('range' in spec.entries) {
    const [from, to] = spec.entries.range;
    const { extraThemes } = spec.entries;
    entry = task.entry
      .slice(from, to)
      .map((e, i) => withTheme(e, extraThemes?.[i]));
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
