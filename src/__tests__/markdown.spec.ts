import * as fs from 'fs';
import path from 'upath';
import { processMarkdown } from '../markdown';

it('test processMarkdown', () => {
  const filepath = path.resolve(__dirname, 'markdown.md');
  const contents = fs.readFileSync(filepath, 'utf-8');
  const processed = processMarkdown({ path: filepath, contents: contents });
  expect(processed).toMatchSnapshot();
});

// Preprocess move to entry.ts
// it('test processMarkdown with empty preprocess scripts array', () => {
//   const filepath: string = path.resolve(__dirname, 'markdown.md');
//   const preprocess: PreProcess[] = [];
//   const processed: VSFile = processMarkdown(filepath, undefined, preprocess);
//   expect(processed).toMatchSnapshot();
// });

// Preprocess move to entry.ts
// it('test processMarkdown with a preprocess script', () => {
//   const filepath: string = path.resolve(__dirname, 'markdown.md');
//   const preprocess: PreProcess[] = [
//     (filepath: string, contents: string) => {
//       contents = contents.replace(/preprocess/, 'preprocessed');
//       return contents;
//     },
//   ];
//   const processed: VSFile = processMarkdown(filepath, undefined, preprocess);
//   expect(processed).toMatchSnapshot();
// });

it('test processMarkdown with empty replace rule', () => {
  const filepath = path.resolve(__dirname, 'markdown.md');
  const options = {
    replace: [],
  };
  const contents = fs.readFileSync(filepath, 'utf-8');
  const processed = processMarkdown(
    { path: filepath, contents: contents },
    options,
  );
  expect(processed).toMatchSnapshot();
});

it('test processMarkdown with a replace rule', () => {
  const filepath = path.resolve(__dirname, 'markdown.md');
  const options = {
    replace: [
      {
        // 強制改ページ
        test: /replace/,
        match: ([], h: any) => {
          return h('span', 'replaced');
        },
      },
    ],
  };
  const contents = fs.readFileSync(filepath, 'utf-8');
  const processed = processMarkdown(
    { path: filepath, contents: contents },
    options,
  );
  expect(processed).toMatchSnapshot();
});
