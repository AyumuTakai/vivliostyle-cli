module.exports = {
  title: 'Draft with the preset theme',
  author: 'John Doe',
  language: 'ja',
  size: 'A5',
  theme: [
    '@vivliostyle/theme-bunko',
    'sub-theme.css',
    '@vivliostyle/extends-emoji-cat',
    '@vivliostyle/extends-emoji-hand',
    '@vivliostyle/extends-textlint',
    '@vivliostyle/extends-openjtalk',
  ],
  entry: [
    'bunko.md',
    {
      path: './yume.md',
      theme: [
        '@vivliostyle/theme-bunko',
        'sub-theme2.css',
        '@vivliostyle/extends-textlint',
      ],
    },
    {
      path: './chart.md',
      theme: [
        '@vivliostyle/theme-bunko',
        '@vivliostyle/extends-chart',
      ]
    }
  ],
  output: 'bunko.pdf',
  workspaceDir: ".vivliostyle",
};
