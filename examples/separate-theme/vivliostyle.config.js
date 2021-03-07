module.exports = {
  title: 'Draft with the separate theme',
  author: 'John Doe',
  language: 'ja',
  size: 'A4',
  // theme: ['A4book.css','2column.css',/*'check.css'*/],
  entry: [
    {
      path:'cover.md',
      theme: [
        'A4book.css',
        'cover.css'
      ],
    },
    {
      path:'bunko.md',
      theme: [
        'A4book.css',
        'startpage.css',
        '2column.css',
      ],
    },
    {
      path:'yume.md',
      theme: [
        'A4book.css',
        '2column.css'
      ],
    }
  ],
  output: 'book.pdf',
  workspaceDir: '.vivliostyle',
};
