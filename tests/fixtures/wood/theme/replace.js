module.exports = [
  {
    test: /\[plantuml\]\[([^\]]*),([^)]*)\]/,
    match: ([, fn, caption], h) => {
      const fs = require('fs');
      const encoder = require('plantuml-encoder');
      const buf = fs.readFileSync(fn, 'utf8');
      const encoded = encoder.encode(buf);

      return h('figure', { class: 'plantuml' }, [
        h('img', { src: 'http://www.plantuml.com/plantuml/svg/' + encoded }),
        h('figcaption', caption),
      ]);
    },
  },
  {
    test: /\[([^\]]*)\]\[([^\]]*)\]/,
    match: ([, a, b], h) => {
      return h('span', `${a},${b}.`);
    },
  },
];
