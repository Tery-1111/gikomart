// Zero-dependency CI test: syntax-checks every server-side JS file (server.js + src/**)
// without executing it, so the `npm test` step in the GitHub workflow can't fail on
// a missing script or let a syntax-broken file through.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const roots = [path.join(__dirname, '..'), path.join(__dirname, '..', 'src')].filter(p => fs.existsSync(p));
const files = new Set();

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.add(full);
    }
  }
}

roots.forEach(walk);

let failed = 0;
for (const file of files) {
  try {
    // Parse only — does not execute any code.
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
    console.log(`OK   ${path.relative(path.join(__dirname, '..'), file)}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${file}: ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`\nAll ${files.size} file(s) passed syntax check`);