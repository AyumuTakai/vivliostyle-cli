require('date-utils');
const path = require('path');
const fs = require('fs');
const TextLintEngine = require("textlint").TextLintEngine;
const engine = new TextLintEngine({
  rulePaths: [path.resolve(__dirname,"../../textlint-rule-joyo-kanji")] // TODO:もっと良い書き方がありそう
});

exports.preprocess =
  async (filepath,contents)=>{
    const results = await engine.executeOnText(contents);
    const now = new Date();
    const logFilename = `textlint_${now.toFormat("YYYYMMDD_HH24MISS")}.log`;

    let result = "";
    for(const message of results[0].messages) {
      result += message.line + ":" + message.message + "\n";
    }
    fs.writeFileSync(logFilename,
      "==============================\n" +
      filepath +
      "\n==============================\n"
      + result + "\n",
      {flag:"a"});
    if (engine.isErrorResults(results)) {
      console.error("textlint error");
    }
    return contents;
  };
