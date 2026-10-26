'use strict';

/**
 * Works out a lead's timezone from where the business is.
 *   1. the city, narrowed by state and country when given
 *   2. the state / province / region
 *   3. a timezone field from GHL (only if the location gave nothing; GHL's own
 *      timezone field is often the account's, not the business's)
 *   4. the country
 *   5. America/New_York
 * Offline: no API calls.
 */

const cityTimezones = require('city-timezones');

const DEFAULT_TZ = 'America/New_York';

function validTz(tz) {
  if (!tz || !/\//.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// US states: majority timezone for states that span two.
const US = {
  AL: ['alabama', 'America/Chicago'], AK: ['alaska', 'America/Anchorage'], AZ: ['arizona', 'America/Phoenix'],
  AR: ['arkansas', 'America/Chicago'], CA: ['california', 'America/Los_Angeles'], CO: ['colorado', 'America/Denver'],
  CT: ['connecticut', 'America/New_York'], DE: ['delaware', 'America/New_York'], DC: ['districtofcolumbia', 'America/New_York'],
  FL: ['florida', 'America/New_York'], GA: ['georgia', 'America/New_York'], HI: ['hawaii', 'Pacific/Honolulu'],
  ID: ['idaho', 'America/Boise'], IL: ['illinois', 'America/Chicago'], IN: ['indiana', 'America/Indiana/Indianapolis'],
  IA: ['iowa', 'America/Chicago'], KS: ['kansas', 'America/Chicago'], KY: ['kentucky', 'America/New_York'],
  LA: ['louisiana', 'America/Chicago'], ME: ['maine', 'America/New_York'], MD: ['maryland', 'America/New_York'],
  MA: ['massachusetts', 'America/New_York'], MI: ['michigan', 'America/Detroit'], MN: ['minnesota', 'America/Chicago'],
  MS: ['mississippi', 'America/Chicago'], MO: ['missouri', 'America/Chicago'], MT: ['montana', 'America/Denver'],
  NE: ['nebraska', 'America/Chicago'], NV: ['nevada', 'America/Los_Angeles'], NH: ['newhampshire', 'America/New_York'],
  NJ: ['newjersey', 'America/New_York'], NM: ['newmexico', 'America/Denver'], NY: ['newyork', 'America/New_York'],
  NC: ['northcarolina', 'America/New_York'], ND: ['northdakota', 'America/Chicago'], OH: ['ohio', 'America/New_York'],
  OK: ['oklahoma', 'America/Chicago'], OR: ['oregon', 'America/Los_Angeles'], PA: ['pennsylvania', 'America/New_York'],
  RI: ['rhodeisland', 'America/New_York'], SC: ['southcarolina', 'America/New_York'], SD: ['southdakota', 'America/Chicago'],
  TN: ['tennessee', 'America/Chicago'], TX: ['texas', 'America/Chicago'], UT: ['utah', 'America/Denver'],
  VT: ['vermont', 'America/New_York'], VA: ['virginia', 'America/New_York'], WA: ['washington', 'America/Los_Angeles'],
  WV: ['westvirginia', 'America/New_York'], WI: ['wisconsin', 'America/Chicago'], WY: ['wyoming', 'America/Denver'],
  PR: ['puertorico', 'America/Puerto_Rico'],
};
const AU = {
  NSW: ['newsouthwales', 'Australia/Sydney'], VIC: ['victoria', 'Australia/Melbourne'], QLD: ['queensland', 'Australia/Brisbane'],
  WA: ['westernaustralia', 'Australia/Perth'], SA: ['southaustralia', 'Australia/Adelaide'], TAS: ['tasmania', 'Australia/Hobart'],
  ACT: ['australiancapitalterritory', 'Australia/Sydney'], NT: ['northernterritory', 'Australia/Darwin'],
};
const CA = {
  BC: ['britishcolumbia', 'America/Vancouver'], AB: ['alberta', 'America/Edmonton'], SK: ['saskatchewan', 'America/Regina'],
  MB: ['manitoba', 'America/Winnipeg'], ON: ['ontario', 'America/Toronto'], QC: ['quebec', 'America/Toronto'],
  NB: ['newbrunswick', 'America/Halifax'], NS: ['novascotia', 'America/Halifax'], PE: ['princeedwardisland', 'America/Halifax'],
  NL: ['newfoundlandandlabrador', 'America/St_Johns'],
};
const REGIONS = { US, AU, CA };

const COUNTRIES = {
  US: ['unitedstates', 'unitedstatesofamerica', 'usa', 'us', 'america'],
  GB: ['unitedkingdom', 'uk', 'gb', 'greatbritain', 'england', 'scotland', 'wales', 'northernireland', 'britain'],
  AU: ['australia', 'au'],
  CA: ['canada', 'ca'],
  NZ: ['newzealand', 'nz'],
  IE: ['ireland', 'ie'],
};
const COUNTRY_TZ = { US: DEFAULT_TZ, GB: 'Europe/London', AU: 'Australia/Sydney', CA: 'America/Toronto', NZ: 'Pacific/Auckland', IE: 'Europe/Dublin' };

function countryCode(country) {
  const c = norm(country);
  if (!c) return '';
  for (const [code, names] of Object.entries(COUNTRIES)) if (names.includes(c)) return code;
  return c.length === 2 ? c.toUpperCase() : '';
}

// State/province -> { country, tz }, by abbreviation or full name.
function regionInfo(state, cc) {
  const s = norm(state);
  if (!s) return null;
  const order = cc && REGIONS[cc] ? [cc, ...Object.keys(REGIONS).filter(k => k !== cc)] : Object.keys(REGIONS);
  for (const code of order) {
    for (const [abbr, [name, tz]] of Object.entries(REGIONS[code])) {
      if (s === abbr.toLowerCase() || s === name) return { country: code, tz, name };
    }
  }
  return null;
}

function fromCity(city, state, cc) {
  const c = String(city || '').trim();
  if (!c) return null;
  let hits = cityTimezones.lookupViaCity(c) || [];
  if (!hits.length) return null;
  const region = regionInfo(state, cc);
  const country = cc || (region && region.country);
  if (country) {
    const inCountry = hits.filter(h => h.iso2 === country);
    if (inCountry.length) hits = inCountry;
  }
  if (region) {
    const inRegion = hits.filter(h => norm(h.province) === region.name);
    if (inRegion.length) hits = inRegion;
    else if (country && hits.every(h => h.iso2 === country)) return region.tz;   // city not in that state: trust the state
  }
  hits.sort((a, b) => (b.pop || 0) - (a.pop || 0));
  return validTz(hits[0].timezone) ? hits[0].timezone : null;
}

// Returns { tz, source } where source says how it was worked out.
function resolveTimezone({ timezone, city, state, country } = {}) {
  const cc = countryCode(country);
  const byCity = fromCity(city, state, cc);
  if (byCity) return { tz: byCity, source: 'city' };
  const region = regionInfo(state, cc);
  if (region) return { tz: region.tz, source: 'state' };
  if (validTz(timezone)) return { tz: timezone, source: 'ghl' };
  if (cc && COUNTRY_TZ[cc]) return { tz: COUNTRY_TZ[cc], source: 'country' };
  return { tz: DEFAULT_TZ, source: 'default' };
}

module.exports = { resolveTimezone, DEFAULT_TZ };
