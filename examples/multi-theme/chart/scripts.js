exports.preprocess =
  async (filename,contents)=>{
    const ChartJsImage = require('chartjs-to-image');

    const pattern = /\`\`\`json:#!chart$([\s\S]*)+\`\`\`$/gm;
    const configJson = pattern.exec(contents);
    if(configJson && configJson.length > 0) {
      const config = JSON.parse(`${configJson[1]}`);
      const myChart = new ChartJsImage();
      myChart.setConfig(config).setWidth(500).setHeight(500).setFormat("svg").setDevicePixelRatio(10);
      const chart = await myChart.toDataUrl();
      const width = config.width ? `width: ${config.width}` : "";
      contents = contents.replace(pattern,`<img src="${chart}" style="${width}">`);
    }

    return contents;
  };
