exports.preprocess = [
  (filepath, contents) => {
    contents = contents.replace(/replace/, 'replaced');
    return contents;
  },
];

exports.replace = [
  {
    test: /replace/,
    match: ([], h) => {
      return h('span', 'replaced');
    },
  },
];
