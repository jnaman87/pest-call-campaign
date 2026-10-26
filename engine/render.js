'use strict';

// Turns a plain-text email from campaign.js into the subject and HTML body sent.

const CFG = require('../config');
const CAMPAIGN = require('../campaign');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Placeholder text scrapers sometimes leave behind. Treated as empty.
function clean(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return '';
  if (/^(none|n\/a|na|null|unknown|not found|nothing|fallback)\b/i.test(t)) return '';
  return t.replace(/^fallback\s*-\s*/i, '');
}

// ─── Tracks ──────────────────────────────────────────────────────────────────
const usable = s => Array.isArray(s.steps) && s.steps.length > 0;
const DAY = 86400000;

// Today's date (YYYY-MM-DD) in the campaign's timezone.
function todayStr(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: CFG.limits.resetTimezone || 'UTC' });
}
const dateMs = d => Date.parse(d + 'T00:00:00Z');
function totalDays(t) { return t.steps.reduce((n, st) => n + (Number(st.delayDays) || 0), 0); }

// Founding-partner spots shown on a given day (Track C countdown).
function spotsOn(t, day = todayStr()) {
  if (!t.countdownStart || !Array.isArray(t.countdown) || !t.countdown.length) return '';
  const elapsed = Math.floor((dateMs(day) - dateMs(t.countdownStart)) / DAY);
  if (elapsed < 0) return t.countdown[0].spots;
  let acc = 0;
  for (const c of t.countdown) { acc += c.days; if (elapsed < acc) return c.spots; }
  return t.countdown[t.countdown.length - 1].spots;
}

// Can a track still send email today? (Track C closes.)
function trackOpen(t, day = todayStr()) {
  return !t.closesOn || dateMs(day) <= dateMs(t.closesOn);
}

// Can a NEW lead join the track today? A track with a close date only takes
// leads whose whole sequence fits before it closes.
function trackEnabled(key, day = todayStr()) {
  const t = CAMPAIGN.tracks[key];
  if (!t || !usable(t)) return false;
  if (t.closesOn && dateMs(day) + totalDays(t) * DAY > dateMs(t.closesOn)) return false;
  const text = JSON.stringify(t.steps);
  if (/\{\{\s*spots_(left|open)\s*\}\}/.test(text) && spotsOn(t, day) === '') return false;
  if (/\{\{\s*date\s*\}\}/.test(text) && !String(t.closeDate || '').trim()) return false;
  return true;
}
function enabledTracks() { return Object.keys(CAMPAIGN.tracks).filter(k => trackEnabled(k)); }

// Rotates through the enabled tracks, unless a valid track was asked for.
function chooseTrack(requested, counter) {
  const on = enabledTracks();
  if (!on.length) return null;
  const want = String(requested || '').trim().toUpperCase();
  if (on.includes(want)) return want;
  return on[Math.abs(Number(counter) || 0) % on.length];
}

function trackOf(enrollment) {
  const k = enrollment.track && CAMPAIGN.tracks[enrollment.track] ? enrollment.track : Object.keys(CAMPAIGN.tracks)[0];
  return CAMPAIGN.tracks[k];
}

// ─── Merge fields ────────────────────────────────────────────────────────────
function fields(enrollment, persona) {
  const t = trackOf(enrollment) || {};
  return {
    company      : clean(enrollment.company_name) || 'your business',
    city         : clean(enrollment.prospect_city) || 'your area',
    hook         : clean(enrollment.personalisation_hook),
    pain         : clean(enrollment.current_pain),
    spots_left   : String(spotsOn(t)),
    spots_open   : spotsOn(t) === '' ? '' : `${spotsOn(t)} spot${Number(spotsOn(t)) === 1 ? '' : 's'}`,
    date         : String(t.closeDate || '').trim(),
    sender_name  : persona.fullName,
    sender_first : String(persona.fullName || '').split(/\s+/)[0],
    sender_title : persona.title,
    director     : CFG.director.name,
    calendar_link: CFG.calendarLink,
    our_company  : CFG.company.name,
  };
}

function fill(text, f) {
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => (k in f ? f[k] : ''));
}

// Lines that contained only an empty merge field disappear entirely.
function fillDroppingEmptyLines(text, f) {
  return String(text || '')
    .split('\n')
    .filter(line => !line.match(/\{\{\s*([a-z_]+)\s*\}\}/) || fill(line, f).trim().length > 0)
    .map(line => fill(line, f))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toHtml(text) {
  const linkify = s => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return String(text)
    .split(/\n{2,}/)
    .map(p => '<p>' + linkify(escapeHtml(p.trim())).replace(/\n/g, '<br>') + '</p>')
    .join('\n');
}

// False once the lead's track has closed (Track C after closesOn).
function canSend(enrollment) { return trackOpen(trackOf(enrollment)); }

function stepCount(enrollment) { return trackOf(enrollment).steps.length; }

function delayBeforeStep(enrollment, i) {
  const st = trackOf(enrollment).steps[i];
  return st ? Math.max(0, Number(st.delayDays) || 0) : null;
}

// Returns { subject, html } for the lead's current step, picking a random variant.
function renderStep(i, enrollment, persona) {
  const st = trackOf(enrollment).steps[i];
  if (!st || !Array.isArray(st.variants) || !st.variants.length) return null;
  const v = st.variants[Math.floor(Math.random() * st.variants.length)];
  const f = fields(enrollment, persona);
  const body = fillDroppingEmptyLines(v.body, f);
  const signature = fill(CAMPAIGN.signature, f);
  const html = toHtml(body + '\n\n' + signature) +
    '\n<p>---<br>' + escapeHtml(CAMPAIGN.unsubscribeLine) + '</p>';
  return { subject: fill(v.subject, f).replace(/\s+/g, ' ').trim(), html };
}

// Any track still holding PLACEHOLDER text.
function hasPlaceholders() {
  return Object.values(CAMPAIGN.tracks).some(t => /PLACEHOLDER/.test(JSON.stringify(t.steps)));
}

module.exports = {
  renderStep, stepCount, delayBeforeStep, fields, fill, toHtml, escapeHtml,
  chooseTrack, enabledTracks, trackEnabled, hasPlaceholders, canSend, spotsOn, todayStr,
};
