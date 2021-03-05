exports.preprocess = (filename,contents)=>{
  contents = contents.replace(/^\[newpage]$/gm,'<div class="newpage" style="page-break-before:always; break-before: page;height: 0;margin: 0;padding: 0;" />');
  return contents;
}

exports.replace=[
  // { // 強制改ページ
  //   test: /\[newpage]/g,
  //   match: ([], h) => {
  //     return h("div",{style:"break-before: page;height: 0;margin: 0;padding: 0;"});
  //   }
  // },
];
