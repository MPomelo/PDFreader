import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const notices = ['PDFreader runtime JavaScript dependency notices. Generated from the pinned package-lock.json.\n'];
const missing = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev || !existsSync(path)) continue;
  const pkg = JSON.parse(readFileSync(path + '/package.json', 'utf8'));
  const files = readdirSync(path).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  notices.push(`\n========== ${pkg.name} ${pkg.version} (${pkg.license || entry.license || 'see upstream'}) ==========\n`);
  if (files.length) {
    for (const name of files) { try { notices.push(readFileSync(path + '/' + name, 'utf8')); } catch {} }
  } else if (pkg.name === '@fluentui/react-icons' && existsSync('public/licenses/Fluent-System-Icons.txt')) {
    notices.push(readFileSync('public/licenses/Fluent-System-Icons.txt', 'utf8'));
  } else {
    const readme = readdirSync(path).find(name => /^readme\.(md|markdown|txt)$/i.test(name));
    const text = readme ? readFileSync(path + '/' + readme, 'utf8') : '';
    const section = text.search(/^#{1,3}\s+licen[cs]e/im);
    if (section >= 0) notices.push(text.slice(section)); else missing.push(pkg.name);
  }
}
writeFileSync('public/licenses/Runtime-JavaScript-Notices.txt', notices.join('\n'));
if (missing.length) throw Error('Missing license text: ' + missing.join(', '));
console.log(`Collected ${notices.length - 1} notice sections.`);
