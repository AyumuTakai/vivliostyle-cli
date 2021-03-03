exports.replace = [
  {
    // 強制改ページ
    test: /\[newpage]/g,
    match: ([], h) => {
      return h('div', {
        style: 'break-before: page;height: 0;margin: 0;padding: 0;',
      });
    },
  },
  {
    test: /\[TODO:(.+?)]/g,
    match: ([, str], h) => {
      return h(
        'span',
        { style: 'color:red;font-weight:bold;' },
        'TODO: ' + str,
      );
    },
  },
];
