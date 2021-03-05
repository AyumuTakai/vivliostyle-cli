module.exports = {
  title: '複数のテーマを適用する機能',
  author: 'Jhon Doe',
  language: 'ja',
  size: 'A4 landscape',
  theme: [
    "@vivliostyle/theme-slide",
    "./custom-theme"
  ],
  entry: [
    'paper.md',
  ],
  output: 'paper.pdf',
  workspaceDir: ".vivliostyle",
};
