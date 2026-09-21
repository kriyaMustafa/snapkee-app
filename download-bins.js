const fs = require('fs');
const path = require('path');
const https = require('https');

const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return download(response.headers.location, dest).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function run() {
  console.log('Downloading yt-dlp.exe...');
  await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', path.join(binDir, 'yt-dlp.exe'));
  
  console.log('Downloading ffmpeg.exe (using a reliable mirror)...');
  await download('https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', path.join(binDir, 'ffmpeg.zip'));
  
  console.log('Done downloading.');
}

run().catch(console.error);
