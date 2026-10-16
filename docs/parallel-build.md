# Building a Large Book in Parallel (Experimental)

Typesetting a book with hundreds of pages takes a long time because the pages are laid out one after another in a single browser. Vivliostyle CLI can split the book into parts, typeset the parts in parallel processes, and merge the PDFs into one PDF.

This feature is experimental. The speed-up is small for a book of less than about 150 pages, because each part has a fixed cost (starting the process and the server, compiling, and loading the viewer).

## Usage

Specify the entries that start a part with `parallel.splitBefore` in the config file, and the number of the builds that run at the same time with `parallel.jobs`.

```js
// vivliostyle.config.js
export default {
  entry: [
    'chapter-covers/ch01.md',
    'chapter01/01.md',
    'chapter01/02.md',
    'chapter-covers/ch02.md',
    'chapter02/01.md',
    'chapter02/02.md',
  ],
  toc: true,
  cover: 'cover.png',
  output: 'book.pdf',
  parallel: {
    jobs: 4,
    splitBefore: ['chapter-covers/ch02.md'],
  },
};
```

`splitBefore` takes the `path` of the entries. With the example above, the book is built in two parts: the entries before `chapter-covers/ch02.md`, and the others. The cover and the table of contents are built separately.

The number of jobs can be changed with the `-j` (`--jobs`) option of `vivliostyle build`, which overrides `parallel.jobs`.

```
vivliostyle build -j 8
```

If the book cannot be built in parallel (see [Requirements](#requirements)), Vivliostyle CLI prints the reason and builds the book as usual.

## Choosing where to split

Choose the entries whose layout does not depend on the preceding pages: for example, chapter covers that are always put on a new page with a named page. If a part starts in the middle of a flow, the layout of its first page can differ slightly from the one of the book built as a whole. It is a good practice to build the book both ways once and compare the PDFs.

Split the book into parts of similar numbers of pages. The build time is about that of the biggest part.

## How it works

- Each part is built by a child process of Vivliostyle CLI that uses one shared browser. The page numbers are given to the documents so that they have the numbers they have in the whole book. Page numbers, running footers that use `counter(page)`, and the like are typeset as usual.
- The number of the pages of the preceding parts is taken from the previous build, and it is checked after the build. If the numbers have changed (for example, you edited the manuscripts), only the parts that are affected are typeset again. So **the first build, and a build after the number of pages has changed, take longer**, up to about twice as long as the following builds. The numbers are saved in `node_modules/.cache/vivliostyle-cli/` of the project (in the workspace directory if the project has no `node_modules`).
- The table of contents is generated from the compiled documents, and the page numbers of its links are written as text.
- The PDFs are merged, and the outline (bookmarks), links, and metadata are made for the merged PDF. PDF post-processing options (`preflight`, `cmyk`, etc.) are applied to the merged PDF.

## Requirements

- The config is read from a config file.
- The output is a single PDF, and the render mode is not `docker`.
- The entries do not have `rel`.
- The command is run with the installed `vivliostyle` command (the child processes run `dist/cli.js` of the package).

## Limitations

- The tagged structure of the PDF (used for accessibility) is not kept in the merged PDF.
- References to page numbers (`target-counter(..., page)`) work only within a part, except for the table of contents.
- A theme package is installed for each part.
- A part has its own browser context, so it uses more memory than a single build.
