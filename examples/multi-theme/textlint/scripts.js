const fs = require('fs');
const TextLintEngine = require("textlint").TextLintEngine;
const engine = new TextLintEngine({
  rulePaths: ["textlint/node_modules/textlint-rule-joyo-kanji"]
});
exports.preprocess = [
  (filepath,contents)=>{
    engine.executeOnText(contents).then((results) => {
        fs.writeFileSync("textlint.log",
          "==============================\n" +
          filepath +
          "\n==============================\n",
          {flag:"a"});
        let result = "";
        for(const message of results[0].messages) {
          result += message.line + ":" + message.message + "\n";
        }
        fs.writeFileSync("textlint.log",result + "\n",{flag:"a"});
        if (engine.isErrorResults(results)) {
          const output = engine.formatResults(results);
          fs.writeFileSync("textlint.log",output + "\n",{flag:"a"});
        }
      });
      return contents;
    },
];
