'use strict';

const fs = require('fs');
const path = require('path');

// ── Log tee: mirror all stdout/stderr to logs/latest.log ────────────────────
{
  const logsDir = path.resolve(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logsDir, 'latest.log'), { flags: 'w' });
  
  const isCI = process.env.GITHUB_ACTIONS === 'true';
  const stripAnsi = s => s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
  
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  
  const tee = (orig, chunk, enc, cb) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    logStream.write(stripAnsi(str));
    
    // Always call original so it shows up in console/Action logs
    if (typeof enc === 'function') return orig(chunk, enc);
    return orig(chunk, enc, cb);
  };
  
  process.stdout.write = (c, e, cb) => tee(origOut, c, e, cb);
  process.stderr.write = (c, e, cb) => tee(origErr, c, e, cb);
}

const chalk = require('chalk');

const { queryDomain } = require('./query');
const { parseDomainData } = require('./parse');
const { hashRaw, hashFields } = require('./hash');
const { saveSnapshot, loadLedger, saveLedger, updateLedger } = require('./store');
const { checkAndRotate } = require('./archive');
const { diffDomain } = require('./diff');
const { generateReport } = require('./report');
const { sendChangeAlert } = require('./notify');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse --date YYYY-MM-DD from argv, fall back to today.
 * @returns {string}
 */
