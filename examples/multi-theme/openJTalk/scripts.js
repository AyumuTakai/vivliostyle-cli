const fs = require('fs');
exports.preprocess = [
  (filepath,contents)=> {
    const script = contents.replaceAll(/\{.*?\|(.*?)\}/gm,"$1"); //(match, p1, p2, offset, string)=>{return p2;});
    fs.writeFileSync("openJTalk.log",script,{flag:"a"});
    const lines = script.split("\n");
    const OpenJTalk = require('openjtalk');
    const mei = new OpenJTalk();
    const pitch = 300;
    for(const line of lines){
      if(line.length > 0){
        mei._makeWav(line,pitch,(err,result)=>{

        });
      }
    }
    return contents;
  }
];
