const pngToIco = require('png-to-ico').default;
const fs = require('fs');

pngToIco('square.png')
  .then(buf => {
    fs.writeFileSync('icon.ico', buf);
    console.log('Icon created successfully!');
  })
  .catch(err => {
    console.error('Failed to create icon:', err);
  });
