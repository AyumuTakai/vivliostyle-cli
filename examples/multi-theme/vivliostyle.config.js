module.exports = {
  title: 'Draft with the preset theme',
  author: 'Jhon Doe',
  language: 'ja',
  size: 'A5',
  theme: [
    '@vivliostyle/theme-bunko',
    // 'sub-theme.css',
    // 'emojicat',
    // 'emojihand',
    // 'textlint',
    // 'openJTalk',
  ],
  entry: [
    'bunko.md',
    {
      path: './yume.html',
      theme: [
        '@vivliostyle/theme-bunko',
        'sub-theme2.css',
        // 'textlint'
      ],
    },
  ],
  output: 'bunko.pdf',
  workspaceDir: ".vivliostyle",
};
