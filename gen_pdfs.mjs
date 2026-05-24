// Test harness: render generatePDF() from app.jsx against fixtures, write PDFs to /tmp.
// Extracts uboTypeMeta + generatePDF via regex, injects jsPDF + synth helpers, and
// stubs the browser download path to fs.writeFileSync.
import fs from 'fs';
import { jsPDF } from 'jspdf';
import { synthesize, formatUSD, deriveStatus, deriveDivestiture, keyOf, collectControlLayers } from './synth.js';

const src = fs.readFileSync('app.jsx', 'utf-8');

const uboMatch = src.match(/function uboTypeMeta[\s\S]*?\n}/);
const genMatch = src.match(/async function generatePDF\(result\) \{[\s\S]*?\n}\n\n\/\/ ─── Icons/);
if (!uboMatch || !genMatch) {
  console.error('extraction failed', { ubo: !!uboMatch, gen: !!genMatch });
  process.exit(1);
}

let genSrc = genMatch[0].replace('\n\n// ─── Icons', '');

// Replace the browser download block (everything from the "Force a direct file
// download" comment to the end of the function) with a Node fs write.
const cutAt = genSrc.indexOf('  // Force a direct file download');
if (cutAt === -1) { console.error('download block not found'); process.exit(1); }
genSrc = genSrc.slice(0, cutAt) +
  `  const filename = \`/tmp/\${focal.replace(/\\s+/g, '-')}-ownership-report.pdf\`;
  fs.writeFileSync(filename, Buffer.from(pdf.output('arraybuffer')));
  return filename;
}`;

const factory = new Function(
  'jsPDF', 'formatUSD', 'deriveStatus', 'deriveDivestiture', 'keyOf', 'collectControlLayers', 'fs',
  `${uboMatch[0]}\n${genSrc}\nreturn generatePDF;`
);
const generatePDF = factory(jsPDF, formatUSD, deriveStatus, deriveDivestiture, keyOf, collectControlLayers, fs);

const fixtures = process.argv.slice(2);
if (fixtures.length === 0) {
  console.error('usage: node gen_pdfs.mjs <fixture.json> [...]');
  process.exit(1);
}

for (const f of fixtures) {
  const fx = JSON.parse(fs.readFileSync(f, 'utf-8'));
  // Fixtures hold synthesize() inputs; render the synthesized result.
  const result = fx.ownership_tree
    ? fx
    : synthesize(fx.ownership, fx.revenueByCompany || {}, fx.parentAnchor || null, fx.entitiesByCompany || {});
  const out = await generatePDF(result);
  console.log(`✓ ${f} → ${out}`);
}
