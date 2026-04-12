const fs = require('fs');

try {
  fs.rmSync('snapshots', { recursive: true, force: true });
} catch (e) {}
try {
  fs.mkdirSync('snapshots');
} catch (e) {}

fs.writeFileSync('history.json', '{}');
fs.writeFileSync('last_run.json', '{}');
fs.writeFileSync('db.json', '{}');

console.log('Database index files and snapshots successfully cleared.');
