module.exports = {
  title: 'Draft with the separate theme',
  author: 'Jhon Doe',
  language: 'ja',
  size: 'A4',
  // theme: ['A4book.css','2column.css',/*'check.css'*/],
  entry: [
    {
      path:'cover.md',
      theme: ['A4book.css','cover.css'],
    },
    {
      path:'bunko.md',
      theme: ['A4book.css','2column.css','startpage.css'],
    },
    {
      path:'yume.md',
      theme: ['A4book.css','2column.css'],
    }
  ],
  output: 'book.pdf',
};
