exports.replaces = [
  {
    test: /掌/g,
    match: ([], h) => {
      return h("span","🖐");
    }
  },
];
