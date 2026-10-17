# Building a Large Book in Parallel (Experimental)

Typesetting a book with hundreds of pages takes a long time because the pages are laid out one after another in a single browser. Vivliostyle CLI splits a big book into parts, typesets the parts in parallel processes, and merges the PDFs into one PDF.

This feature is experimental. The speed-up is small for a book of less than about 150 pages, because each part has a fixed cost (starting the process and the server, compiling, and loading the viewer).

## It is on by default

You do not need any setting. `vivliostyle build` works as follows:

1. The first build of a book is a normal build. It also examines the book: the number of the pages of each entry, and whether each entry starts with a named page (the `page` property of CSS, such as a chapter cover). The result is saved in `node_modules/.cache/vivliostyle-cli/` of the project (in the workspace directory if the project has no `node_modules`). A book of less than 150 pages is not examined.
2. From the next build, a book of 150 pages or more that has entries starting with a named page is split before such entries, into parts that have similar numbers of pages, and the parts are built in parallel.

A book with a very long chapter cannot be split well only before named pages. In that case, the book is also split before other entries, in the long chapter. The result is checked: the text of each page and the positions of its lines are compared with the PDF of the build that examined the book (positions that differ by 0.5 pt or less are the same). If they are the same, the entries are remembered as safe to split before, and the check is not made again. If not, they are never used again for the book, and the book is built again without them (this build takes longer, once).

If the book is edited and the number of its pages changes, the parts are typeset again with the right page numbers (see [How it works](#how-it-works)), and the new numbers are saved.

To turn it off, set `parallel: false` in the config file, or use `--jobs 1`.

```js
// vivliostyle.config.js
export default {
  entry: [/* ... */],
  parallel: false,
};
```

The number of the builds that run at the same time is half of the number of the CPU cores (2 to 4) unless you specify it with `parallel.jobs`, or with the `-j` (`--jobs`) option of `vivliostyle build`, which overrides `parallel.jobs`.

```
vivliostyle build -j 8
```

If the book cannot be built in parallel (see [Requirements](#requirements)), the book is built as usual. Vivliostyle CLI tells the reason only when you specified `parallel` or `--jobs`.

## Choosing where to split yourself

To choose the entries that start a part, specify them with `parallel.splitBefore` (the `path` of the entries). The automatic choice is not used then.

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

With the example above, the book is built in two parts: the entries before `chapter-covers/ch02.md`, and the others. The cover and the table of contents are built separately.

## Where to split

The automatic choice splits only before entries that start with a named page, for example, chapter covers. When you choose the entries yourself, choose the ones whose layout does not depend on the preceding pages. If a part starts in the middle of a flow, the layout of its first page can differ slightly from the one of the book built as a whole. It is a good practice to build the book both ways once and compare the PDFs.

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

- The check of the entries that are not known to be safe compares the text and the positions of the lines, but not images and drawings. Remember that the entries once found to be safe are not checked again even if the style of the book is changed later; remove `node_modules/.cache/vivliostyle-cli` (or use `parallel.splitBefore`, which is not checked either) if you change the style so that the layout depends on the preceding pages.

- The tagged structure of the PDF (used for accessibility) is not kept in the merged PDF.
- References to page numbers (`target-counter(..., page)`) work only within a part, except for the table of contents.
- A theme package is installed for each part.
- A part has its own browser context, so it uses more memory than a single build.