function resolveDate() {
  const idx = process.argv.indexOf('--date');
  if (idx !== -1 && process.argv[idx + 1]) {
    const val = process.argv[idx + 1];
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    console.error(chalk.red(`Invalid --date value: "${val}". Expected YYYY-MM-DD.`));
    process.exit(1);
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load and parse config.json from the project root.
 * @returns {object}
 */
function loadConfig() {
  const rootDir = path.resolve(__dirname, '..');
  const configPath = path.join(rootDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error(chalk.red(`config.json not found at ${configPath}`));
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Ensure all defined paths are absolute relative to the project root
  const pathKeys = ['domains_file', 'snapshots_dir', 'archives_dir', 'reports_dir', 'ledger_file'];
  for (const k of pathKeys) {
    if (config[k]) {
      config[k] = path.resolve(rootDir, config[k]);
    }
  }

  return config;
}

/**
 * Read domains from the file referenced in config.
 * @param {object} config
 * @returns {string[]}
 */
function loadDomains(config) {
  const domainsPath = path.resolve(__dirname, '..', config.domains_file);
  if (!fs.existsSync(domainsPath)) {
    console.error(chalk.red(`domains file not found: ${domainsPath}`));
    process.exit(1);
  }
  return fs
    .readFileSync(domainsPath, 'utf8')
    .split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Print a summary table to stdout using chalk.
 * @param {object[]} results
 * @param {object}   notify
 * @param {string}   date
 */
function printSummary(results, notify, date) {
  console.log('\n' + chalk.bold('─'.repeat(60)));
  console.log(chalk.bold(`  Epik Watcher — Daily Run Summary  (${date})`));
  console.log(chalk.bold('─'.repeat(60)));

  const colW = [30, 10, 10];
  const header = [
    chalk.bold('Domain').padEnd(colW[0]),
    chalk.bold('Status').padEnd(colW[1]),
    chalk.bold('Fields Δ').padEnd(colW[2]),
  ].join('  ');
  console.log(header);
  console.log('─'.repeat(60));

  for (const r of results) {
    let status;
    if (r.error) {
      status = chalk.red('ERROR');
    } else if (r.changed) {
      status = chalk.yellow(r.first_seen ? 'NEW' : 'CHANGED');
    } else {
      status = chalk.green('OK');
    }

    const fieldsCount = r.changed ? String(r.fields_changed.length) : '—';
    const line = [
      r.domain.padEnd(colW[0]),
      status.padEnd(colW[1] + (r.changed || r.error ? 10 : 0)), // chalk adds invisible escape chars
      fieldsCount.padEnd(colW[2]),
    ].join('  ');
    console.log(line);
  }

  console.log('─'.repeat(60));

  if (notify.sent) {
    console.log(chalk.cyan(`  Email sent to: ${notify.recipients.join(', ')}`));
  } else if (notify.error) {
    console.log(chalk.red(`  Email error: ${notify.error}`));
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const started_at = new Date().toISOString();
  const date = resolveDate();
  const config = loadConfig();
  const domains = loadDomains(config);

  console.log(chalk.bold(`\n[epik-watcher] Starting run for ${date}`));
  console.log(`Domains: ${domains.join(', ')}\n`);

  // 1. Archive rotation (before any queries)
  let rotation;
  try {
    rotation = await checkAndRotate(config);
  } catch (err) {
    console.error(chalk.red(`[archive] Rotation failed: ${err.message}`));
    rotation = { rotated: false, size_mb: 0, archive_path: null, error: err.message };
  }

  // 2. Load ledger
  const ledger = loadLedger(config);

  // 3. Process each domain
  const results = [];
  const snapshots = {};   // domain → snapshot object, used by generateReport
  let anyFatalError = false;

  for (const domain of domains) {
    process.stdout.write(`  Querying ${chalk.cyan(domain)} … `);

    // a. WHOIS fetch
    const queryResult = await queryDomain(domain, config);

    if (queryResult.error && !queryResult.raw_registrar && !queryResult.raw_tld) {
      // Both queries failed — record as error and continue
      console.log(chalk.red(`FAIL (${queryResult.error})`));
      results.push({ domain, date, changed: false, error: queryResult.error });
      anyFatalError = true;
      continue;
    }

    // b. Parse (prefer registrar raw, fall back to TLD)
    const rawForParsing = queryResult.raw_registrar || queryResult.raw_tld || '';
    const parsed = parseDomainData(queryResult.raw_registrar, queryResult.raw_tld, queryResult.registrar_rdap_json, queryResult.rdap_json, domain);

    // c. Hash
    const raw_hash = hashRaw(rawForParsing);
    const fields_hash = hashFields(parsed);

    // d. Assemble snapshot object
    const snapshot = {
      domain,
      date,
      queried_at: queryResult.queried_at,
      raw_hash,
      fields_hash,
      parsed,
      raw: {
        registrar: queryResult.raw_registrar,
        tld: queryResult.raw_tld,
        tld_rdap: queryResult.rdap_json,
        registrar_rdap: queryResult.registrar_rdap_json,
      },
    };

    // e. Save snapshot
    saveSnapshot(domain, date, snapshot, config);
    snapshots[domain] = snapshot;

    // f. Diff
    const diffResult = diffDomain(domain, snapshot, ledger, date, config);

    // Carry over any partial query error
    if (queryResult.error) diffResult.error = queryResult.error;

    results.push(diffResult);

    // g. Update ledger entry
    updateLedger(ledger, domain, date, fields_hash);

    if (diffResult.changed) {
      const tag = diffResult.first_seen ? chalk.yellow('NEW') : chalk.yellow('CHANGED');
      console.log(`${tag} (${diffResult.fields_changed.length} field(s))`);
    } else {
      console.log(chalk.green('unchanged'));
    }
  }

  // 4. Save ledger
  saveLedger(ledger, config);

  // 5. Generate reports
  console.log('\n  Generating reports…');
  const runMeta = { date, started_at, rotation };
  const { mdPath, jsonPath } = generateReport(results, runMeta, config, snapshots);
  console.log(`  Markdown: ${mdPath}`);
  console.log(`  JSON:     ${jsonPath}`);

  // 6. Email notification
  console.log('  Sending notifications…');
  const notify = await sendChangeAlert(results, date, config);
  if (notify.sent) {
    console.log(chalk.cyan(`  Email sent to: ${notify.recipients.join(', ')}`));
  } else if (notify.error) {
    console.log(chalk.red(`  Email error: ${notify.error}`));
  } else {
    console.log('  No changes — email suppressed.');
  }

  // 7. Summary table
  printSummary(results, notify, date);

  // 8. Save last_run.json (metadata for dashboard)
  const lastRunData = {
    date,
    started_at,
    finished_at: new Date().toISOString(),
    success: !anyFatalError,
    domains_checked: domains.length,
    changed_count: results.filter(r => r.changed).length,
    error_count: results.filter(r => r.error).length
  };
  fs.writeFileSync(path.join(path.resolve(__dirname, '..'), 'last_run.json'), JSON.stringify(lastRunData, null, 2), 'utf8');

  // 9. Exit code
  if (anyFatalError) {
    console.error(chalk.red('One or more domains failed to query. Exiting with code 1.'));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(chalk.red(`[fatal] ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
