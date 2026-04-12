'use strict';

const whois = require('whois');
const fetch = require('node-fetch');
const AbortController = globalThis.AbortController || require('abort-controller');
/**
 * Promisified wrapper around the whois package's lookup function.
 * @param {string} domain
 * @param {object} options  - passed through to whois.lookup
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function lookupWithTimeout(domain, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`WHOIS lookup timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    whois.lookup(domain, options, (err, data) => {
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(data || '');
    });
  });
}

/**
 * Sleep for the configured rate-limit interval.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch WHOIS data for a domain from both Epik's registrar server
 * and the TLD's authoritative server.
 *
 * @param {string} domain
 * @param {object} config
 * @returns {Promise<{domain, raw_registrar, raw_tld, queried_at, error?}>}
 */
async function queryDomain(domain, config) {
  const queried_at = new Date().toISOString();
  const timeoutMs = 30_000;
  const rateMs = config.whois_rate_limit_ms || 1200;

  let raw_registrar = null;
  let raw_tld = null;
  let rdap_json = null;
  let registrar_rdap_json = null;
  let errorMsg = null;

  try {
    // Query Epik's registrar WHOIS server
    raw_registrar = await lookupWithTimeout(
      domain,
      { server: 'whois.epik.com', follow: 0 },
      timeoutMs
    );
  } catch (err) {
    errorMsg = `registrar: ${err.message}`;
  }

  // Rate-limit between the two calls
  await sleep(rateMs);

  try {
    // Query the TLD authoritative WHOIS server (whois package auto-resolves)
    raw_tld = await lookupWithTimeout(
      domain,
      { follow: 1 },
      timeoutMs
    );
  } catch (err) {
    const msg = `tld: ${err.message}`;
    errorMsg = errorMsg ? `${errorMsg}; ${msg}` : msg;
  }

  // Rate-limit before RDAP call
  await sleep(rateMs);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/rdap+json' }
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      rdap_json = await res.json();
      
      const relatedLink = rdap_json.links && rdap_json.links.find(l => (l.rel === 'related' || l.rel === 'registrar') && l.type === 'application/rdap+json');
      if (relatedLink && relatedLink.href) {
        await sleep(rateMs);
        const rController = new AbortController();
        const rTimeoutId = setTimeout(() => rController.abort(), timeoutMs);
        try {
          const rRes = await fetch(relatedLink.href, {
            signal: rController.signal,
            headers: { 'Accept': 'application/rdap+json' }
          });
          clearTimeout(rTimeoutId);
          if (rRes.ok) {
            registrar_rdap_json = await rRes.json();
          } else {
            registrar_rdap_json = { error: `HTTP ${rRes.status} ${rRes.statusText}` };
          }
        } catch (rErr) {
          registrar_rdap_json = { error: `Registrar RDAP fetch failed: ${rErr.message}` };
        }
      }
    } else {
      rdap_json = { error: `HTTP ${res.status} ${res.statusText}` };
    }
  } catch (err) {
    rdap_json = { error: `RDAP fetch failed: ${err.message}` };
  }

  const result = { domain, raw_registrar, raw_tld, rdap_json, registrar_rdap_json, queried_at };
  if (errorMsg) result.error = errorMsg;
  return result;
}

module.exports = { queryDomain };
