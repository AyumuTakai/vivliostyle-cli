module.exports = {
  title: 'Draft with the preset theme',
  author: 'Jhon Doe',
  language: 'ja',
  size: 'A5',
  theme: [
    '@vivliostyle/theme-bunko',
    // 'sub-theme.css',
    // 'openJTalk',
    // 'textlint',
    // 'emojicat',
    // 'emojihand'
  ],
  entry: [
    'bunko.md',
    {
      path: './yume.md',
      theme: [
        '@vivliostyle/theme-bunko',
        // 'sub-theme2.css',
        // 'textlint'
      ],
    },
  ],
  output: 'bunko.pdf',
  workspaceDir: ".vivliostyle",
};
