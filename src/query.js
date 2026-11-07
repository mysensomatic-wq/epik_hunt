'use strict';

const whois = require('whois');
const fetch = require('node-fetch');
const AbortController = globalThis.AbortController || require('abort-controller');

// Registrar RDAP servers polled for every domain, whoever the current registrar is.
// A 404 from a server is recorded too: it shows that server does not (or no longer)
// claims the name. Override with "watch_rdap_servers" in config.json.
const DEFAULT_WATCH_RDAP = {
  epik: 'https://rdap.epik.com',
  dynadot: 'https://rdap.dynadot.com',
};
const EPIK_WHOIS = 'whois.epik.com';

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * GET an RDAP URL. Always resolves; never throws.
 * @returns {Promise<{url, status, fetched_at, body?, error?}>}
 */
async function fetchRdap(url, timeoutMs) {
  const fetched_at = new Date().toISOString();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/rdap+json' } });
    clearTimeout(timeoutId);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = text ? { non_json: text.slice(0, 2000) } : null; }
    return { url, status: res.status, fetched_at, body };
  } catch (err) {
    clearTimeout(timeoutId);
    return { url, status: null, fetched_at, error: err.message };
  }
}

/**
 * Pull the "Registrar WHOIS Server" named by the registry, so the registrar
 * WHOIS query goes to whoever currently sponsors the name.
 * @param {string|null} rawTld
 * @returns {string|null}
 */
function registrarWhoisServerFrom(rawTld) {
  if (!rawTld) return null;
  const m = rawTld.match(/^\s*Registrar WHOIS Server:\s*(\S+)\s*$/im);
  if (!m) return null;
  return m[1].replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').toLowerCase() || null;
}

/**
 * Fetch WHOIS and RDAP for a domain:
 *  - registry WHOIS (TLD server) and registry RDAP (via rdap.org bootstrap)
 *  - the current registrar's WHOIS and RDAP, as named by the registry
 *  - Epik's WHOIS whenever Epik is no longer the registrar of record
 *  - every server in watch_rdap_servers (Epik and Dynadot by default)
 *
 * @param {string} domain
 * @param {object} config
 */
async function queryDomain(domain, config) {
  const queried_at = new Date().toISOString();
  const timeoutMs = 30_000;
  const rateMs = config.whois_rate_limit_ms || 1200;
  const watchServers = config.watch_rdap_servers || DEFAULT_WATCH_RDAP;

  let raw_registrar = null;
  let raw_tld = null;
  let raw_epik_whois = null;
  let rdap_json = null;
  let registrar_rdap_json = null;
  let errorMsg = null;
  const addErr = (msg) => { errorMsg = errorMsg ? `${errorMsg}; ${msg}` : msg; };

  // 1. Registry WHOIS first: it names the current registrar's WHOIS server.
  try {
    raw_tld = await lookupWithTimeout(domain, { follow: 1 }, timeoutMs);
  } catch (err) {
    addErr(`tld: ${err.message}`);
  }
  const registrar_whois_server = registrarWhoisServerFrom(raw_tld) || EPIK_WHOIS;

  // 2. Current registrar's WHOIS.
  await sleep(rateMs);
  try {
    raw_registrar = await lookupWithTimeout(domain, { server: registrar_whois_server, follow: 0 }, timeoutMs);
  } catch (err) {
    addErr(`registrar (${registrar_whois_server}): ${err.message}`);
  }

  // 3. Epik's WHOIS as well, when Epik is not the current registrar.
  if (registrar_whois_server !== EPIK_WHOIS) {
    await sleep(rateMs);
    try {
      raw_epik_whois = await lookupWithTimeout(domain, { server: EPIK_WHOIS, follow: 0 }, timeoutMs);
    } catch (err) {
      raw_epik_whois = null;
      addErr(`epik whois: ${err.message}`);
    }
  }

  // 4. Registry RDAP, then the registrar RDAP it links to.
  await sleep(rateMs);
  const reg = await fetchRdap(`https://rdap.org/domain/${domain}`, timeoutMs);
  if (reg.status === 200 && reg.body && !reg.body.non_json) {
    rdap_json = reg.body;
    const relatedLink = rdap_json.links && rdap_json.links.find(l => (l.rel === 'related' || l.rel === 'registrar') && l.type === 'application/rdap+json');
    if (relatedLink && relatedLink.href) {
      await sleep(rateMs);
      const rr = await fetchRdap(relatedLink.href, timeoutMs);
      registrar_rdap_json = rr.status === 200 && rr.body && !rr.body.non_json
        ? rr.body
        : { error: rr.error ? `Registrar RDAP fetch failed: ${rr.error}` : `HTTP ${rr.status}` };
    }
  } else {
    rdap_json = { error: reg.error ? `RDAP fetch failed: ${reg.error}` : `HTTP ${reg.status}` };
  }

  // 5. Watched registrar RDAP servers, queried directly for this domain.
  const watched_rdap = {};
  for (const [name, base] of Object.entries(watchServers)) {
    await sleep(rateMs);
    watched_rdap[name] = await fetchRdap(`${base.replace(/\/+$/, '')}/domain/${domain}`, timeoutMs);
  }

  const result = {
    domain, raw_registrar, raw_tld, raw_epik_whois, registrar_whois_server,
    rdap_json, registrar_rdap_json, watched_rdap, queried_at,
  };
  if (errorMsg) result.error = errorMsg;
  return result;
}

module.exports = { queryDomain, registrarWhoisServerFrom };
