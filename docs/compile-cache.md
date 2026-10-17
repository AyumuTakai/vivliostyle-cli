# Compile Cache (Experimental)

Vivliostyle CLI compiles the manuscripts (Markdown) into HTML before it typesets them: the document processor (VFM and its plugins) runs, and a plugin such as `rehype-mermaid` may take a long time to convert the diagrams. The compile cache keeps the HTML, and uses it for the manuscripts that have not changed.

The cache is off by default. Turn it on with `compileCache` in the config file, or with `--compile-cache` (`--no-compile-cache` turns it off).

```js
// vivliostyle.config.js
export default {
  entry: [/* ... */],
  compileCache: true,
};
```

```js
export default {
  // ...
  compileCache: {
    // sources that are not cached: paths relative to the entry context, file names, or directories
    exclude: ['colophon.md', 'generated/'],
    // the size of the cache; the oldest files are removed when it is bigger (default: 512MB)
    maxSize: '256MB',
  },
};
```

In the book of 169 pages used for the measurement, the build with the cache took about 20% less time, both for the build in one process (24.3 s to 19.5 s) and for the [build in parallel](./parallel-build.md) (13.6 s to 10.9 s).

## What a cached document depends on

A document is compiled again when any of these changes:

- the source of the document
- the options of the compile: the title, the language, the themes of the entry, the VFM options, and the place of the compiled file in the workspace
- the code of the config: the scripts (`.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`) and JSON files in the directory of the config file (except `node_modules`, directories whose names start with a dot, the workspace, and the directories of the outputs), and the lock file of the project (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, ...), looked for in the directory of the config file and up to three parent directories
- the version of Vivliostyle CLI and of Node.js

The cache is not used, with a warning, when the config is not in a file (the `configData` option of the API), or when there are more than 5,000 files to look at beside the config file.

## When not to use it

The cache does not know what the document processor and the plugins read from outside. Do not use it, or exclude the manuscripts with `exclude`, when the compiled HTML depends on:

- the time (for example, a `vfm.replace` handler that writes the current time)
- environment variables, the network, or files that are not in the directory of the config file
- files that a plugin writes besides the HTML: a document is not cached when files other than its HTML appear in the workspace while it is compiled

## Where the cache is

In `node_modules/.cache/vivliostyle-cli/compile/` of the project. If the project has no `node_modules`, in the cache directory of the OS (`~/.cache/vivliostyle-cli/<hash of the project>/compile/`). To clear the cache, remove the directory.
