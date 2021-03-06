exports.preprocess = [
  (filepath, contents) => {
    contents = contents.replace(/replace/, 'replaced');
    return contents;
  },
];

exports.replaces = [
  {
    test: /replace/,
    match: ([], h) => {
      return h('span', 'replaced');
    },
  },
];
