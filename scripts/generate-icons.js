#!/usr/bin/env node
/**
 * Generate SVG icons for localmost
 * PNG/ICNS conversion is handled by convert-icons.js using sharp
 */

const fs = require('fs');
const path = require('path');

const generatedDir = path.join(__dirname, '..', 'assets', 'generated');

// Ensure generated directory exists
if (!fs.existsSync(generatedDir)) {
  fs.mkdirSync(generatedDir, { recursive: true });
}

// Create the main app icon - laptop with play button on dark background
const createAppIcon = () => {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Dark rounded square background (macOS app icon style) -->
  <rect x="2" y="2" width="96" height="96" rx="22" fill="#1a1a1a"/>
  <!-- Laptop outline -->
  <rect x="15" y="20" width="70" height="50" rx="9" stroke="#ffffff" stroke-width="6"/>
  <path d="M15.5 87H84.5" stroke="#808080" stroke-width="6" stroke-linecap="round"/>
  <!-- Play button -->
  <path d="M42 35L60 45L42 55" stroke="#f43f5e" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
};

// Backup: House icon (alternative design)
const createAppIconBackup = () => {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="14.2405" y="31.740499999999997" width="7" height="7" fill="#a1a1aa" transform="rotate(-45 17.7405 35.2405)" rx="1.75"/>
  <rect x="22.9905" y="22.9905" width="7" height="7" fill="#a1a1aa" transform="rotate(-45 26.4905 26.4905)" rx="1.75"/>
  <rect x="31.740499999999997" y="14.2405" width="7" height="7" fill="#a1a1aa" transform="rotate(-45 35.2405 17.7405)" rx="1.75"/>
  <rect x="61.2595" y="14.2405" width="7" height="7" fill="#a1a1aa" transform="rotate(45 64.7595 17.7405)" rx="1.75"/>
  <rect x="70.0095" y="22.9905" width="7" height="7" fill="#a1a1aa" transform="rotate(45 73.5095 26.4905)" rx="1.75"/>
  <rect x="78.7595" y="31.740499999999997" width="7" height="7" fill="#a1a1aa" transform="rotate(45 82.2595 35.2405)" rx="1.75"/>
  <rect x="3" y="56.5" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <rect x="90" y="56.5" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <rect x="3" y="66.5" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <rect x="90" y="66.5" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <rect x="3" y="76.5" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <rect x="90" y="76.5" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <rect x="25.5" y="95" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <rect x="39.5" y="95" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <rect x="53.5" y="95" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <rect x="67.5" y="95" width="7" height="7" fill="#a1a1aa" rx="1.75"/>
  <path d="M 50 15 L 15 50 V 90 H 85 V 50 L 50 15 Z" fill="none" stroke="#ffffff" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
  <g transform="translate(0, 10)">
    <path d="M42 38L58 50L42 62" stroke="#f43f5e" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" transform="scale(1.2)" style="transform-origin: 50px 50px;"/>
  </g>
</svg>`;
};

// Create a template icon for tray (simplified laptop outline)
const createTrayTemplate = (size) => {
  const scale = size / 100;
  const strokeWidth = Math.max(4, 6 / scale);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="15" y="20" width="70" height="50" rx="9" stroke="black" stroke-width="${strokeWidth}"/>
  <path d="M15.5 87H84.5" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round"/>
  <path d="M42 35L60 45L42 55" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
};

// Create a busy tray icon with red/orange play symbol at a given intensity (0-1)
// intensity controls how bright/saturated the red is
const createTrayBusyTemplate = (size, intensity = 1.0) => {
  const scale = size / 100;
  const strokeWidth = Math.max(4, 6 / scale);

  // Base color is #f43f5e (rose-500)
  // At intensity 1.0: full color
  // At intensity 0.4: dimmed color (more grayish)
  const baseR = 244, baseG = 63, baseB = 94;
  const grayR = 100, grayG = 100, grayB = 100;

  // Interpolate between gray and full color based on intensity
  const r = Math.round(grayR + (baseR - grayR) * intensity);
  const g = Math.round(grayG + (baseG - grayG) * intensity);
  const b = Math.round(grayB + (baseB - grayB) * intensity);
  const color = `rgb(${r},${g},${b})`;
  const fillOpacity = 0.15 + 0.25 * intensity; // 0.15 to 0.4

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="15" y="20" width="70" height="50" rx="9" stroke="black" stroke-width="${strokeWidth}"/>
  <path d="M15.5 87H84.5" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round"/>
  <path d="M42 35L60 45L42 55" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" fill="${color}" fill-opacity="${fillOpacity}"/>
</svg>`;
};

// Create a "not ready" tray icon with grey ">" symbol at a given intensity (0-1)
// intensity controls how bright the grey is (pulsing effect)
const createTrayNotReadyTemplate = (size, intensity = 1.0) => {
  const scale = size / 100;
  const strokeWidth = Math.max(4, 6 / scale);

  // Grey color that pulses between lighter and darker
  // At intensity 1.0: lighter grey (#a0a0a0)
  // At intensity 0.3: darker grey (#606060)
  const lightGrey = 160;
  const darkGrey = 96;
  const grey = Math.round(darkGrey + (lightGrey - darkGrey) * intensity);
  const color = `rgb(${grey},${grey},${grey})`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="15" y="20" width="70" height="50" rx="9" stroke="black" stroke-width="${strokeWidth}"/>
  <path d="M15.5 87H84.5" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round"/>
  <path d="M42 35L60 45L42 55" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
};

// Animation frame intensities for smooth pulsing (ease in/out)
const PULSE_FRAMES = 8;
const getPulseIntensities = () => {
  const intensities = [];
  for (let i = 0; i < PULSE_FRAMES; i++) {
    // Use sine wave for smooth easing: ranges from 0.4 to 1.0
    const t = i / PULSE_FRAMES;
    const intensity = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 - Math.PI / 2));
    intensities.push(intensity);
  }
  return intensities;
};

// Write SVG files
console.log('Creating SVG icons...');
fs.writeFileSync(path.join(generatedDir, 'icon.svg'), createAppIcon());
fs.writeFileSync(path.join(generatedDir, 'icon-backup.svg'), createAppIconBackup());
fs.writeFileSync(path.join(generatedDir, 'tray-iconTemplate.svg'), createTrayTemplate(22));
fs.writeFileSync(path.join(generatedDir, 'tray-iconTemplate@2x.svg'), createTrayTemplate(44));

// Generate pulse animation frames for busy icon
const intensities = getPulseIntensities();
for (let i = 0; i < PULSE_FRAMES; i++) {
  fs.writeFileSync(
    path.join(generatedDir, `tray-icon-busy-${i}.svg`),
    createTrayBusyTemplate(22, intensities[i])
  );
  fs.writeFileSync(
    path.join(generatedDir, `tray-icon-busy-${i}@2x.svg`),
    createTrayBusyTemplate(44, intensities[i])
  );
}

// Generate pulse animation frames for not-ready icon (grey ">")
for (let i = 0; i < PULSE_FRAMES; i++) {
  fs.writeFileSync(
    path.join(generatedDir, `tray-icon-notready-${i}.svg`),
    createTrayNotReadyTemplate(22, intensities[i])
  );
  fs.writeFileSync(
    path.join(generatedDir, `tray-icon-notready-${i}@2x.svg`),
    createTrayNotReadyTemplate(44, intensities[i])
  );
}
console.log(`SVG icons created in assets/generated/ (including ${PULSE_FRAMES} busy + ${PULSE_FRAMES} not-ready pulse frames)`);
