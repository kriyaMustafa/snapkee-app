const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const zipPath = path.join(__dirname, 'bin', 'ffmpeg.zip');
const binDir = path.join(__dirname, 'bin');

try {
  const zip = new AdmZip(zipPath);
  const zipEntries = zip.getEntries();
  
  let extracted = false;
  for (const entry of zipEntries) {
    if (entry.entryName.endsWith('ffmpeg.exe')) {
      const content = entry.getData();
      fs.writeFileSync(path.join(binDir, 'ffmpeg.exe'), content);
      extracted = true;
      break;
    }
  }
  
  if (extracted) {
    console.log('Successfully extracted ffmpeg.exe');
    // clean up zip
    fs.unlinkSync(zipPath);
  } else {
    console.error('ffmpeg.exe not found in zip');
  }
} catch (e) {
  console.error('Failed to extract:', e);
}
