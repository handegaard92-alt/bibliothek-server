// Genererer PWA-ikoner fra én SVG-master.
// Kjøres lokalt: `node scripts/generate-icons.js`

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// Stilisert bok-stabel — tre bokrygger med gull-aksent
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141418"/>
      <stop offset="100%" stop-color="#0a0a0c"/>
    </linearGradient>
    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#d8b878"/>
      <stop offset="100%" stop-color="#b89358"/>
    </linearGradient>
    <linearGradient id="bookA" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#3a2818"/>
      <stop offset="100%" stop-color="#1a0f08"/>
    </linearGradient>
    <linearGradient id="bookB" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#5a3a20"/>
      <stop offset="100%" stop-color="#2a1a10"/>
    </linearGradient>
    <linearGradient id="bookC" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#704a25"/>
      <stop offset="100%" stop-color="#3a2515"/>
    </linearGradient>
  </defs>

  <!-- Bakgrunn med rund hjørner-look (overflate-padding rundt) -->
  <rect width="512" height="512" rx="100" fill="url(#bg)"/>

  <!-- Bok-stabel: tre bøker stående på rad, stilisert som rygger -->
  <g transform="translate(96, 88)">
    <!-- Bok 1 (venstre, mørkest) -->
    <rect x="0" y="20" width="92" height="280" rx="8" fill="url(#bookA)" stroke="#0a0a0c" stroke-width="2"/>
    <rect x="6" y="40" width="80" height="6" fill="url(#goldGrad)" opacity="0.85"/>
    <rect x="6" y="55" width="80" height="3" fill="url(#goldGrad)" opacity="0.5"/>
    <rect x="6" y="270" width="80" height="6" fill="url(#goldGrad)" opacity="0.85"/>

    <!-- Bok 2 (midt, høyere) -->
    <rect x="106" y="0" width="100" height="300" rx="8" fill="url(#bookB)" stroke="#0a0a0c" stroke-width="2"/>
    <rect x="113" y="22" width="86" height="7" fill="url(#goldGrad)"/>
    <rect x="113" y="38" width="86" height="3" fill="url(#goldGrad)" opacity="0.55"/>
    <text x="156" y="170" font-family="serif" font-size="86" font-weight="700" fill="url(#goldGrad)" text-anchor="middle">B</text>
    <rect x="113" y="270" width="86" height="6" fill="url(#goldGrad)" opacity="0.85"/>

    <!-- Bok 3 (høyre, hellet litt) -->
    <g transform="translate(218, 30) rotate(6 50 140)">
      <rect x="0" y="0" width="100" height="270" rx="8" fill="url(#bookC)" stroke="#0a0a0c" stroke-width="2"/>
      <rect x="8" y="22" width="84" height="6" fill="url(#goldGrad)" opacity="0.85"/>
      <rect x="8" y="36" width="84" height="3" fill="url(#goldGrad)" opacity="0.5"/>
      <rect x="8" y="240" width="84" height="6" fill="url(#goldGrad)" opacity="0.85"/>
    </g>
  </g>

  <!-- Tynn gulldekorlinje under -->
  <rect x="80" y="396" width="352" height="3" fill="url(#goldGrad)" opacity="0.6"/>
</svg>`;

const masterPath = path.join(OUT, 'icon.svg');
fs.writeFileSync(masterPath, svg);
console.log('✓ icon.svg →', masterPath);

// Generer PNG-ene
const sizes = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-32.png', size: 32 },
  { name: 'favicon-16.png', size: 16 },
];

async function gen() {
  for (const { name, size } of sizes) {
    const out = path.join(OUT, name);
    await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
    console.log('✓', name);
  }
  // Maskerbar variant (større safe-zone for Android adaptive icons)
  const maskable = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#0a0a0c"/>
  <g transform="translate(64, 64) scale(0.75)">${svg.split('<rect width="512" height="512" rx="100" fill="url(#bg)"/>')[1].replace('</svg>', '')}</g>
</svg>`;
  // Enklere: bruk samme SVG men med ekstra padding rundt
  const maskSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgM" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141418"/><stop offset="100%" stop-color="#0a0a0c"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bgM)"/>
  <g transform="translate(64, 64) scale(0.75)">
    ${svg.replace(/<\?xml[^?]+\?>/, '').replace(/<svg[^>]+>/, '').replace(/<\/svg>/, '')}
  </g>
</svg>`;
  await sharp(Buffer.from(maskSvg)).resize(512, 512).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'icon-maskable-512.png'));
  console.log('✓ icon-maskable-512.png');
}

gen().catch(e => { console.error(e); process.exit(1); });
