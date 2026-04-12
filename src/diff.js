'use strict';

const { loadSnapshot } = require('./store');

/**
 * Return the date string for the day before the given YYYY-MM-DD date.
 * @param {string} date  - YYYY-MM-DD
 * @returns {string}     - YYYY-MM-DD
 */
function previousDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function semanticNormalize(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.map(semanticNormalize).sort().join(',');
  return String(val).toLowerCase().replace(/\s+/g, '');
}

/**
 * Deep-equal check for two values (handles arrays and primitives).
 * Semantically ignores case and whitespace differences to prevent false positives.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return semanticNormalize(a) === semanticNormalize(b);
}

/**
 * Compare today's snapshot against yesterday's and return a structured diff.
 *
 * @param {string} domain
 * @param {object} todaySnapshot  - full snapshot object (includes parsed, hashes, etc.)
 * @param {object} ledger         - full ledger object
 * @param {string} today          - YYYY-MM-DD
 * @param {object} config         - needed by loadSnapshot
 * @returns {object}
 */
function diffDomain(domain, todaySnapshot, ledger, today, config) {
  const domainEntries = ledger[domain] || [];

  // Find the most recent ledger entry before today
  const priorEntry = [...domainEntries]
    .filter(e => e.date < today)
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;

  const todayFieldsHash = todaySnapshot.fields_hash;
  const isFirstSeen = priorEntry === null;

  // Hashes match → no change
  if (priorEntry && priorEntry.hash === todayFieldsHash) {
    return { domain, date: today, changed: false };
  }

  // Load yesterday's (or last known) snapshot for field-level diff
  const priorDate = priorEntry ? priorEntry.date : previousDate(today);
  const priorSnapshot = isFirstSeen ? null : loadSnapshot(domain, priorDate, config);
  const priorParsed = priorSnapshot ? priorSnapshot.parsed : null;
  const todayParsed = todaySnapshot.parsed;

  const diff = {};
  const fieldsChanged = [];

  const allFields = new Set([
    ...Object.keys(todayParsed || {}),
    ...Object.keys(priorParsed || {}),
  ]);

  for (const field of allFields) {
    if (['domain', 'anomalies', 'epik_data', 'registry_data'].includes(field)) continue; // skip metadata fields
    const before = priorParsed ? priorParsed[field] ?? null : null;
    const after = todayParsed ? todayParsed[field] ?? null : null;
    if (!deepEqual(before, after)) {
      fieldsChanged.push(field);
      diff[field] = { before, after };
    }
  }

  return {
    domain,
    date: today,
    changed: true,
    first_seen: isFirstSeen,
    fields_changed: fieldsChanged.sort(),
    diff,
  };
}

module.exports = { diffDomain };
