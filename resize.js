const { Jimp } = require('jimp');

async function resize() {
  const image = await Jimp.read('image.png');
  await image.resize({ w: 256, h: 256 });
  await image.write('square.png');
  console.log('Resized successfully');
}

resize().catch(console.error);
