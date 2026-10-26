'use strict';

/**
 * Reads the 18 mailboxes and routes every inbound message that belongs to this
 * campaign:
 *   bounce                         -> stop, Email DND, Bounced stage
 *   auto-reply: business closed    -> stop
 *   auto-reply: email changed      -> switch to the new address, restart the sequence
 *                                     (no usable address -> stop)
 *   auto-reply: out of office      -> tag only, sequence continues
 *   clear unsubscribe              -> stop, Email DND, Unsubscribed stage
 *   anything else from a human     -> conversation AI
 *
 * Only threads this app started (or emails from its own enrolled leads) are
 * touched, so it never interferes with the voice campaign in the same inboxes.
 */

const pool = require('./pool');
const crm = require('./crm');
const { listInboxIds, getSender, getInboundMessage } = require('./gmail');
const { handleConversationalReply, handleNegativeReply } = require('./conversationHandler');

// Leads in these states are not monitored any more.
const CLOSED_STATUSES = ['unsubscribed', 'bounced', 'stopped', 'handoff'];

const detectorStatus = { lastStartedAt: null, lastFinishedAt: null, lastError: null, lastPushAt: null };

// ─── Auto-replies ────────────────────────────────────────────────────────────
function autoReplyKind(msg) {
  const text = `${msg.subject || ''}\n${msg.body || msg.snippet || ''}`.toLowerCase();
  if (/permanently closed|no longer in business|out of business|ceased (operations|trading)|(has|have) (permanently )?closed (its|our) doors|(clinic|business|office|company|shop) (is|has) (now )?(permanently )?closed|closed (for good|permanently)/.test(text)) {
    return 'closed';
  }
  if (/no longer (with|at|employed|working|works)|(has|have) left (the|our) (company|business|team)|no longer (active|monitored|in use|checked)|(not|isn't|is not) (being )?monitored|email (address )?(has )?changed|new (email|e-mail) address|update (your |our )?(contact|e-?mail)|please (direct|send|forward|email|contact) .{0,60}@/.test(text)) {
    return 'wrongemail';
  }
  return 'outofoffice';
}
const AUTO_REPLY_TAGS = { closed: 'autoreply_closed', wrongemail: 'autoreply_wrongemail', outofoffice: 'autoreply_outofoffice' };

const UNSUB_RE = /\b(unsubscribe|opt[ -]?out|remove me|take me off|stop (emailing|contacting|sending)|do not (email|contact)|don'?t (email|contact))\b/i;

// ─── "Please email X instead" ────────────────────────────────────────────────
const GENERIC_INBOXES = new Set(['info', 'office', 'contact', 'admin', 'support', 'sales', 'hello', 'hi', 'team',
  'service', 'services', 'reception', 'frontdesk', 'front', 'mail', 'email', 'help', 'billing', 'accounts',
  'inquiries', 'enquiries', 'inquiry', 'booking', 'bookings', 'dispatch', 'customerservice', 'care', 'main']);

async function findRedirectAddress(msg, enrollment) {
  const text = `${msg.subject || ''}\n${msg.body || msg.snippet || ''}`;
  const found = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(e => e.toLowerCase());
  const { rows } = await pool.query('SELECT email FROM mailboxes');
  const ourDomains = new Set(rows.map(r => r.email.split('@')[1].toLowerCase()));
  const sender = String(msg.from || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const skip = new Set([String(enrollment.prospect_email || '').toLowerCase(), sender ? sender[0].toLowerCase() : '']);
  return found.find(e =>
    !skip.has(e) &&
    !ourDomains.has(e.split('@')[1]) &&
    !/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster)/.test(e)
  ) || null;
}

function nameFromAddress(email, companyName) {
  const local = email.split('@')[0].toLowerCase();
  const first = (local.match(/^([a-z]{2,15})(?:[._-][a-z]+)?$/) || [])[1];
  if (!first || GENERIC_INBOXES.has(first)) return null;
  if (String(companyName || '').toLowerCase().split(/[^a-z]+/).includes(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Switches the lead to the new address and restarts the sequence from email 1
// in a fresh thread. Updates the GHL contact too. False = no usable address.
async function redirectToNewAddress(enrollment, msg) {
  const newEmail = await findRedirectAddress(msg, enrollment);
  if (!newEmail) return false;

  const { rows: dupes } = await pool.query(
    'SELECT id FROM enrollments WHERE lower(prospect_email) = $1 AND id <> $2 LIMIT 1', [newEmail, enrollment.id]);
  if (dupes.length) {
    console.log(`[detect] ${newEmail} already enrolled (id ${dupes[0].id}), not restarting ${enrollment.id}`);
    return false;
  }

  const personName = nameFromAddress(newEmail, enrollment.company_name);
  await pool.query(
    `UPDATE enrollments SET
       prospect_email = $2, prospect_name = $3,
       step = 0, status = 'active', next_send_at = NOW(),
       thread_id = NULL, thread_ids = '{}', last_message_id = NULL, mailbox = NULL, last_sent_at = NULL,
       conversation_history = '[]'::jsonb, conv_status = NULL, conv_followup_at = NULL, calendar_sent_at = NULL, first_subject = NULL
     WHERE id = $1`,
    [enrollment.id, newEmail, personName || enrollment.company_name || '']
  );

  const update = { email: newEmail };
  if (personName) update.firstName = personName;
  await crm.updateContact(enrollment.contact_id, update);
  await crm.addNote(enrollment.contact_id,
    `Call Campaign: auto-reply said ${enrollment.prospect_email} is no longer used. Switched to ${newEmail} and restarted the sequence.`);
  await crm.moveStage(enrollment, 'inSequence');

  console.log(`[detect] ${enrollment.prospect_email} -> redirected to ${newEmail}, sequence restarted`);
  return true;
}

// ─── Collecting this campaign's inbound mail ─────────────────────────────────
const seenNonProspect = new Set();
function rememberNonProspect(id) {
  seenNonProspect.add(id);
  if (seenNonProspect.size > 50000) seenNonProspect.delete(seenNonProspect.values().next().value);
}

// 1. replies in a thread this app started (bounces included), and
// 2. emails from one of this app's leads that started a NEW thread.
async function collectInbound(mailbox) {
  const candidates = await listInboxIds(mailbox, { days: 3, maxIds: 500 });
  if (!candidates.length) return [];

  const threadIds = [...new Set(candidates.map(c => c.threadId))];
  const { rows: known } = await pool.query(
    'SELECT thread_id, thread_ids FROM enrollments WHERE thread_id = ANY($1::text[]) OR thread_ids && $1::text[]', [threadIds]);
  const knownThreads = new Set(known.flatMap(r => [r.thread_id, ...(r.thread_ids || [])]).filter(Boolean));

  const wanted = candidates.filter(c => knownThreads.has(c.threadId));
  const unknown = candidates.filter(c => !knownThreads.has(c.threadId) && !seenNonProspect.has(c.id));

  const senders = [];
  for (let i = 0; i < unknown.length; i += 10) {
    const chunk = await Promise.all(unknown.slice(i, i + 10).map(c => getSender(mailbox, c.id).catch(() => null)));
    senders.push(...chunk.filter(Boolean));
  }
  if (senders.length) {
    // Only leads this mailbox has actually emailed.
    const { rows: matches } = await pool.query(
      `SELECT id, lower(prospect_email) AS email FROM enrollments
        WHERE lower(prospect_email) = ANY($1::text[])
          AND lower(mailbox) = lower($2)
          AND status <> ALL($3::text[])`,
      [[...new Set(senders.map(x => x.from))], mailbox, CLOSED_STATUSES]
    );
    const byEmail = new Map(matches.map(r => [r.email, r.id]));
    for (const x of senders) {
      if (byEmail.has(x.from)) wanted.push({ id: x.id, threadId: x.threadId, matchedEnrollmentId: byEmail.get(x.from) });
      else rememberNonProspect(x.id);
    }
  }

  const out = [];
  for (let i = 0; i < wanted.length; i += 10) {
    const chunk = await Promise.all(wanted.slice(i, i + 10).map(async w => {
      try {
        const msg = await getInboundMessage(mailbox, w.id);
        if (msg.from.includes(mailbox.toLowerCase())) return null;
        if (w.matchedEnrollmentId) msg.matchedEnrollmentId = w.matchedEnrollmentId;
        return msg;
      } catch (e) {
        console.error(`[gmail] message read failed for ${w.id} in ${mailbox}: ${e.message}`);
        return null;
      }
    }));
    out.push(...chunk.filter(Boolean));
  }
  return out;
}

// ─── Handlers ────────────────────────────────────────────────────────────────
async function handleBounce(msg, mailbox) {
  const { rows } = await pool.query(
    `UPDATE enrollments SET status = 'bounced', next_send_at = NULL, conv_followup_at = NULL
      WHERE (thread_id = $1 OR $1 = ANY(thread_ids)) AND status <> ALL($2::text[])
      RETURNING *`,
    [msg.threadId, CLOSED_STATUSES]
  );
  if (!rows.length) return;
  const e = rows[0];
  console.log(`[detect] bounce for ${e.prospect_email}`);
  await crm.addTag(e.contact_id, 'bounced');
  await crm.enableDND(e.contact_id, ['Email'], 'Bounced email address');
  await crm.addNote(e.contact_id, `Call Campaign email bounced.\nSending mailbox: ${mailbox}\nProspect: ${e.prospect_email}\n\nEmail DND enabled.`);
  await crm.moveStage(e, 'bounced');
}

async function handleAutoReply(enrollment, msg) {
  const kind = autoReplyKind(msg);
  console.log(`[detect] ${enrollment.prospect_email} -- auto-reply (${kind}): ${msg.subject}`);
  await crm.addTag(enrollment.contact_id, AUTO_REPLY_TAGS[kind]);

  if (kind === 'wrongemail' && await redirectToNewAddress(enrollment, msg)) return;
  if (kind === 'closed' || kind === 'wrongemail') {
    await pool.query(`UPDATE enrollments SET status = 'stopped', next_send_at = NULL, conv_followup_at = NULL WHERE id = $1`, [enrollment.id]);
    await crm.addNote(enrollment.contact_id,
      `Call Campaign stopped: auto-reply says ${kind === 'closed' ? 'the business is closed' : 'this address is no longer used, and no new address was given'}.\n\n${msg.subject}\n${String(msg.body || '').slice(0, 800)}`);
    console.log(`[detect] ${enrollment.prospect_email} -> stopped (${kind})`);
  }
  // Out of office: the sequence simply carries on.
}

async function processMessage(msg, mailbox) {
  msg.body = msg.body || msg.snippet || '';

  if (msg.bounced) { await handleBounce(msg, mailbox); return; }

  const { rows: enr } = await pool.query(
    `SELECT * FROM enrollments
      WHERE ${msg.matchedEnrollmentId ? 'id = $1' : '(thread_id = $1 OR $1 = ANY(thread_ids))'}
        AND status <> ALL($2::text[])
      LIMIT 1`,
    [msg.matchedEnrollmentId || msg.threadId, CLOSED_STATUSES]
  );
  if (!enr.length) return;

  // Claim the message so it is handled exactly once, and never an older one after a newer one.
  const ts = msg.internalDate || Date.now();
  const claim = await pool.query(
    `UPDATE enrollments SET last_inbound_message_id = $1, last_inbound_at = $3
      WHERE id = $2
        AND last_inbound_message_id IS DISTINCT FROM $1
        AND (last_inbound_at IS NULL OR last_inbound_at < $3)
      RETURNING *`,
    [msg.id, enr[0].id, ts]
  );
  if (!claim.rows.length) return;
  const enrollment = claim.rows[0];

  const enrolledTs = enrollment.enrolled_at ? new Date(enrollment.enrolled_at).getTime() : null;
  if (msg.internalDate && enrolledTs && msg.internalDate < enrolledTs) return;

  // They replied to an earlier email (its own thread): the conversation moves there.
  if (!msg.matchedEnrollmentId && msg.threadId && msg.threadId !== enrollment.thread_id) {
    await pool.query('UPDATE enrollments SET thread_id = $2 WHERE id = $1', [enrollment.id, msg.threadId]);
    enrollment.thread_id = msg.threadId;
  }

  if (msg.autoReply) { await handleAutoReply(enrollment, msg); return; }

  await pool.query('UPDATE enrollments SET replied_at = COALESCE(replied_at, NOW()) WHERE id = $1', [enrollment.id]);
  console.log(`[detect] ${enrollment.prospect_email} replied: ${String(msg.body).replace(/\s+/g, ' ').slice(0, 120)}`);

  // A clear unsubscribe never waits on the AI.
  if (UNSUB_RE.test(`${msg.subject}\n${msg.body}`) && String(msg.body).length < 400) {
    await handleNegativeReply(enrollment, msg.body);
    return;
  }
  await handleConversationalReply(enrollment, msg);
}

let running = false;
async function detectRepliesAndBounces() {
  if (running) return;           // a push and the timer can overlap; one pass at a time
  running = true;
  detectorStatus.lastStartedAt = new Date().toISOString();
  try {
    const { rows: mailboxes } = await pool.query('SELECT email FROM mailboxes');
    for (const { email } of mailboxes) {
      try {
        const all = await collectInbound(email);
        // Keep the newest real message per thread: the AI reads the whole thread anyway.
        const keyOf = m => (m.matchedEnrollmentId ? 'enr:' + m.matchedEnrollmentId : m.threadId);
        const newest = new Map();
        for (const m of all) {
          if (m.bounced) continue;
          const prev = newest.get(keyOf(m));
          if (!prev || (m.internalDate || 0) > (prev.internalDate || 0)) newest.set(keyOf(m), m);
        }
        const messages = all.filter(m => m.bounced || newest.get(keyOf(m)) === m);

        for (const msg of messages) {
          try { await processMessage(msg, email); }
          catch (e) { console.error(`[detect] message ${msg.id} in ${email} failed: ${e.message}`); }
        }
      } catch (err) {
        console.error(`[detect] failed for ${email}: ${err.message}`);
      }
    }
    detectorStatus.lastError = null;
  } catch (err) {
    detectorStatus.lastError = err.message;
    console.error('[detect] error:', err.message);
  } finally {
    running = false;
    detectorStatus.lastFinishedAt = new Date().toISOString();
  }
}

module.exports = {
  detectRepliesAndBounces, detectorStatus,
  // exported for tests
  autoReplyKind, nameFromAddress, findRedirectAddress, CLOSED_STATUSES, UNSUB_RE,
};
