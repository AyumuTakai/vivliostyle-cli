module.exports = {
  title: 'book', // populated into `manifest.json`, default to `title` of the first entry or `name` in `package.json`.
  author: 'Author Name <author@example.com>', // default to `author` in `package.json` or undefined.
  language: 'ja', // default to `en`.
  size: 'A5', // paper size.
  theme: './theme', // .css or local dir or npm package. default to undefined.
  entry: ['./index.md'], // `entry` can be `string` or `object` if there's only single markdown file.
};
