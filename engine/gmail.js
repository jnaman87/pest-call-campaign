'use strict';

const { JWT } = require('google-auth-library');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

const clients = {};

function tenantEnvKey(mailbox) {
  const domain = mailbox.split('@')[1] || '';
  return 'GOOGLE_SA_' + domain.replace(/[.-]/g, '_').toUpperCase();
}

function getClient(mailbox) {
  if (clients[mailbox]) return clients[mailbox];

  // One key per domain (GOOGLE_SA_YOURDOMAIN_COM), or one shared key (GOOGLE_SA_DEFAULT).
  let envKey = tenantEnvKey(mailbox);
  let rawKey = process.env[envKey];
  if (!rawKey && process.env.GOOGLE_SA_DEFAULT) { envKey = 'GOOGLE_SA_DEFAULT'; rawKey = process.env.GOOGLE_SA_DEFAULT; }
  if (!rawKey) throw new Error(`No service account key in ${tenantEnvKey(mailbox)} or GOOGLE_SA_DEFAULT for ${mailbox}`);

  let key;
  try {
    key = JSON.parse(rawKey);
  } catch (e) {
    throw new Error(`${envKey} is not valid JSON: ${e.message}`);
  }

  clients[mailbox] = new JWT({
    email  : key.client_email,
    key    : key.private_key,
    scopes : SCOPES,
    subject: mailbox,
  });
  return clients[mailbox];
}

