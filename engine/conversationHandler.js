'use strict';

/**
 * Handles a real (human) reply from a prospect.
 *
 * Any human reply stops the cold sequence for that lead: from then on only the
 * conversation AI writes to them. Outcomes:
 *   reply    -> AI answers (and sends the calendar link when they agree)
 *   handoff  -> prospect is told the director takes over, director is alerted
 *   no_reply -> nothing sent
 *   negative -> lead stopped, DND, Unsubscribed stage
 */

const pool = require('./pool');
const CFG = require('../config');
const crm = require('./crm');
const { sendEmail, getThreadTranscript } = require('./gmail');
const { runPipeline } = require('./aiPipeline');
const { getPersona, directorMode } = require('./personas');
const { escapeHtml, spotsOn } = require('./render');
const CAMPAIGN = require('../campaign');

const CALENDAR_LINK = CFG.calendarLink;
const DIRECTOR = CFG.director.name;
const DIRECTOR_TITLE = CFG.director.title;
const NUDGE_AFTER_DAYS = 2;   // one reminder if they got the link but didn't book
const HANDOFF_ALERT_EMAIL = process.env.HANDOFF_ALERT_EMAIL || '';
const UNSUB_FOOTER = 'To stop receiving these emails, reply with "unsubscribe".';

// ─── Formatting ──────────────────────────────────────────────────────────────
function cleanReplyFormatting(text) {
  const paragraphs = [];
  let buffer = '';
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) { if (buffer) { paragraphs.push(buffer); buffer = ''; } continue; }
    if (buffer) {
      if (/[.?!:]$/.test(buffer.trimEnd())) { paragraphs.push(buffer); buffer = t; }
      else buffer = buffer.trimEnd() + ' ' + t;
    } else buffer = t;
  }
  if (buffer) paragraphs.push(buffer);
  return paragraphs.join('\n\n');
}

// Last line of defence: no reply ever goes out opening with "Hi John," / "John," / "Hey there!".
function stripAiGreeting(text) {
  return String(text || '')
    .replace(/^(?:Hi|Hello|Hey|Dear|Greetings|Good (?:morning|afternoon|evening))\b(?:[ \t]+[^,\n!.]+)?[,!.]?\s*/i, '')
    .replace(/^[A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?\s*,[ \t]*\n+/, '')
    .trim()
    .replace(/^./, c => c.toUpperCase());
}

function stripAiSignoff(text) {
  return String(text || '').trim()
    .replace(/\n\s*(?:Best|Regards|Thanks|Thank you|Cheers|Sincerely),?\s*[\s\S]*$/i, '')
    .trim();
}

function buildEmailHtml(text, persona) {
  const body = cleanReplyFormatting(stripAiGreeting(stripAiSignoff(text)));
  const sig = persona.isDirector ? persona.fullName : `${persona.fullName}\n${persona.title} | ${CFG.company.name}`;
  const linkify = s => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  const paras = (body + '\n\n' + sig).split('\n\n')
    .map(p => '<p style="margin:0 0 14px 0;line-height:1.6;">' + linkify(escapeHtml(p)).replace(/\n/g, '<br>') + '</p>')
    .join('');
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px;">' + paras + '</div>' +
    '<p style="color:#999;font-size:11px;margin:16px 0 0 0;">' + escapeHtml(UNSUB_FOOTER) + '</p>';
}

// ─── Thread helpers ──────────────────────────────────────────────────────────
async function loadTranscript(enrollment) {
  try {
    const t = await getThreadTranscript(enrollment.mailbox, enrollment.thread_id);
    if (t.length) return t;
  } catch (e) {
    console.error(`[conv] transcript read failed for ${enrollment.prospect_email}: ${e.message}`);
  }
  const history = Array.isArray(enrollment.conversation_history) ? enrollment.conversation_history : [];
  return history.map(h => ({
    role: h.role === 'prospect' ? 'prospect' : 'us',
    date: h.timestamp || '',
    text: String(h.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  }));
}

// Every prospect message since our last email, so two quick replies get one answer.
function latestProspectText(transcript, msg) {
  const out = [];
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'us') break;
    out.unshift(transcript[i].text);
  }
  return out.filter(Boolean).join('\n\n').trim() || String(msg.body || msg.snippet || '').trim();
}

function appendHistory(enrollment, entries) {
  const history = Array.isArray(enrollment.conversation_history) ? enrollment.conversation_history : [];
  return [...history, ...entries].slice(-40);
}

function replySubject(msg, transcript) {
  // A prospect who wrote a brand-new email is answered in our original thread.
  const threadSubject = transcript.length ? (transcript.find(m => m.subject) || {}).subject : '';
  const subject = (msg && msg.matchedEnrollmentId ? threadSubject : msg && msg.subject) || threadSubject || 'our conversation';
  return /^re:/i.test(subject) ? subject : 'Re: ' + subject;
}

