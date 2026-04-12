const fs = require('fs');
const { parseDomainData } = require('./src/parse.js');

const sn = JSON.parse(fs.readFileSync('./snapshots/2026-04-11/cryptoweed.com.json', 'utf8'));

const parsed = parseDomainData(
  sn.raw.registrar,
  sn.raw.tld,
  sn.raw.registrar_rdap,
  sn.raw.tld_rdap,
  sn.domain
);

console.log(Object.keys(parsed));
console.log(parsed.epik_data);
