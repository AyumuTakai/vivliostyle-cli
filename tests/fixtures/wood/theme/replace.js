// ファイルをまたぐsectionカウンタ用
let chapter = 0;
// ソースファイル読み込みのベースディレクトリ
let src_basedir = 'src/fin/';
// ソース埋め込みの折り返し文字数
//let src_maxlen = 52;

module.exports = [
  {
    // PlantUMLの埋め込み
    test: /^\[plantuml\]\[([^\]]*),([^)<]*)\]/,
    match: ([, fn, caption], h) => {
      const fs = require('fs');
      const encoder = require('plantuml-encoder');
      const buf = fs.readFileSync(fn, 'utf8');
      const encoded = encoder.encode(buf);

      return h('figure', { class: 'plantuml' }, [
        h('figcaption', caption),
        h('img', { src: 'http://www.plantuml.com/plantuml/svg/' + encoded }),
      ]);
    },
  },
  {
    // ページ番号設定 任意のページ数から初める機能はCSSの仕様として無理なので白紙ページを必要数追加する。
    test: /^\[page\]\[(\d+)\]/,
    match: ([, no], h) => {
      let buf = [];
      for (let i = 0; i < no - 1; i++) {
        buf.push(
          h(
            'div',
            { style: 'break-after: page;/*height: 0;margin: 0;padding: 0;*/' },
            '@DELETE@',
          ),
        );
      }
      return h('div', { style: 'height:0;margin:0;padding:0;' }, buf);
    },
  },
  {
    // 任意の章番号を設定(この設定はファイルを跨いで有効 )
    test: /^\[chapter\]\[(\d+)\]/,
    match: ([, no], h) => {
      chapter = no - 1;
      return h('span', { style: 'counter-set: section ' + chapter++ });
    },
  },
  {
    // ファイルを跨いで連続する章番号設定
    test: /^\[chapter\]/,
    match: ([, no], h) => {
      return h('span', { style: 'counter-set: section ' + chapter++ });
    },
  },
  {
    // 側注
    test: /\[sn\]\[([LR])([+-]\d+)?,([^\]]*?),([^\]]*)\]/,
    match: ([, lr, offset, key, text], h) => {
      if (offset) {
        offset = offset + 'em';
      } else {
        offset = '-7em';
      }
      return h(
        'div',
        { class: 'sidenote ' + lr, style: 'margin-top: ' + offset },
        '* ' + text,
      );
    },
  },
  {
    // 側注マーカー
    test: /\[sn\]\[([^\]<]+)\]/g,
    match: ([, key], h) => {
      return h('span', { class: 'sidenote', id: key }, '*');
    },
  },
  {
    // 行指定でソースコードファイル埋め込み
    test: /\[src\]\[([^\]<]*),(\d+)-(\d+)\]/g,
    match: ([, fn, begin, end], h) => {
      const fs = require('fs');
      let l = 1;
      const lines = fs.readFileSync(src_basedir + fn, 'utf8').split('\n');
      let buf = [];
      for (let i = begin - 1; i < end; i++) {
        buf.push(lines[i]);
      }
      return h('figure', { class: 'code' }, [
        h('figcaption', fn),
        h(
          'ol',
          { style: 'counter-reset: item ' + (begin - 1) },
          buf.map((l) => {
            // 折り返しに改行記号を入れたいが、等幅フォントの扱いがわからず文字数指定が上手くいかない。
            // if(l.length >= (src_maxlen + 1)){
            //     return h("li",l.substr(0,src_maxlen)+"↩"+l.substr(src_maxlen));
            // }
            return h('li', l);
          }),
        ),
      ]);
    },
  },
  {
    // ソースコードファイル埋め込み
    test: /\[src\]\[([^\]<]*)\]/g,
    match: ([, fn], h) => {
      const fs = require('fs');
      let l = 1;
      const buf = fs.readFileSync(src_basedir + fn, 'utf8').split('\n');
      return h('figure', { class: 'code' }, [
        h('figcaption', fn),
        h(
          'ol',
          buf.map((l) => {
            // 折り返しに改行記号を入れたいが、等幅フォントの扱いがわからず文字数指定が上手くいかない。
            // if(l.length >= (src_maxlen + 1)){
            //     return h("li",l.substr(0,src_maxlen)+"↩"+l.substr(src_maxlen));
            // }
            return h('li', l);
          }),
        ),
      ]);
    },
  },
  {
    // ソースコード読み込みのベースディレクトリ変更
    test: /\[src_basedir\]\[([^\]<]+)\]/g,
    match: ([, dir], h) => {
      src_basedir = dir;
      return null;
    },
  },
  {
    // 強制改ページ
    test: /\[newpage\]/g,
    match: ([], h) => {
      return h('div', {
        style: 'break-before: page;height: 0;margin: 0;padding: 0;',
      });
    },
  },
  {
    // インラインコード
    test: /\[code\]\[([^\]<]+)\]/g,
    match: ([, str], h) => {
      str = str == '&#124;' ? '|' : str; // テーブル内に|を書けないため TODO:使えそうなパッケージを探す。
      return h('span', { class: 'character' }, str);
    },
  },
  {
    test: /\[TODO:([^\]]+)\]/g,
    match: ([, str], h) => {
      return h('span', { style: 'color:red;font-weight:bold;' }, str);
    },
  },
];
