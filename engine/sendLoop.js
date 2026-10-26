'use strict';

/**
 * Sends the cold sequence.
 *  - new leads go out from the mailbox with room left today that sent least recently
 *  - follow-ups stay in the same mailbox; one with its own subject starts a new
 *    thread, one with an empty subject replies in the previous thread
 *  - per-mailbox daily caps (this campaign only), prospect-local send window, pause between sends
 *  - after the last email: wait noReplyGraceDays, then No Replies
 *  - one calendar reminder for leads who got the link and didn't book
 */

const pool = require('./pool');
const CFG = require('../config');
const crm = require('./crm');
const { sendEmail } = require('./gmail');
const { getPersona } = require('./personas');
const { renderStep, stepCount, delayBeforeStep, canSend } = require('./render');
const { sendCalendarNudge } = require('./conversationHandler');

const L = CFG.limits;
const TZ = L.resetTimezone || 'UTC';
const TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE '${TZ.replace(/'/g, '')}')::DATE`;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const START = num(L.sendWindowStartHour, 8);
const END = num(L.sendWindowEndHour, 18);
const GAP_MS = num(L.secondsBetweenSends, 75) * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function inSendWindow(tz) {
  try {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    return hour >= START && hour < END;
  } catch {
    return false;
  }
}

async function pickMailbox(client) {
  const { rows } = await client.query(
    `SELECT email FROM mailboxes
      WHERE daily_reset_at < ${TODAY} OR daily_count < $1
      ORDER BY last_sent_at NULLS FIRST
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    [L.newLeadsPerMailbox]
  );
  return rows[0] ? rows[0].email : null;
}

async function followupRoom(client, mailbox) {
  const { rows } = await client.query(
    `SELECT 1 FROM mailboxes WHERE email = $1 AND (daily_reset_at < ${TODAY} OR daily_followups < $2)`,
    [mailbox, L.followupsPerMailbox]
  );
  return rows.length > 0;
}

async function countSend(mailbox, isNew) {
  await pool.query(
    `UPDATE mailboxes SET
       last_sent_at    = NOW(),
       daily_count     = CASE WHEN daily_reset_at < ${TODAY} THEN $2 ELSE daily_count + $2 END,
       daily_followups = CASE WHEN daily_reset_at < ${TODAY} THEN $3 ELSE daily_followups + $3 END,
       daily_reset_at  = ${TODAY}
     WHERE email = $1`,
    [mailbox, isNew ? 1 : 0, isNew ? 0 : 1]
  );
}

async function finaliseNoReply(enrollment) {
  await pool.query(`UPDATE enrollments SET status = 'completed', next_send_at = NULL WHERE id = $1 AND status = 'awaiting_no_reply'`, [enrollment.id]);
  await crm.addTag(enrollment.contact_id, 'no_response');
  await crm.moveStage(enrollment, 'noReplies');
  console.log(`[loop] ${enrollment.prospect_email} -> No Replies`);
}

// Sends at most one email. Returns true if something was sent.
async function processCandidate(id) {
  const client = await pool.connect();
  let released = false;
  const release = () => { if (!released) { released = true; client.release(); } };

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`callcamp:send:${id}`]);
    const { rows } = await client.query(
      `SELECT * FROM enrollments WHERE id = $1 AND status IN ('active', 'awaiting_no_reply') AND next_send_at <= NOW() FOR UPDATE`, [id]);
    if (!rows.length) { await client.query('ROLLBACK'); return false; }
    const enrollment = rows[0];

    if (enrollment.status === 'awaiting_no_reply') {
      await client.query('COMMIT'); release();
      await finaliseNoReply(enrollment);
      return false;
    }
    if (!inSendWindow(enrollment.prospect_tz)) { await client.query('ROLLBACK'); return false; }

    const total = stepCount(enrollment);
    // Track C after the list closes: no more emails, straight to the no-reply wait.
    if (!canSend(enrollment)) {
      await client.query(
        `UPDATE enrollments SET status = 'awaiting_no_reply', next_send_at = NOW() + ($2 || ' days')::interval WHERE id = $1`,
        [id, String(num(L.noReplyGraceDays, 3))]);
      await client.query('COMMIT');
      console.log(`[loop] ${enrollment.prospect_email}: track ${enrollment.track} has closed, remaining emails skipped`);
      return false;
    }
    if (enrollment.step >= total) {
      await client.query(`UPDATE enrollments SET status = 'awaiting_no_reply', next_send_at = NOW() WHERE id = $1`, [id]);
      await client.query('COMMIT');
      return false;
    }

    const isNew = enrollment.step === 0 || !enrollment.mailbox;
    const mailbox = isNew ? await pickMailbox(client) : enrollment.mailbox;
    if (!mailbox) { await client.query('ROLLBACK'); return 'cap'; }
    if (!isNew && !(await followupRoom(client, mailbox))) { await client.query('ROLLBACK'); return false; }

    const persona = getPersona(mailbox);
    const email = renderStep(enrollment.step, enrollment, persona);
    if (!email) { await client.query('ROLLBACK'); console.error(`[loop] campaign.js step ${enrollment.step} is empty`); return false; }

    // Claim the step before sending, so no other process can send it too.
    const nextStep = enrollment.step + 1;
    const done = nextStep >= total;
    const waitDays = done ? num(L.noReplyGraceDays, 3) : delayBeforeStep(enrollment, nextStep);
    await client.query(
      `UPDATE enrollments SET step = $2, mailbox = $3, status = $4,
              next_send_at = NOW() + ($5 || ' days')::interval
        WHERE id = $1`,
      [id, nextStep, mailbox, done ? 'awaiting_no_reply' : 'active', String(waitDays)]
    );
    // Reserve the mailbox slot inside the same transaction.
    await client.query(
      `UPDATE mailboxes SET last_sent_at = NOW() WHERE email = $1`, [mailbox]);
    await client.query('COMMIT'); release();

    // Own subject = a new email. Empty subject = a reply in the previous thread.
    const asReply = !email.subject && enrollment.thread_id;
    let result;
    try {
      result = await sendEmail({
        mailbox,
        fromName  : persona.fullName,
        to        : enrollment.prospect_email,
        subject   : email.subject || `Re: ${enrollment.first_subject || enrollment.company_name || 'our email'}`,
        body      : email.html,
        threadId  : asReply ? enrollment.thread_id : null,
        inReplyTo : asReply ? enrollment.last_message_id : null,
        references: asReply ? enrollment.last_message_id : null,
      });
    } catch (err) {
      // Put the step back so a temporary Gmail failure is retried.
      await pool.query(
        `UPDATE enrollments SET step = $2, status = 'active', next_send_at = NOW() + INTERVAL '15 minutes',
                mailbox = CASE WHEN $4 THEN $5 ELSE mailbox END
          WHERE id = $1 AND step = $3`,
        [id, enrollment.step, nextStep, isNew, enrollment.mailbox]
      ).catch(e => console.error('[loop] release failed:', e.message));
      console.error(`[loop] send failed for ${enrollment.prospect_email} via ${mailbox}: ${err.message}`);
      return false;
    }

    await pool.query(
      `UPDATE enrollments SET thread_id = COALESCE($2, thread_id), last_message_id = $3, last_sent_at = NOW(),
              first_subject = COALESCE(first_subject, $4),
              thread_ids = CASE WHEN $2::text IS NULL OR $2 = ANY(thread_ids) THEN thread_ids ELSE array_append(thread_ids, $2) END
        WHERE id = $1`,
      [id, result.threadId || null, result.messageId || null, email.subject]
    );
    await countSend(mailbox, isNew);
    if (isNew) await crm.addTag(enrollment.contact_id, 'email_1_sent');
    console.log(`[loop] track ${enrollment.track} email ${enrollment.step + 1}/${total} -> ${enrollment.prospect_email} via ${mailbox}`);
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(`[loop] candidate ${id} failed: ${err.message}`);
    return false;
  } finally {
    release();
  }
}

let running = false;
async function runSendLoop() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM enrollments
        WHERE status IN ('active', 'awaiting_no_reply') AND next_send_at <= NOW()
        ORDER BY (status = 'awaiting_no_reply') DESC, step DESC, next_send_at ASC
        LIMIT 25`
    );
    let capHit = false;
    for (const { id } of rows) {
      const r = await processCandidate(id);
      if (r === 'cap') {
        if (!capHit) console.log('[loop] every mailbox has used today\'s new-lead allowance for this campaign');
        capHit = true;
        continue;
      }
      if (r) await sleep(GAP_MS);
    }

    // One calendar reminder for leads who got the link but haven't booked or written back.
    const { rows: nudges } = await pool.query(
      `SELECT * FROM enrollments
        WHERE status = 'conversation' AND conv_status = 'calendar_sent'
          AND conv_followup_at <= NOW()
          AND (last_conv_at IS NULL OR last_conv_at < NOW() - INTERVAL '2 days')
        LIMIT 3`
    );
    for (const e of nudges) {
      if (!inSendWindow(e.prospect_tz)) continue;
      if (await sendCalendarNudge(e)) await sleep(GAP_MS);
    }
  } catch (err) {
    console.error('[loop] error:', err.message);
  } finally {
    running = false;
  }
}

module.exports = { runSendLoop, inSendWindow };
