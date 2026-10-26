'use strict';

/**
 * Creative Copyz Call Campaign
 * One cold email sequence + a conversation AI whose only goal is a booked call.
 *
 *   POST /enroll                 GHL workflow adds a lead
 *   POST /webhook/call-booked    GHL workflow: appointment booked -> campaign stops
 *   POST /gmail-webhook          Gmail push (Pub/Sub) -> reply detector
 *   GET  /admin/reply-audit      read-only check that every reply was processed
 *   GET  /setup/ghl-ids          lists pipeline + stage IDs to paste into config.js
 *   GET  /stats                  counts by status
 *   GET  /                       health
 */

const express = require('express');
const cors = require('cors');
const CFG = require('./config');
const db = require('./db');
const { pool } = db;
const crm = require('./engine/crm');
const { resolveTimezone } = require('./engine/timezone');
const { runSendLoop } = require('./engine/sendLoop');
const { detectRepliesAndBounces, detectorStatus, CLOSED_STATUSES } = require('./engine/replyDetector');
const { searchMessages, watchMailbox, verifyAll } = require('./engine/gmail');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const real = v => v && !/^CHANGE_ME/.test(String(v));

// ─── Helpers ─────────────────────────────────────────────────────────────────
// GHL webhooks send contact fields at the top level, inside "contact", or in
// "customData"; n8n wraps everything in "body". Accept all of them.
function flatten(body) {
  const incoming = Array.isArray(body) ? (body[0] || {}) : (body || {});
  const b = incoming.body && typeof incoming.body === 'object' ? incoming.body : incoming;
  return { ...b, ...(b.contact || {}), ...(b.customData || {}) };
}
function picker(raw) {
  return (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
    }
    return '';
  };
}
function cleanBusinessName(v) {
  return String(v || '').replace(/\s+/g, ' ').replace(/^fallback\s*-\s*/i, '').trim();
}
function normalizeCompany(v) {
  return cleanBusinessName(v).toLowerCase()
    .replace(/\b(llc|inc|ltd|pty|co|corp|corporation|company|limited|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokenOk(req, envName) {
  const want = process.env[envName];
  return !want || req.query.token === want || req.get('x-webhook-token') === want;
}

// ─── Health / stats ──────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ ok: true, app: 'call-campaign', time: new Date().toISOString() }));

app.get('/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM enrollments GROUP BY status ORDER BY n DESC`);
    const { rows: mb } = await pool.query(
      `SELECT email, daily_count AS new_today, daily_followups AS followups_today, daily_reset_at FROM mailboxes ORDER BY email`);
    res.json({ byStatus: rows, mailboxes: mb });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Enroll ──────────────────────────────────────────────────────────────────
app.post('/enroll', async (req, res) => {
  try {
    if (!tokenOk(req, 'WEBHOOK_TOKEN')) return res.status(403).json({ error: 'bad token' });
    const raw = flatten(req.body);
    const pick = picker(raw);

    const email = pick('email', 'Email').toLowerCase();
    if (!email || !/@/.test(email)) return res.status(400).json({ error: 'email is required' });

    // Send window follows the business's local time, worked out from its city.
    const city = pick('city', 'City', 'businessCity', 'business_city');
    const where = resolveTimezone({
      city,
      state  : pick('state', 'State', 'businessState', 'business_state', 'region', 'province'),
      country: pick('country', 'Country', 'businessCountry', 'business_country'),
      timezone: pick('timezone', 'tz', 'Timezone'),
    });
    const result = await db.enroll({
      contactId  : pick('contactId', 'contact_id', 'id', 'Contact Id'),
      email,
      city,
      tz         : where.tz,
      companyName: cleanBusinessName(pick('companyName', 'businessName', 'company_name', 'Company Name')),
      hook       : pick('personalisationHook', 'personalisation_hook', 'Personalisation Hook', 'Personalization Hook'),
      pain       : pick('currentPain', 'current_pain', 'Current Pain'),
      track      : pick('track', 'Track', 'campaignTrack'),
    });

    if (result.duplicate) {
      console.log(`[enroll] already enrolled: ${email} (id ${result.enrollmentId})`);
      return res.json({ success: false, message: 'Already enrolled', enrollmentId: result.enrollmentId });
    }
    console.log(`[enroll] id=${result.enrollmentId} ${email} (track ${result.track}, ${where.tz} from ${where.source})`);
    res.json({ success: true, enrollmentId: result.enrollmentId, track: result.track, timezone: where.tz, timezoneFrom: where.source });

    // The deal in the Call Campaign pipeline (after responding, so GHL never waits on it).
    const { rows } = await pool.query('SELECT * FROM enrollments WHERE id = $1', [result.enrollmentId]);
    if (rows[0]) {
      // GHL shows which track the lead is on: pestcamp_track_a / _b / _c
      crm.addTag(rows[0].contact_id, `track_${String(result.track).toLowerCase()}`).catch(() => {});
      crm.ensureOpportunity(rows[0]).catch(e => console.error('[enroll] opportunity:', e.message));
    }
  } catch (e) {
    console.error('[enroll] error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ─── Call booked ─────────────────────────────────────────────────────────────
// Matches the lead by GHL contact id, then email, then company name.
app.post('/webhook/call-booked', async (req, res) => {
  try {
    if (!tokenOk(req, 'WEBHOOK_TOKEN')) return res.status(403).json({ error: 'bad token' });
    const raw = flatten(req.body);
    const pick = picker(raw);
    const contactId = pick('contactId', 'contact_id', 'id');
    const email = pick('email', 'Email', 'prospect_email').toLowerCase();
    const company = pick('companyName', 'company_name', 'businessName', 'business_name');

    const live = `status NOT IN ('unsubscribed', 'bounced', 'booked')`;
    let rows = [];
    if (contactId) rows = (await pool.query(`SELECT * FROM enrollments WHERE contact_id = $1 AND ${live}`, [contactId])).rows;
    if (!rows.length && email) rows = (await pool.query(`SELECT * FROM enrollments WHERE lower(prospect_email) = $1 AND ${live}`, [email])).rows;
    if (!rows.length && company && normalizeCompany(company)) {
      const { rows: all } = await pool.query(`SELECT * FROM enrollments WHERE company_name <> '' AND ${live}`);
      rows = all.filter(r => normalizeCompany(r.company_name) === normalizeCompany(company));
    }
    if (!rows.length) {
      console.log(`[booked] no enrollment matched (contact ${contactId || '-'}, ${email || '-'}, ${company || '-'})`);
      return res.json({ success: true, stopped: 0, note: 'No matching lead in this campaign' });
    }

    const ids = rows.map(r => r.id);
    await pool.query(
      `UPDATE enrollments SET status = 'booked', next_send_at = NULL, conv_followup_at = NULL,
              conv_status = 'booked', booked_at = NOW()
        WHERE id = ANY($1::int[])`, [ids]);
    for (const e of rows) {
      await crm.addTag(e.contact_id, 'call_booked');
      await crm.moveStage(e, 'callBooked');
    }
    console.log(`[booked] campaign stopped for ${rows.map(r => r.prospect_email).join(', ')}`);
    res.json({ success: true, stopped: rows.length, emails: rows.map(r => r.prospect_email) });
  } catch (e) {
    console.error('[booked] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Gmail push ──────────────────────────────────────────────────────────────
app.post('/gmail-webhook', async (req, res) => {
  res.sendStatus(200);
  detectorStatus.lastPushAt = new Date().toISOString();
  try {
    const m = req.body && req.body.message;
    if (m && m.data) {
      const decoded = JSON.parse(Buffer.from(m.data, 'base64').toString());
      console.log('[push] new mail in', decoded.emailAddress);
    }
  } catch (_) { /* ignore malformed payloads */ }
  detectRepliesAndBounces().catch(e => console.error('[push] detect error:', e.message));
});

// ─── Reply audit (read-only) ─────────────────────────────────────────────────
// GET /admin/reply-audit?token=<AUDIT_TOKEN>&days=14[&mailbox=x@y.com]
// Only looks at this campaign's leads. Mail from voice-campaign leads and
// everyone else is counted as "notThisCampaign".
app.get('/admin/reply-audit', async (req, res) => {
  if (!process.env.AUDIT_TOKEN || req.query.token !== process.env.AUDIT_TOKEN) {
    return res.status(403).json({ error: 'Set AUDIT_TOKEN in Railway and pass ?token=<that value>' });
  }
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 14));
  const now = Date.now();
  const emailOf = from => { const m = String(from || '').match(/<([^>]+)>/); return (m ? m[1] : String(from || '')).trim().toLowerCase(); };
  const only = String(req.query.mailbox || '').trim().toLowerCase();
  const { rows: allMb } = await pool.query('SELECT email FROM mailboxes ORDER BY email');
  const mailboxes = only ? allMb.filter(m => m.email.toLowerCase() === only) : allMb;

  const perMailbox = [];
  const missed = [];
  const totals = { handled: 0, missed: 0, skippedByStatus: 0, autoReplies: 0, bounces: 0, bouncesMissed: 0, notThisCampaign: 0, errors: 0 };

  await Promise.all(mailboxes.map(async ({ email: mailbox }) => {
    const row = { mailbox, scanned: 0, handled: 0, missed: 0, inboxLast3Days: 0, error: null };
    try {
      const { messages } = await searchMessages(mailbox, `in:anywhere newer_than:${days}d -from:me -in:sent -in:drafts`, { maxTotal: 500 });
      row.scanned = messages.length;
      const threadIds = [...new Set(messages.map(m => m.threadId).filter(Boolean))];
      const senders = [...new Set(messages.map(m => emailOf(m.from)).filter(Boolean))];
      const { rows: byThread } = await pool.query(
        `SELECT id, thread_id, thread_ids, prospect_email, company_name, status, last_inbound_message_id, last_inbound_at, conversation_history
           FROM enrollments WHERE thread_id = ANY($1::text[]) OR thread_ids && $1::text[]`, [threadIds]);
      const { rows: byEmail } = await pool.query(
        `SELECT id, prospect_email, company_name, status, mailbox, last_inbound_message_id, last_inbound_at
           FROM enrollments WHERE lower(prospect_email) = ANY($1::text[]) AND lower(mailbox) = lower($2)`, [senders, mailbox]);
      const threadMap = new Map();
      for (const e of byThread) for (const t of [e.thread_id, ...(e.thread_ids || [])]) if (t) threadMap.set(t, e);
      const emailMap = new Map(byEmail.map(e => [e.prospect_email.toLowerCase(), e]));

      for (const m of messages) {
        if (m.error) { totals.errors++; continue; }
        const from = emailOf(m.from);
        const ageDays = m.internalDate ? (now - m.internalDate) / 86400000 : null;
        if ((m.labels || []).includes('INBOX') && ageDays !== null && ageDays <= 3) row.inboxLast3Days++;
        const e = threadMap.get(m.threadId) || emailMap.get(from);

        if (/mailer-daemon|postmaster/.test(from)) {
          if (!threadMap.get(m.threadId)) { totals.notThisCampaign++; continue; }
          totals.bounces++;
          if (e.status !== 'bounced') {
            totals.bouncesMissed++;
            missed.push({ type: 'bounce not recorded', mailbox, prospect: e.prospect_email, enrollmentId: e.id, status: e.status, date: new Date(m.internalDate).toISOString(), subject: m.subject });
          }
          continue;
        }
        if (!e) { totals.notThisCampaign++; continue; }
        if (m.autoReply) { totals.autoReplies++; continue; }

        const history = Array.isArray(e.conversation_history) ? e.conversation_history : [];
        const processed = e.last_inbound_message_id === m.id ||
          (e.last_inbound_at && m.internalDate && Number(e.last_inbound_at) >= m.internalDate) ||
          history.some(h => h && h.msgId === m.id);
        if (processed) { row.handled++; totals.handled++; continue; }
        if (CLOSED_STATUSES.includes(e.status)) { totals.skippedByStatus++; continue; }

        const labels = m.labels || [];
        let type = 'MISSED: in the inbox and recent, but not processed';
        if (labels.includes('SPAM')) type = 'MISSED: reply is in the Spam folder';
        else if (labels.includes('TRASH')) type = 'MISSED: reply is in Trash';
        else if (!labels.includes('INBOX')) type = 'MISSED: archived or filtered out of the inbox';
        else if (ageDays !== null && ageDays > 3) type = 'MISSED: older than the 3-day scan window';
        row.missed++; totals.missed++;
        missed.push({ type, mailbox, from, enrollmentId: e.id, company: e.company_name, status: e.status,
          date: new Date(m.internalDate).toISOString(), subject: m.subject, preview: m.snippet, labels });
      }
    } catch (err) {
      row.error = err.message; totals.errors++;
    }
    if (row.inboxLast3Days > 500) row.warning = `Inbox has ${row.inboxLast3Days} emails from the last 3 days; the detector reads the newest 500.`;
    perMailbox.push(row);
  }));

  perMailbox.sort((a, b) => a.mailbox.localeCompare(b.mailbox));
  missed.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  res.json({
    checkedDays: days,
    verdict: totals.missed || totals.bouncesMissed
      ? `${totals.missed} reply(ies) and ${totals.bouncesMissed} bounce(s) were NOT processed. See "missed".`
      : 'Every reply from a Call Campaign lead in this period was processed.',
    detector: detectorStatus,
    totals, missed, perMailbox,
  });
});

// ─── Track report ────────────────────────────────────────────────────────────
// GET /admin/track-report?token=<AUDIT_TOKEN>&by=week|month|all[&format=json]
// Leads are grouped by the week / month they were ENROLLED, so each row shows
// how that batch has done so far. Recent batches are still in progress.
const TRACK_NAMES = Object.fromEntries(Object.entries(require('./campaign').tracks).map(([k, t]) => [k, t.name]));

async function trackReport(by) {
  const bucket = by === 'week' ? `to_char(date_trunc('week', enrolled_at), 'YYYY-MM-DD')`
    : by === 'month' ? `to_char(date_trunc('month', enrolled_at), 'YYYY-MM')`
    : `'all time'`;
  const { rows } = await pool.query(`
    SELECT ${bucket} AS period, COALESCE(track, '?') AS track,
           count(*)::int                                                     AS leads,
           count(*) FILTER (WHERE last_sent_at IS NOT NULL)::int             AS emailed,
           count(*) FILTER (WHERE replied_at IS NOT NULL)::int               AS replied,
           count(*) FILTER (WHERE calendar_sent_at IS NOT NULL)::int         AS got_link,
           count(*) FILTER (WHERE booked_at IS NOT NULL)::int                AS booked,
           count(*) FILTER (WHERE conv_status = 'negative' OR status = 'unsubscribed')::int AS negative,
           count(*) FILTER (WHERE status = 'bounced')::int                   AS bounced,
           count(*) FILTER (WHERE status IN ('active', 'awaiting_no_reply'))::int AS still_in_sequence
      FROM enrollments
     GROUP BY 1, 2
     ORDER BY 1 DESC, 2`);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  for (const r of rows) {
    r.name = TRACK_NAMES[r.track] || '';
    r.reply_rate = pct(r.replied, r.emailed);
    r.book_rate = pct(r.booked, r.emailed);
    r.negative_rate = pct(r.negative, r.emailed);
  }
  // Best track per period: most bookings per lead emailed, then replies.
  const best = {};
  for (const r of rows) {
    const b = best[r.period];
    if (r.emailed && (!b || r.book_rate > b.book_rate || (r.book_rate === b.book_rate && r.reply_rate > b.reply_rate))) best[r.period] = r;
  }
  return { rows, best: Object.fromEntries(Object.entries(best).map(([p, r]) => [p, r.track])) };
}

app.get('/admin/track-report', async (req, res) => {
  if (!process.env.AUDIT_TOKEN || req.query.token !== process.env.AUDIT_TOKEN) {
    return res.status(403).json({ error: 'Set AUDIT_TOKEN in Railway and pass ?token=<that value>' });
  }
  const by = ['week', 'month'].includes(req.query.by) ? req.query.by : 'all';
  try {
    const report = await trackReport(by);
    if (req.query.format === 'json') return res.json({ groupedBy: by, ...report });

    const esc = v => String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const cols = ['track', 'name', 'leads', 'emailed', 'replied', 'reply_rate', 'got_link', 'booked', 'book_rate', 'negative', 'negative_rate', 'bounced', 'still_in_sequence'];
    const head = { reply_rate: 'reply %', book_rate: 'booked %', negative_rate: 'negative %', got_link: 'got link', still_in_sequence: 'still in sequence' };
    const periods = [...new Set(report.rows.map(r => r.period))];
    const tok = encodeURIComponent(req.query.token);
    const body = periods.map(p => {
      const rs = report.rows.filter(r => r.period === p);
      return `<h2>${by === 'week' ? 'Week of ' : ''}${esc(p)}</h2><table><tr>${cols.map(c => `<th>${esc(head[c] || c)}</th>`).join('')}</tr>` +
        rs.map(r => `<tr class="${report.best[p] === r.track ? 'best' : ''}">${cols.map(c => `<td>${esc(r[c])}${c.endsWith('_rate') ? '%' : ''}</td>`).join('')}</tr>`).join('') +
        `</table>`;
    }).join('') || '<p>No leads yet.</p>';
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Track report</title><style>
body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#1a1a1a;background:#fff}
table{border-collapse:collapse;margin:8px 0 28px;font-size:14px}th,td{border:1px solid #ddd;padding:6px 10px;text-align:right}
th{background:#f5f5f5}td:nth-child(2){text-align:left}tr.best td{background:#e9f7ee;font-weight:600}
nav a{margin-right:14px}p.note{color:#666;font-size:13px;max-width:680px}</style></head><body>
<h1>Call Campaign: track report</h1>
<nav><a href="?token=${tok}&by=all">All time</a><a href="?token=${tok}&by=month">By month</a><a href="?token=${tok}&by=week">By week</a></nav>
<p class="note">Leads are grouped by when they were enrolled. Rates are per lead emailed. Green is the best track in that period
(most bookings, then most replies). Recent batches are still mid-sequence, so judge them once "still in sequence" is near 0.</p>
${body}</body></html>`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Setup helper ────────────────────────────────────────────────────────────
// GET /setup/ghl-ids?token=<SETUP_TOKEN>
app.get('/setup/ghl-ids', async (req, res) => {
  if (!process.env.SETUP_TOKEN || req.query.token !== process.env.SETUP_TOKEN) {
    return res.status(403).json({ error: 'Set SETUP_TOKEN in Railway and pass ?token=<that value>' });
  }
  const r = await crm.ghl('GET', `/opportunities/pipelines?locationId=${encodeURIComponent(crm.LOCATION_ID)}`);
  if (!r.ok) return res.status(502).json({ error: 'GHL request failed', status: r.status, detail: r.data });
  const pipelines = (r.data.pipelines || []).map(p => ({
    name: p.name, pipelineId: p.id,
    stages: (p.stages || []).map(s => ({ name: s.name, id: s.id })),
  }));
  const mine = pipelines.find(p => /call campaign/i.test(p.name));
  res.json({
    note: mine
      ? 'Copy these IDs into config.js under ghl.pipeline.'
      : 'No pipeline named "Call Campaign" found. Create it in GHL, then reload this page.',
    callCampaign: mine || null,
    allPipelines: pipelines,
  });
});

app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Unexpected server error', message: err.message });
});

// ─── Gmail push registration ─────────────────────────────────────────────────
async function watchAll() {
  const { rows } = await pool.query('SELECT email FROM mailboxes');
  for (const { email } of rows) {
    try { await watchMailbox(email, CFG.gmail.pubsubTopic); console.log(`[watch] ${email} registered`); }
    catch (e) { console.error(`[watch] ${email} failed: ${e.message}`); }
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────
function checkConfig() {
  const warn = [];
  if (!real(CFG.calendarLink)) warn.push('config.js calendarLink is not set: prospects who agree are handed to you instead of getting the link');
  if (!real(CFG.offer.summary)) warn.push('config.js offer.summary is not set');
  if (!real(CFG.ghl.pipeline.pipelineId)) warn.push('config.js GHL pipeline IDs are not set: no pipeline stages will move');
  if (!process.env.OPENAI_API_KEY) warn.push('OPENAI_API_KEY missing: every reply will be handed off');
  if (!process.env.CRM_API_KEY) warn.push('CRM_API_KEY missing: no tags, notes or stages in GHL');
  if (!process.env.HANDOFF_ALERT_EMAIL) warn.push('HANDOFF_ALERT_EMAIL missing: you will not be emailed on handoffs');
  const render = require('./engine/render');
  if (render.hasPlaceholders()) warn.push('campaign.js still has PLACEHOLDER emails: sending is PAUSED until the real copy is in');
  const off = Object.keys(require('./campaign').tracks).filter(k => !render.trackEnabled(k));
  if (off.length) warn.push(`track(s) ${off.join(', ')} not taking new leads today (closed or not configured)`);
  console.log(`[config] tracks in rotation: ${render.enabledTracks().join(', ') || 'NONE'}`);
  warn.forEach(w => console.warn('[config] ' + w));
  return warn;
}

db.init()
  .then(async () => {
    app.listen(PORT, () => console.log(`\n=== Creative Copyz Call Campaign on port ${PORT} ===\n`));
    const warnings = checkConfig();
    const saKeys = Object.keys(process.env).filter(k => k.startsWith('GOOGLE_SA_'));
    if (!saKeys.length) { console.log('[boot] no GOOGLE_SA_* keys set, loops not started'); return; }

    const placeholders = warnings.some(w => w.includes('PLACEHOLDER'));
    verifyAll(CFG.mailboxes.map(m => m.email)).catch(() => {});

    // Sending only starts once the real copy is in campaign.js.
    if (!placeholders || process.env.ALLOW_PLACEHOLDER_SEND === 'true') {
      setInterval(runSendLoop, 2 * 60 * 1000);
      setTimeout(runSendLoop, 15 * 1000);
    }
    setInterval(detectRepliesAndBounces, 30 * 60 * 1000);   // safety net; push handles real time
    setTimeout(detectRepliesAndBounces, 20 * 1000);
    if (process.env.DISABLE_GMAIL_WATCH !== 'true') {
      watchAll();
      setInterval(watchAll, 24 * 60 * 60 * 1000);
    }
    console.log('[boot] loops started');
  })
  .catch(e => {
    console.error('[boot] database init failed:', e.message);
    process.exit(1);
  });

module.exports = app;
