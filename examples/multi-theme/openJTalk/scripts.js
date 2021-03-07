require('date-utils');
const fs = require('fs');
exports.preprocess =
  async (filepath,contents)=> {
    // ルビをフリガナだけにする
    const script = contents.replaceAll(/\{.*?\|(.*?)\}/gm,"$1"); //(match, p1, p2, offset, string)=>{return p2;});
    const lines = script.split("\n");
    const OpenJTalk = require('openjtalk');
    const mei = new OpenJTalk();
    const pitch = 300;
    const now = new Date();
    const logFilename = `openJTalk_${now.toFormat("YYYYMMDD_HH24MISS")}.log`;

    for(const line of lines){
      if(line.length > 0){
        mei._makeWav(line,pitch,(err,result)=>{
          const log = "============================================\n"+
            result.wav + "\n\n" + line +
            "\n============================================\n";
          fs.writeFileSync(logFilename,log,{flag:"a"});
        });
      }
    }
    return contents;
  };