async function sendInThread(enrollment, subject, html) {
  const persona = getPersona(enrollment.mailbox);
  return sendEmail({
    mailbox   : enrollment.mailbox,
    fromName  : persona.fullName,
    to        : enrollment.prospect_email,
    subject   : /^re:/i.test(subject) ? subject : 'Re: ' + subject,
    body      : html,
    threadId  : enrollment.thread_id,
    inReplyTo : enrollment.last_message_id,
    references: enrollment.last_message_id,
  });
}

// ─── Handoff ─────────────────────────────────────────────────────────────────
// When the emails already come from the director, the notice just buys him time.
const HANDOFF_NOTICE = directorMode()
  ? "Thanks for this. Let me come back to you on it properly, you'll have a reply from me here shortly."
  : `Thanks for this. I've passed our conversation to ${DIRECTOR}, our ${DIRECTOR_TITLE}, and he'll take it from here personally. ` +
    'Expect a reply from him in this thread soon.';

async function alertDirector(enrollment, { headline, reason, summary, latestText, transcript, attempts }) {
  if (!HANDOFF_ALERT_EMAIL) {
    console.error(`[handoff] HANDOFF_ALERT_EMAIL not set, no alert emailed for ${enrollment.prospect_email}`);
    return;
  }
  const recent = (transcript || []).slice(-6).map(m =>
    `<p style="margin:0 0 10px 0;"><b>${m.role === 'us' ? 'Us' : 'Prospect'}</b> ${escapeHtml(m.date || '')}<br>` +
    escapeHtml(m.text || '').replace(/\n/g, '<br>') + '</p>').join('');
  const drafts = (attempts || []).filter(a => a.draft).map(a =>
    `<li>Score ${a.score}: ${escapeHtml(a.draft)}` +
    (a.issues && a.issues.length ? `<br><i>${escapeHtml(a.issues.join('; '))}</i>` : '') + '</li>').join('');

  const html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:680px;">' +
    `<h2 style="margin:0 0 12px 0;">${escapeHtml(headline)}</h2>` +
    `<p><b>Campaign:</b> Call Campaign<br>` +
    `<b>Prospect:</b> ${escapeHtml(enrollment.prospect_name || '')} &lt;${escapeHtml(enrollment.prospect_email)}&gt;<br>` +
    `<b>Company:</b> ${escapeHtml(enrollment.company_name || '')}${enrollment.prospect_city ? ', ' + escapeHtml(enrollment.prospect_city) : ''}<br>` +
    `<b>Reply from mailbox:</b> ${escapeHtml(enrollment.mailbox)}<br>` +
    `<b>Enrollment id:</b> ${enrollment.id}</p>` +
    `<p><b>Why:</b> ${escapeHtml(reason || '')}</p>` +
    (summary ? `<p><b>Where they stand:</b> ${escapeHtml(summary)}</p>` : '') +
    `<p><b>Their latest message:</b><br>${escapeHtml(latestText || '').replace(/\n/g, '<br>')}</p>` +
    (drafts ? `<p><b>Rejected AI drafts:</b></p><ul>${drafts}</ul>` : '') +
    '<hr><p><b>Recent thread:</b></p>' + recent +
    `<hr><p style="color:#666;font-size:12px;">All automated emails to this lead are paused. Reply from ${escapeHtml(enrollment.mailbox)} ` +
    'in the same thread. To hand the lead back to the AI, run:<br>' +
    `<code>UPDATE enrollments SET status = 'conversation', conv_status = 'active' WHERE id = ${enrollment.id};</code></p></div>`;

  try {
    await sendEmail({
      mailbox : enrollment.mailbox,
      fromName: `${CFG.company.name} Alerts`,
      to      : HANDOFF_ALERT_EMAIL,
      subject : `[Call Campaign handoff] ${enrollment.company_name || enrollment.prospect_email}: ${headline}`,
      body    : html,
    });
    console.log(`[handoff] alert emailed for ${enrollment.prospect_email}`);
  } catch (e) {
    console.error(`[handoff] alert email failed for ${enrollment.prospect_email}: ${e.message}`);
  }
}

