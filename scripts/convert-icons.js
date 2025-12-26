#!/usr/bin/env node

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { format: formatIcns } = require('icns-lib');

const assetsDir = path.join(__dirname, '..', 'assets');
const generatedDir = path.join(assetsDir, 'generated');

async function convertIcons() {
  console.log('Converting SVG icons to PNG...');

  // Ensure generated directory exists
  if (!fs.existsSync(generatedDir)) {
    fs.mkdirSync(generatedDir, { recursive: true });
  }

  // Main app icon (1024x1024)
  await sharp(path.join(generatedDir, 'icon.svg'))
    .resize(1024, 1024)
    .png()
    .toFile(path.join(generatedDir, 'icon.png'));
  console.log('  Created generated/icon.png');

  // Light mode icon variant with border (for README on light backgrounds)
  await sharp(path.join(generatedDir, 'icon-light.svg'))
    .resize(1024, 1024)
    .png()
    .toFile(path.join(generatedDir, 'icon-light.png'));
  console.log('  Created generated/icon-light.png');

  // Tray icons
  await sharp(path.join(generatedDir, 'tray-iconTemplate.svg'))
    .resize(22, 22)
    .png()
    .toFile(path.join(generatedDir, 'tray-iconTemplate.png'));
  console.log('  Created generated/tray-iconTemplate.png');

  await sharp(path.join(generatedDir, 'tray-iconTemplate@2x.svg'))
    .resize(44, 44)
    .png()
    .toFile(path.join(generatedDir, 'tray-iconTemplate@2x.png'));
  console.log('  Created generated/tray-iconTemplate@2x.png');

  // Busy tray icons - pulse animation frames
  const PULSE_FRAMES = 8;
  for (let i = 0; i < PULSE_FRAMES; i++) {
    await sharp(path.join(generatedDir, `tray-icon-busy-${i}.svg`))
      .resize(22, 22)
      .png()
      .toFile(path.join(generatedDir, `tray-icon-busy-${i}.png`));

    await sharp(path.join(generatedDir, `tray-icon-busy-${i}@2x.svg`))
      .resize(44, 44)
      .png()
      .toFile(path.join(generatedDir, `tray-icon-busy-${i}@2x.png`));
  }
  console.log(`  Created ${PULSE_FRAMES} busy icon pulse frames`);

  // Not-ready tray icons - pulse animation frames (grey ">")
  for (let i = 0; i < PULSE_FRAMES; i++) {
    await sharp(path.join(generatedDir, `tray-icon-notready-${i}.svg`))
      .resize(22, 22)
      .png()
      .toFile(path.join(generatedDir, `tray-icon-notready-${i}.png`));

    await sharp(path.join(generatedDir, `tray-icon-notready-${i}@2x.svg`))
      .resize(44, 44)
      .png()
      .toFile(path.join(generatedDir, `tray-icon-notready-${i}@2x.png`));
  }
  console.log(`  Created ${PULSE_FRAMES} not-ready icon pulse frames`);

  // Paused tray icons - pulse animation frames (amber "||")
  for (let i = 0; i < PULSE_FRAMES; i++) {
    await sharp(path.join(generatedDir, `tray-icon-paused-${i}.svg`))
      .resize(22, 22)
      .png()
      .toFile(path.join(generatedDir, `tray-icon-paused-${i}.png`));

    await sharp(path.join(generatedDir, `tray-icon-paused-${i}@2x.svg`))
      .resize(44, 44)
      .png()
      .toFile(path.join(generatedDir, `tray-icon-paused-${i}@2x.png`));
  }
  console.log(`  Created ${PULSE_FRAMES} paused icon pulse frames`);

  // Create .icns file (cross-platform using icns-lib)
  console.log('Creating macOS .icns file...');
  const svgPath = path.join(generatedDir, 'icon.svg');

  // Generate PNG buffers at all required sizes for icns
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  const pngBuffers = {};
  for (const size of sizes) {
    pngBuffers[size] = await sharp(svgPath).resize(size, size).png().toBuffer();
  }

  // Create icns with proper icon type codes
  // ic07=128, ic08=256, ic09=512, ic10=1024, ic11=16, ic12=32, ic13=256@2x, ic14=512@2x
  const icnsData = {
    'ic07': pngBuffers[128],
    'ic08': pngBuffers[256],
    'ic09': pngBuffers[512],
    'ic10': pngBuffers[1024],
    'ic11': pngBuffers[16],
    'ic12': pngBuffers[32],
    'ic13': pngBuffers[256],
    'ic14': pngBuffers[512],
  };

  const icnsBuffer = formatIcns(icnsData);
  fs.writeFileSync(path.join(generatedDir, 'icon.icns'), icnsBuffer);
  console.log('  Created generated/icon.icns');

  console.log('Icon conversion complete!');
}

convertIcons().catch(err => {
  console.error('Error converting icons:', err);
  process.exit(1);
});
