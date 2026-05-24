import fs from 'fs';

// Read app.jsx and extract generatePDF function
const appContent = fs.readFileSync('app.jsx', 'utf-8');
const match = appContent.match(/function uboTypeMeta[\s\S]*?(?=\n\nfunction|\n\nasync function)/);
const uboTypeMetaCode = match ? match[0] : '';
const generatePdfMatch = appContent.match(/async function generatePDF[\s\S]*?(?=\n\n  return {)/);
const generatePdfCode = generatePdfMatch ? generatePdfMatch[0] + '\n\n  return {' : '';

// Minimal test: check that the new code is present
const improvements = [
  'Ownership Hierarchy Pyramid',
  'Revenue Cascade',
  'Sibling Revenue Ranking',
  'icon:',
  'confidence_indicator',
  'shine effect'
];

let found = 0;
improvements.forEach(imp => {
  if (generatePdfCode.includes(imp) || appContent.includes(imp)) {
    console.log(`✓ "${imp}" code present`);
    found++;
  } else {
    console.log(`✗ "${imp}" code missing`);
  }
});

console.log(`\n${found}/${improvements.length} visual improvements detected`);
