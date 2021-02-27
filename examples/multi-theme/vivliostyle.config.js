module.exports = {
  title: 'Draft with the preset theme',
  author: 'spring-raining',
  language: 'ja',
  size: 'A5',
  theme: ['@vivliostyle/theme-bunko','sub-theme.css','./emojicat','./emojihand','./textlint'],
  entry: ['bunko.md',
          {
            path: './yume.md',
            theme: ['@vivliostyle/theme-bunko','sub-theme2.css'],
          },
  ],
  output: 'bunko.pdf',
  workspaceDir: ".vivliostyle",
};
