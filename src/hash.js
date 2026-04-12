'use strict';

const crypto = require('crypto');

/**
 * SHA-256 hex digest of the raw WHOIS string.
 * @param {string} rawString
 * @returns {string}
 */
function hashRaw(rawString) {
  return crypto
    .createHash('sha256')
    .update(rawString || '')
    .digest('hex');
}

/**
 * Fully deterministic SHA-256 hex digest of a parsed WHOIS object.
 * Keys are sorted alphabetically before serialization, and array
 * fields are pre-sorted by the parser so output is stable.
 * @param {object} parsedObject
 * @returns {string}
 */
function hashFields(parsedObject) {
  // Strip metadata logic before hashing
  const copy = { ...parsedObject };
  delete copy.anomalies;
  delete copy.epik_data;
  delete copy.registry_data;

  const sorted = sortObjectKeys(copy);
  const json = JSON.stringify(sorted);
  return crypto
    .createHash('sha256')
    .update(json)
    .digest('hex');
}

/**
 * Recursively sort an object's keys alphabetically.
 * Arrays are left in their existing order (parser already sorts them).
 * @param {*} obj
 * @returns {*}
 */
function sortObjectKeys(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectKeys(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}

module.exports = { hashRaw, hashFields };
