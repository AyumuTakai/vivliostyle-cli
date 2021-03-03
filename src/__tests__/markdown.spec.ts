import path from 'upath';
import { PreProcess, processMarkdown, VSFile } from '../markdown';

it('test processMarkdown', () => {
  const filepath = path.resolve(__dirname, 'markdown.md');
  const processed = processMarkdown(filepath);
  expect(processed).toMatchSnapshot();
});

it('test processMarkdown with empty preprocess scripts array', () => {
  const filepath: string = path.resolve(__dirname, 'markdown.md');
  const preprocess: PreProcess[] = [];
  const processed: VSFile = processMarkdown(filepath, undefined, preprocess);
  expect(processed).toMatchSnapshot();
});

it('test processMarkdown with a preprocess script', () => {
  const filepath: string = path.resolve(__dirname, 'markdown.md');
  const preprocess: PreProcess[] = [
    (filepath: string, contents: string) => {
      contents = contents.replace(/preprocess/, 'preprocessed');
      return contents;
    },
  ];
  const processed: VSFile = processMarkdown(filepath, undefined, preprocess);
  expect(processed).toMatchSnapshot();
});

it('test processMarkdown with empty replace rule', () => {
  const filepath = path.resolve(__dirname, 'markdown.md');
  const options = {
    replace: [],
  };
  const processed = processMarkdown(filepath, options);
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
  const processed = processMarkdown(filepath, options);
  expect(processed).toMatchSnapshot();
});
