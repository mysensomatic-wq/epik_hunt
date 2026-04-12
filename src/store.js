'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Ensure a directory exists (sync, recursive).
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write today's snapshot for a domain.
 * Path: {snapshots_dir}/{date}/{domain}.json
 *
 * @param {string} domain
 * @param {string} date        - YYYY-MM-DD
 * @param {object} data        - full snapshot object
 * @param {object} config
 */
function saveSnapshot(domain, date, data, config) {
  const dir = path.join(config.snapshots_dir, date);
  ensureDir(dir);
  const file = path.join(dir, `${domain}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Load a snapshot for a domain on a given date.
 * Returns null if the file does not exist.
 *
 * @param {string} domain
 * @param {string} date  - YYYY-MM-DD
 * @param {object} config
 * @returns {object|null}
 */
function loadSnapshot(domain, date, config) {
  const file = path.join(config.snapshots_dir, date, `${domain}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read ledger.json; returns {} if the file is missing or malformed.
 * @param {object} config
 * @returns {object}
 */
function loadLedger(config) {
  const file = config.ledger_file;
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Write ledger.json atomically-ish (overwrite in place).
 * @param {object} ledger
 * @param {object} config
 */
function saveLedger(ledger, config) {
  fs.writeFileSync(config.ledger_file, JSON.stringify(ledger, null, 2), 'utf8');
}

/**
 * Append a { date, hash } entry for domain in the ledger.
 * Creates the domain array if it doesn't exist yet.
 *
 * @param {object} ledger       - mutable ledger object (modified in place)
 * @param {string} domain
 * @param {string} date         - YYYY-MM-DD
 * @param {string} fieldsHash   - hex hash from hashFields()
 */
function updateLedger(ledger, domain, date, fieldsHash) {
  if (!Array.isArray(ledger[domain])) {
    ledger[domain] = [];
  }
  // Remove any existing entry for the same date (idempotent re-runs)
  ledger[domain] = ledger[domain].filter(e => e.date !== date);
  ledger[domain].push({ date, hash: fieldsHash });
  // Keep sorted by date ascending
  ledger[domain].sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { saveSnapshot, loadSnapshot, loadLedger, saveLedger, updateLedger };