async function handoff(enrollment, msg, transcript, latestText, result) {
  const persona = getPersona(enrollment.mailbox);
  const already = enrollment.status === 'handoff';
  const booked = enrollment.status === 'booked';
  let sent = null;

  // Tell the prospect once. Later messages, and booked leads, only alert the director.
  if (!already && !booked) {
    try {
      sent = await sendInThread(enrollment, replySubject(msg, transcript), buildEmailHtml(HANDOFF_NOTICE, persona));
    } catch (e) {
      console.error(`[handoff] notice send failed for ${enrollment.prospect_email}: ${e.message}`);
    }
  }

  const history = appendHistory(enrollment, [
    { role: 'prospect', content: latestText, timestamp: new Date().toISOString(), msgId: msg.id },
    ...(sent ? [{ role: 'assistant', content: HANDOFF_NOTICE, timestamp: new Date().toISOString(), type: 'handoff' }] : []),
  ]);

  // A booked lead stays 'booked'; it only gets the alert.
  await pool.query(
    `UPDATE enrollments
        SET status = CASE WHEN status = 'booked' THEN status ELSE 'handoff' END,
            conv_status = 'human_handoff',
            next_send_at = NULL,
            conv_followup_at = NULL,
            handoff_at = COALESCE(handoff_at, NOW()),
            handoff_reason = $2,
            conversation_history = $3::jsonb,
            last_message_id = COALESCE($4, last_message_id),
            last_conv_at = NOW()
      WHERE id = $1`,
    [enrollment.id, result.reason || '', JSON.stringify(history), sent ? sent.messageId : null]
  );

  if (!already && enrollment.status !== 'booked') {
    await crm.addTag(enrollment.contact_id, 'human_handoff');
    await crm.moveStage(enrollment, 'handoff');
    await crm.addNote(enrollment.contact_id,
      `Call Campaign: AI handed this conversation to ${DIRECTOR}.\nReason: ${result.reason || ''}` +
      (result.summary ? `\nSummary: ${result.summary}` : '') + `\n\nLatest message:\n${latestText}`);
  }

  await alertDirector(enrollment, {
    headline  : already ? 'New message in a thread you own' : enrollment.status === 'booked' ? 'Booked lead wrote in' : 'Prospect needs you',
    reason    : result.reason,
    summary   : result.summary,
    latestText, transcript,
    attempts  : result.attempts,
  });
  console.log(`[handoff] ${enrollment.prospect_email} -> ${DIRECTOR} (${result.reason || ''})`);
}

