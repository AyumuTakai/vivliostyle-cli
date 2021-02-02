module.exports = {
  title: 'title',
  author: 'author',
  theme: 'https://example.com',
  language: 'ja',
  entry: [
    'manuscript/soda.md',
    {
      path: 'manuscript/sample-html.html',
      title: 'ABCDEF',
      theme: '../themes/debug-theme',
    },
    'manuscript/sample-xhtml.xhtml',
  ],
  output: [
    {
      path: 'variousManuscriptFormat',
      format: 'webbook',
    },
  ],
  workspaceDir: '.vs-variousManuscriptFormat',
};
