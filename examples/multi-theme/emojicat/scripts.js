exports.replaces = [
  {
    test: /猫/g,
    match: ([], h) => {
      return h("span","🐈");
    }
  },
];