async function gmailFetch(mailbox, path, options = {}) {
  const client = getClient(mailbox);
  const { token } = await client.getAccessToken();

  const r = await fetch(`${GMAIL}${path}`, {
    ...options,
    headers: {
      Authorization  : `Bearer ${token}`,
      'Content-Type' : 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Gmail ${path} failed (${r.status}): ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

function encodeHeader(value) {
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMime({ fromName, fromEmail, to, subject, body, inReplyTo, references }) {
  const headers = [
    `From: ${encodeHeader(fromName)} <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];

  if (inReplyTo)  headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmail({
  mailbox, fromName, to, subject, body,
  threadId = null, inReplyTo = null, references = null,
}) {
  const raw = buildMime({
    fromName, fromEmail: mailbox, to, subject, body, inReplyTo, references,
  });

  const payload = threadId ? { raw, threadId } : { raw };

  let sent;
  try {
    sent = await gmailFetch(mailbox, '/messages/send', {
      method: 'POST',
      body  : JSON.stringify(payload),
    });
  } catch (err) {
    // ── Thread no longer exists: retry as a fresh standalone email ──────────
    if (err.message.includes('(404)') && threadId) {
      console.warn(`[gmail] thread ${threadId} not found, retrying as fresh email to ${to}`);
      const freshRaw = buildMime({
        fromName, fromEmail: mailbox, to, subject, body,
        // intentionally no inReplyTo / references
      });
      sent = await gmailFetch(mailbox, '/messages/send', {
        method: 'POST',
        body  : JSON.stringify({ raw: freshRaw }),
      });
    } else {
      throw err; // any other error bubbles up as normal
    }
  }

  const meta = await gmailFetch(
    mailbox,
    `/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`
  );
  const hdr = (meta.payload && meta.payload.headers || [])
    .find(h => h.name.toLowerCase() === 'message-id');

  console.log(`[gmail] sent via ${mailbox} -> ${to} | thread ${sent.threadId}`);

  return {
    id        : sent.id,
    threadId  : sent.threadId,
    messageId : hdr ? hdr.value : null,
  };
}

// ─── Message body extraction ─────────────────────────────────────────────────
function decodeB64Url(data) {
  if (!data) return '';
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n---\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Walks a Gmail payload and returns readable text, preferring text/plain.
function extractText(payload) {
  if (!payload) return '';
  const plain = [];
  const html = [];
  (function walk(part) {
    if (!part) return;
    const type = (part.mimeType || '').toLowerCase();
    if (part.body && part.body.data) {
      if (type === 'text/plain') plain.push(decodeB64Url(part.body.data));
      else if (type === 'text/html') html.push(decodeB64Url(part.body.data));
    }
    (part.parts || []).forEach(walk);
  })(payload);
  if (plain.length) return plain.join('\n').trim();
  if (html.length) return htmlToText(html.join('\n'));
  return '';
}

// Removes the quoted earlier conversation and our unsubscribe footer,
// leaving only what the sender actually wrote in this message.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^On .{4,200}wrote:\s*$/i.test(t)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(t)) break;
    if (/^From:\s.+/i.test(t) && out.length) break;
    if (/^Sent from my (iPhone|iPad|Android|phone|mobile)/i.test(t)) break;
    if (/^-{2,}\s*$/.test(t) && out.length) break;
    if (/^To stop receiving these emails/i.test(t)) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function headerGetter(msg) {
  const headers = (msg.payload && msg.payload.headers) || [];
  return n => {
    const h = headers.find(x => x.name.toLowerCase() === n);
    return h ? h.value : '';
  };
}

// ─── Auto-reply detection ────────────────────────────────────────────────────
// Out-of-office, vacation and "we received your email" replies. They must
// never be treated as a prospect replying.
function isAutoReply({ subject = '', headers = {} } = {}) {
  const autoSubmitted = String(headers['auto-submitted'] || '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (headers['x-autoreply'] || headers['x-autorespond'] || headers['x-autoresponse']) return true;
  if (/^(auto_reply|bulk|junk)$/i.test(String(headers['precedence'] || '').trim())) return true;
  return /^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|ooo\b|vacation|on vacation|away from (the )?office|email received|thank you for (contacting|your email|reaching out)|delivery (status )?notification)/i
    .test(String(subject).trim());
}

function autoHeaders(get) {
  return {
    'auto-submitted': get('auto-submitted'),
    'x-autoreply'   : get('x-autoreply'),
    'x-autorespond' : get('x-autorespond'),
    'x-autoresponse': get('x-autoresponse'),
    'precedence'    : get('precedence'),
  };
}

// Cheap listing: ids and thread ids only, no message bodies. Pages through up
// to maxIds results, so busy inboxes (warm-up traffic) can't hide replies.
async function listInboxIds(mailbox, { days = 3, maxIds = 500 } = {}) {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`in:inbox newer_than:${days}d -from:me`);
    const page = await gmailFetch(
      mailbox,
      `/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`
    );
    for (const m of page.messages || []) out.push({ id: m.id, threadId: m.threadId });
    pageToken = page.nextPageToken || '';
  } while (pageToken && out.length < maxIds);
  return out.slice(0, maxIds);
}

// Sender only (light request), used to spot prospects replying in a new thread.
async function getSender(mailbox, id) {
  const msg = await gmailFetch(mailbox, `/messages/${id}?format=metadata&metadataHeaders=From`);
  const from = headerGetter(msg)('from');
  const m = String(from).match(/<([^>]+)>/);
  return { id: msg.id, threadId: msg.threadId, from: (m ? m[1] : from).trim().toLowerCase() };
}

// One message in full, in the shape the reply detector expects.
async function getInboundMessage(mailbox, id) {
  const msg  = await gmailFetch(mailbox, `/messages/${id}?format=full`);
  const get  = headerGetter(msg);
  const from = get('from').toLowerCase();
  const subject = get('subject');
  return {
    id          : msg.id,
    threadId    : msg.threadId,
    from,
    subject,
    snippet     : msg.snippet || '',
    body        : stripQuoted(extractText(msg.payload)) || msg.snippet || '',
    bounced     : /mailer-daemon|postmaster/.test(from),
    autoReply   : isAutoReply({ subject, headers: autoHeaders(get) }),
    labels      : msg.labelIds || [],
    internalDate: msg.internalDate ? Number(msg.internalDate) : null,
  };
}

async function listRecentInbound(mailbox, { days = 3, max = 50 } = {}) {
  const q    = encodeURIComponent(`in:inbox newer_than:${days}d`);
  const list = await gmailFetch(mailbox, `/messages?q=${q}&maxResults=${max}`);
  if (!list.messages || !list.messages.length) return [];

  const out = [];
  for (const m of list.messages) {
    try {
      const msg  = await gmailFetch(mailbox, `/messages/${m.id}?format=full`);
      const get  = headerGetter(msg);
      const from = get('from').toLowerCase();

      // Never treat our own messages as prospect replies.
      if (from.includes(mailbox.toLowerCase())) continue;

      const body = stripQuoted(extractText(msg.payload)) || msg.snippet || '';

      out.push({
        id           : msg.id,
        threadId     : msg.threadId,
        from,
        subject      : get('subject'),
        snippet      : msg.snippet || '',
        body,
        bounced      : /mailer-daemon|postmaster/.test(from),
        internalDate : msg.internalDate ? Number(msg.internalDate) : null,
      });
    } catch (e) {
      console.error(`[gmail] message read failed for ${m.id} in ${mailbox}: ${e.message}`);
    }
  }
  return out;
}

// Full thread as plain text, oldest first. This is the source of truth for
// what the prospect has actually seen: sequence emails, AI replies, and any
// replies you sent by hand from the mailbox.
async function getThreadTranscript(mailbox, threadId, { maxMessages = 30 } = {}) {
  if (!threadId) return [];
  const thread = await gmailFetch(mailbox, `/threads/${threadId}?format=full`);
  const msgs = (thread.messages || []).slice(-maxMessages);
  return msgs.map(msg => {
    const get  = headerGetter(msg);
    const from = get('from').toLowerCase();
    return {
      id      : msg.id,
      role    : from.includes(mailbox.toLowerCase()) ? 'us' : 'prospect',
      from,
      subject : get('subject'),
      date    : msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : '',
      text    : stripQuoted(extractText(msg.payload)) || msg.snippet || '',
    };
  });
}

async function verifyMailbox(mailbox) {
  try {
    const p = await gmailFetch(mailbox, '/profile?fields=emailAddress,messagesTotal');
    console.log(`[gmail] ✅ ${mailbox} ok (${p.messagesTotal} messages)`);
    return true;
  } catch (e) {
    console.error(`[gmail] ❌ ${mailbox}: ${e.message}`);
    return false;
  }
}

async function verifyAll(mailboxes) {
  const results = {};
  for (const m of mailboxes) results[m] = await verifyMailbox(m);
  const ok = Object.values(results).filter(Boolean).length;
  console.log(`[gmail] ${ok}/${mailboxes.length} mailboxes reachable`);
  return results;
}

// Read-only search used by the reply audit. Pages through results and returns
// sender, subject, labels and a preview for every matching message.
async function searchMessages(mailbox, query, { maxTotal = 500 } = {}) {
  const ids = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(query);
    const page = await gmailFetch(
      mailbox,
      `/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`
    );
    for (const m of page.messages || []) ids.push(m.id);
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < maxTotal);

  // Fetch details 10 at a time to keep the scan quick.
  const out = [];
  const list = ids.slice(0, maxTotal);
  for (let i = 0; i < list.length; i += 10) {
    const chunk = await Promise.all(list.slice(i, i + 10).map(async id => {
      try {
        const msg = await gmailFetch(
          mailbox,
          `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Auto-Submitted&metadataHeaders=X-Autoreply&metadataHeaders=X-Autorespond&metadataHeaders=Precedence`
        );
        const get = headerGetter(msg);
        return {
          autoReply   : isAutoReply({ subject: get('subject'), headers: autoHeaders(get) }),
          id          : msg.id,
          threadId    : msg.threadId,
          from        : get('from'),
          subject     : get('subject'),
          snippet     : msg.snippet || '',
          labels      : msg.labelIds || [],
          internalDate: msg.internalDate ? Number(msg.internalDate) : null,
        };
      } catch (e) {
        return { id, error: e.message };
      }
    }));
    out.push(...chunk);
  }
  return { total: ids.length, messages: out };
}

// Registers Gmail push notifications for the inbox. Gmail keeps one target per
// mailbox, so this app and the voice app must use the same topic.
async function watchMailbox(mailbox, topicName) {
  return gmailFetch(mailbox, '/watch', {
    method: 'POST',
    body  : JSON.stringify({ topicName, labelIds: ['INBOX'] }),
  });
}

// Parsed service account JSON for a mailbox (used to register Gmail push).
function getServiceAccountKey(mailbox) {
  const raw = process.env[tenantEnvKey(mailbox)] || process.env.GOOGLE_SA_DEFAULT;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = {
  getServiceAccountKey, watchMailbox,
  searchMessages,
  listInboxIds, getSender, getInboundMessage, isAutoReply,
  sendEmail, listRecentInbound, getThreadTranscript, verifyMailbox, verifyAll,
  // exported for tests
  extractText, stripQuoted, htmlToText,
};