// ─── Negative / unsubscribe ──────────────────────────────────────────────────
async function handleNegativeReply(enrollment, text) {
  const t = String(text || '').toLowerCase();
  const unsub = /\b(unsubscribe|opt[ -]?out|remove me|stop emailing|stop contacting|take me off|do not (email|contact)|don't (email|contact))\b/.test(t);

  await crm.addTag(enrollment.contact_id, 'reply_negative');
  if (unsub) await crm.addTag(enrollment.contact_id, 'unsubscribed');
  await crm.enableDND(enrollment.contact_id, ['Email'], 'Replied: not interested / unsubscribe');
  await crm.moveStage(enrollment, 'unsubscribed');

  await pool.query(
    `UPDATE enrollments
        SET status = $2, conv_status = 'negative', next_send_at = NULL, conv_followup_at = NULL, last_conv_at = NOW()
      WHERE id = $1`,
    [enrollment.id, unsub ? 'unsubscribed' : 'stopped']
  );
  console.log(`[conv] ${enrollment.prospect_email} -> negative${unsub ? ' (unsubscribe)' : ''}, campaign stopped`);
}

// What the AI may say about the founding-partner offer (Track C leads only).
function trackFacts(enrollment) {
  const t = CAMPAIGN.tracks[enrollment.track];
  if (!t || !t.countdown) return [];
  const n = spotsOn(t);
  return [
    `This prospect was offered one of our first 5 founding pest control company spots.`,
    `Founding spots open right now: ${n} of 5.`,
    `The founding list closes at ${t.closeDate}.`,
  ];
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function handleConversationalReply(enrollment, msg) {
  const persona = getPersona(enrollment.mailbox);
  try {
    const transcript = await loadTranscript(enrollment);
    const latestText = latestProspectText(transcript, msg);

    // The director owns handed-off threads, and every booked lead.
    if (enrollment.status === 'handoff') {
      await handoff(enrollment, msg, transcript, latestText, { reason: 'Prospect wrote again after the handoff.' });
      return;
    }
    if (enrollment.status === 'booked') {
      // Still honour an unsubscribe from a booked lead.
      if (/\b(unsubscribe|remove me|stop emailing)\b/i.test(latestText)) { await handleNegativeReply(enrollment, latestText); return; }
      await handoff(enrollment, msg, transcript, latestText, { reason: 'This lead already booked a call and wrote in again.' });
      return;
    }

    // First human reply: the cold sequence stops for good.
    const firstReply = enrollment.status !== 'conversation';
    if (firstReply) {
      await pool.query(`UPDATE enrollments SET status = 'conversation', next_send_at = NULL WHERE id = $1`, [enrollment.id]);
      enrollment.status = 'conversation';
      await crm.addTag(enrollment.contact_id, 'reply_received');
      await crm.moveStage(enrollment, 'replyReceived');
    }

    const result = await runPipeline({
      persona,
      companyName : enrollment.company_name,
      city        : enrollment.prospect_city,
      calendarLink: CALENDAR_LINK,
      extraFacts  : trackFacts(enrollment),
      transcript,
      latestText,
    });

    if (result.action === 'negative') { await handleNegativeReply(enrollment, latestText); return; }
    if (result.action === 'handoff')  { await handoff(enrollment, msg, transcript, latestText, result); return; }
    if (result.action === 'no_reply') {
      const history = appendHistory(enrollment, [{ role: 'prospect', content: latestText, timestamp: new Date().toISOString(), msgId: msg.id }]);
      await pool.query('UPDATE enrollments SET conversation_history = $1::jsonb, last_conv_at = NOW() WHERE id = $2',
        [JSON.stringify(history), enrollment.id]);
      console.log(`[conv] ${enrollment.prospect_email} -> no reply needed (${result.reason})`);
      return;
    }

    let sent;
    try {
      sent = await sendInThread(enrollment, replySubject(msg, transcript), buildEmailHtml(result.text, persona));
    } catch (e) {
      console.error(`[conv] send failed for ${enrollment.prospect_email}: ${e.message}`);
      return;
    }

    const calendarSent = Boolean(result.includesCalendar);
    if (calendarSent) {
      await crm.addTag(enrollment.contact_id, 'calendar_sent');
      await crm.moveStage(enrollment, 'calendarSent');
    }

    const history = appendHistory(enrollment, [
      { role: 'prospect', content: latestText, timestamp: new Date().toISOString(), msgId: msg.id },
      { role: 'assistant', content: result.text, timestamp: new Date().toISOString(), score: result.score || null },
    ]);
    await pool.query(
      `UPDATE enrollments SET
         conversation_history = $2::jsonb,
         conv_status = CASE WHEN $3 THEN 'calendar_sent' ELSE COALESCE(conv_status, 'active') END,
         calendar_sent_at = CASE WHEN $3 THEN NOW() ELSE calendar_sent_at END,
         conv_followup_at = CASE WHEN $3 AND conv_status IS DISTINCT FROM 'calendar_nudged'
                                 THEN NOW() + INTERVAL '${NUDGE_AFTER_DAYS} days' ELSE conv_followup_at END,
         last_message_id = $4,
         last_conv_at = NOW()
       WHERE id = $1`,
      [enrollment.id, JSON.stringify(history), calendarSent, sent.messageId]
    );
    console.log(`[conv] ${enrollment.prospect_email} -> replied (score ${result.score})${calendarSent ? ', calendar link sent' : ''}`);
  } catch (e) {
    console.error(`[conv] error handling reply for ${enrollment.prospect_email}: ${e.message}`);
  }
}

// One reminder, fixed wording, if they got the link and haven't booked or written back.
async function sendCalendarNudge(enrollment) {
  const persona = getPersona(enrollment.mailbox);
  const company = enrollment.company_name || 'your business';
  const text = persona.isDirector
    ? `Here's the link again to grab 15 minutes with me whenever suits: ${CALENDAR_LINK}` +
      `\n\nI'll show you how it would run for ${company} and answer any questions you have.`
    : `Here is the link again to grab a time with ${DIRECTOR}, our ${DIRECTOR_TITLE}, whenever suits: ${CALENDAR_LINK}` +
      `\n\nHe can answer any questions you have about how this would work for ${company}.`;

  const transcript = await loadTranscript(enrollment);
  const subject = (transcript.find(m => m.subject) || {}).subject || (enrollment.company_name || 'our conversation');

  let sent;
  try {
    sent = await sendInThread(enrollment, subject, buildEmailHtml(text, persona));
  } catch (e) {
    console.error(`[conv] nudge send failed for ${enrollment.prospect_email}: ${e.message}`);
    return false;
  }
  const history = appendHistory(enrollment, [{ role: 'assistant', content: text, timestamp: new Date().toISOString(), type: 'nudge' }]);
  await pool.query(
    `UPDATE enrollments SET conversation_history = $2::jsonb, last_message_id = $3, last_conv_at = NOW(),
            conv_status = 'calendar_nudged', conv_followup_at = NULL
      WHERE id = $1`,
    [enrollment.id, JSON.stringify(history), sent.messageId]
  );
  console.log(`[conv] ${enrollment.prospect_email} -> calendar nudge sent`);
  return true;
}

module.exports = {
  handleConversationalReply, handleNegativeReply, sendCalendarNudge,
  // exported for tests
  latestProspectText, buildEmailHtml, replySubject,
};
