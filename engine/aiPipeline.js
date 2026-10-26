'use strict';

/**
 * Conversation AI. One goal: get the prospect to book a call with the director.
 *
 *   1. Router  : reply | handoff | no_reply | negative   (+ send_calendar?)
 *   2. Drafter : short reply under strict rules
 *   3. Guards  : deterministic checks (greeting, banned phrases, length, links, price)
 *   4. Critic  : scores the draft 0-100 against the thread
 *
 * Drafter -> guards -> critic loops up to MAX_ATTEMPTS. If no draft passes, or
 * the router / critic says a human is needed, the result is a handoff.
 */

const CFG = require('../config');

const OPENAI_KEY      = process.env.OPENAI_API_KEY;
const MODEL           = process.env.AI_MODEL || 'gpt-4.1';
const SCORE_THRESHOLD = Number(process.env.AI_SCORE_THRESHOLD || 80);
const MAX_ATTEMPTS    = Number(process.env.AI_MAX_ATTEMPTS || 3);
const MAX_WORDS       = 70;

const CALENDAR_TOKEN = '{{CALENDAR_LINK}}';
const COMPANY  = CFG.company.name;
const DIRECTOR = CFG.director.name;
const DIRECTOR_TITLE = CFG.director.title;
// 'director': emails come from the director himself, so the AI writes as him ("I").
const AS_DIRECTOR = CFG.senderMode !== 'personas';
const HE_COVERS = AS_DIRECTOR ? 'I can cover' : `${DIRECTOR} can cover`;

const real = v => v && !/^CHANGE_ME/.test(String(v));

// The only things the AI may state.
const FACTS = [
  real(CFG.offer.summary) ? CFG.offer.summary : null,
  ...(CFG.offer.facts || []),
  ...(CFG.offer.pricing || []),
  `The next step for an interested prospect is a short call with ${DIRECTOR}, booked through the calendar link.`,
  `${DIRECTOR} is the ${DIRECTOR_TITLE} of ${COMPANY}. On the call he can answer any questions they have.`,
].filter(Boolean);

const BANNED_PHRASES = [
  'just following up', 'following up', 'just checking in', 'checking in',
  'just curious', 'curious if', 'curious to', 'curious what', 'circling back',
  'touching base', 'touch base', 'just wanted to', 'quick follow', 'friendly reminder',
  'hope this finds you', 'hope you are well', "hope you're well", 'hope you are doing',
  'did you get a chance', 'had a chance', 'have a chance', 'bumping this', 'any update',
  'just a reminder', 'looking forward to helping', 'absolutely!', 'great question',
];

// ─── OpenAI ──────────────────────────────────────────────────────────────────
async function chatJSON({ system, user, temperature = 0 }) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method : 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      model: MODEL,
      temperature,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`OpenAI ${r.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return JSON.parse(content || '{}');
}

// ─── Context helpers ─────────────────────────────────────────────────────────
function renderTranscript(transcript, maxChars = 14000) {
  const blocks = (transcript || []).map((m, i) => {
    const who = m.role === 'us' ? `US (${COMPANY})` : 'PROSPECT';
    return `[${i + 1}] ${who} | ${m.date || ''}\n${(m.text || '').trim()}`;
  });
  let out = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    const next = blocks[i] + '\n\n' + out;
    if (next.length > maxChars) break;
    out = next;
  }
  return out.trim();
}

function countCalendarLinksSent(transcript, calendarLink) {
  if (!real(calendarLink)) return 0;
  return (transcript || []).filter(m => m.role === 'us' && (m.text || '').includes(calendarLink)).length;
}

function factsBlock(ctx) {
  return [
    ...FACTS,
    ...(ctx.extraFacts || []),
    `Prospect company: ${ctx.companyName || 'unknown'}${ctx.city ? ', ' + ctx.city : ''}.`,
    `The calendar link has been sent ${ctx.calendarLinksSent} time(s) in this thread.`,
  ].map(f => '- ' + f).join('\n');
}

const GOAL = `Get the prospect to book a short call with ${DIRECTOR}${AS_DIRECTOR ? '' : `, our ${DIRECTOR_TITLE}`}, using the calendar link.`;

// ─── 1. Router ───────────────────────────────────────────────────────────────
const ROUTER_SYSTEM = `You triage replies in a cold email thread for ${COMPANY}. The only goal of the thread: ${GOAL}
Read the WHOLE thread, then decide what happens with the prospect's newest message.

Decisions:
- "reply": the default. Use it whenever a short, honest reply can move things toward a booked call, including:
  * they agree to a call or show interest ("sure", "yes", "sounds good", "send me a time", "how do I book?")
  * questions about what we do or how it works (answer from the FACTS, then invite them to book)
  * a FIRST question about price: we reply with what the FACTS say about pricing, and that exact numbers are covered on the call
  * questions outside the FACTS: we reply that it can be covered on the call
  * "not right now" or "maybe later" that is not a clear no: one short, low-pressure reply leaving the link with them
- "handoff": ${DIRECTOR} must take over personally. Only for these edge cases:
  * they ask to be phoned or texted, or share a phone number
  * they propose a specific day or time, or ask us to pick a time (we cannot book on their behalf)
  * they say the calendar link does not work, or no time on it suits them
  * they PUSH on pricing: they ask for numbers again after we already answered, or ask about contracts, discounts or payment terms
  * they ask whether a real person is writing, or ask to speak to someone else
  * they are frustrated, annoyed, or say we got something wrong
  * the thread is going in circles and another automated reply would make it worse
- "no_reply": nothing needs answering (e.g. "thanks", "ok", "got it", "booked" when nothing is pending; out-of-office or auto-replies).
- "negative": they are not interested, ask to stop, unsubscribe, say they already have a provider and want no contact, or are hostile.

Handoff is for the edge cases above only. When unsure, choose "reply".

Also return "calendar_link_ok": true if this reply should include the booking link. That is the case when they agreed to a call,
asked how to book, asked for the link, or are clearly interested, and ALSO when answering a question if the link has not been
sent yet in this thread. False if it was already sent and they did not ask for it again.

Respond ONLY with JSON:
{"decision":"reply|handoff|no_reply|negative","reason":"one sentence","summary":"one or two sentences on where this prospect stands","agreed_to_call":false,"calendar_link_ok":false}`;

async function routeMessage(ctx) {
  const user = [
    'FACTS:', factsBlock(ctx), '',
    'THREAD (oldest first):', renderTranscript(ctx.transcript), '',
    'NEWEST PROSPECT MESSAGE:', ctx.latestText,
  ].join('\n');
  const out = await chatJSON({ system: ROUTER_SYSTEM, user });
  const valid = ['reply', 'handoff', 'no_reply', 'negative'];
  return {
    decision      : valid.includes(out.decision) ? out.decision : 'reply',
    reason        : String(out.reason || ''),
    summary       : String(out.summary || ''),
    agreedToCall  : out.agreed_to_call === true,
    calendarLinkOk: out.calendar_link_ok === true || out.agreed_to_call === true,
  };
}

// ─── 2. Drafter ──────────────────────────────────────────────────────────────
function drafterSystem(ctx, allowCalendar) {
  const who = AS_DIRECTOR
    ? `You are ${DIRECTOR}, ${DIRECTOR_TITLE} of ${COMPANY}, replying in an email thread to a prospect you cold emailed. Write in the first person as ${DIRECTOR}.`
    : `You are ${ctx.persona.fullName}, ${ctx.persona.title} at ${COMPANY}, replying in an email thread.`;
  const callLine = AS_DIRECTOR
    ? `- The call is with you. Say "a quick call", "a 15 minute call" or "grab a time with me". Never refer to ${DIRECTOR} in the third person.`
    : `- The call is with ${DIRECTOR}, never with you. Whenever you share the booking link, name him with his title: "${DIRECTOR}, our ${[DIRECTOR_TITLE, ...(CFG.director.otherTitles || [])].join('" or "' + DIRECTOR + ', our ')}". Example: "here's the link to grab 15 minutes with ${DIRECTOR}, our ${DIRECTOR_TITLE}". Use one title per thread.`;
  return `${who}

GOAL: ${GOAL}

HOW TO WRITE:
- Start directly with the body of the message. Never open with a greeting ("Hi", "Hey", "Hello", "Dear", "Good morning"), a name, or a line like "John,". Never use the prospect's name anywhere.
- Answer exactly what they just said first. Reply to them, not to a script.
- If they agreed to a call: thank them in a few words and give the booking link. Nothing else.
- If they asked a question: answer it in one or two sentences from the FACTS, then invite them to book the call.
- Keep it short: 1 to 3 sentences, under ${MAX_WORDS} words. Shorter is better when they wrote something short.
- Plain, calm, human tone. No hype, no exclamation marks, no "Absolutely".
- At most one question, and only if it moves things forward.
- Never use these or similar salesy phrases: just following up, checking in, just curious, circling back, touching base, did you get a chance, hope you're well.
- Never repeat something already said in the thread unless they asked for it.
- Only state things from the FACTS list. Never invent prices, features, results, timelines, clients, or promises.
- Price: say only what the FACTS say about pricing, and that ${HE_COVERS} exact numbers on the call. Never give a number.
- Anything the FACTS don't cover: say ${HE_COVERS} that on the call. Never guess.
- Never claim results, client names, case studies or numbers that are not in the FACTS. The figures in our cold emails (like "8 calls a month") were examples, not claims about this prospect.
${callLine}
- Never use em dashes.
- No sign-off, name, or signature. The application adds it.
${allowCalendar
  ? `- Write the placeholder ${CALENDAR_TOKEN} exactly once, where the booking link goes. Never write a real URL.`
  : '- Do not include any links. Do not include the booking link (it was already sent earlier in this thread; you may refer to it).'}

FACTS:
${factsBlock(ctx)}

Respond ONLY with JSON: {"reply":"the email body"}`;
}

async function draftReply(ctx, allowCalendar, feedback) {
  const user = [
    'THREAD (oldest first):', renderTranscript(ctx.transcript), '',
    'NEWEST PROSPECT MESSAGE (reply to this):', ctx.latestText,
    feedback ? `\nYOUR PREVIOUS DRAFT WAS REJECTED. Fix these problems:\n- ${feedback.join('\n- ')}` : '',
  ].join('\n');
  const out = await chatJSON({ system: drafterSystem(ctx, allowCalendar), user, temperature: 0.4 });
  return String(out.reply || '').replace(/\\n/g, '\n').trim();
}

// ─── 3. Deterministic guards ─────────────────────────────────────────────────
function guardIssues(draft, ctx, allowCalendar, mustIncludeCalendar = false) {
  const issues = [];
  const text = String(draft || '').trim();
  const lower = text.toLowerCase();

  if (!text) issues.push('The reply is empty.');
  if (/^(hi|hey|hello|dear|good (morning|afternoon|evening))\b/i.test(text)) issues.push('Starts with a greeting. Start directly with the message.');
  // A first line that is only a name or a salutation, e.g. "John," / "Thanks John," / "Team,"
  const firstLine = text.split('\n')[0].trim();
  if (/^(thanks|thank you)?\s*[A-Z][a-z'-]+(\s+[A-Z][a-z'-]+)?\s*[,!]$/.test(firstLine) || /^(team|all|folks|there|sir|madam)\b[,!]/i.test(firstLine)) {
    issues.push('Opens with a name or salutation. Start directly with the message.');
  }
  for (const phrase of BANNED_PHRASES) if (lower.includes(phrase)) issues.push(`Uses the banned phrase "${phrase}".`);
  if (/[—–]/.test(text)) issues.push('Contains an em or en dash.');
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) issues.push(`Too long (${words} words). Keep it under ${MAX_WORDS}.`);
  if (/[$£€₹]\s?\d|\b\d+\s?(usd|gbp|aud|dollars|pounds|per month|\/mo|a month)\b/i.test(text)) issues.push('Mentions a price. Exact numbers are covered on the call.');
  if (/https?:\/\/|www\./i.test(text)) issues.push('Contains a raw link. Use the placeholder only.');
  const calCount = text.split(CALENDAR_TOKEN).length - 1;
  if (calCount && !allowCalendar) issues.push('Includes the booking link when it is not allowed.');
  if (calCount > 1) issues.push('Includes the booking link more than once.');
  if (mustIncludeCalendar && calCount !== 1) issues.push(`They agreed to a call. Include the placeholder ${CALENDAR_TOKEN} exactly once.`);
  if (/\b(best regards|kind regards|cheers,|thanks,\s*$)/i.test(text)) issues.push('Contains a sign-off.');
  if (!AS_DIRECTOR && calCount && !new RegExp(`\\b${DIRECTOR}\\b`, 'i').test(text)) {
    issues.push(`Shares the booking link without saying the call is with ${DIRECTOR}, our ${DIRECTOR_TITLE} (or director / founder).`);
  }
  if (AS_DIRECTOR && new RegExp(`\\b${DIRECTOR}\\b`, 'i').test(text)) issues.push(`Mentions ${DIRECTOR} in the third person. You ARE ${DIRECTOR}: write "me" / "I".`);
  return issues;
}

// ─── 4. Critic ───────────────────────────────────────────────────────────────
const CRITIC_SYSTEM = `You review a draft email reply before it is sent to a cold email prospect. The goal of the thread: ${GOAL} Be strict.
Score 0 to 100 for how confident you are that sending it is the right move. Start at 100 and deduct:
- Does not directly address what the prospect just said: -40
- They agreed to a call but the draft does not simply give them the booking link: -40
- Repeats an offer, link, or explanation already in the thread: -30
- States anything not supported by the FACTS: -40
- Sounds salesy, scripted, or pushy (follow-up filler, hype): -25
- Longer than needed for what they wrote: -15
- Contradicts or ignores something earlier in the thread: -30
- Could confuse the prospect: -30
The text ${CALENDAR_TOKEN} is a placeholder that becomes the real booking link. Treat it as a working link.
A first question about price answered with the pricing line from the FACTS plus "exact numbers are covered on the call" is correct.${AS_DIRECTOR ? `\nThe sender IS ${DIRECTOR}, writing in the first person. "A call with me" is correct.` : ''}
Set "should_handoff" true ONLY if: they asked to be phoned or shared a number, proposed a specific time, said the link does not work,
pushed for price numbers after already being answered, asked for a person, or are frustrated. Otherwise false.

Respond ONLY with JSON: {"score":0,"issues":["specific problem"],"should_handoff":false}`;

async function critiqueReply(ctx, draft) {
  const user = [
    'FACTS:', factsBlock(ctx), '',
    'THREAD (oldest first):', renderTranscript(ctx.transcript), '',
    'NEWEST PROSPECT MESSAGE:', ctx.latestText, '',
    'DRAFT REPLY:', draft,
  ].join('\n');
  const out = await chatJSON({ system: CRITIC_SYSTEM, user });
  return {
    score        : Math.max(0, Math.min(100, Number(out.score) || 0)),
    issues       : Array.isArray(out.issues) ? out.issues.map(String).slice(0, 6) : [],
    shouldHandoff: out.should_handoff === true,
  };
}

// ─── Orchestration ───────────────────────────────────────────────────────────
// ctx: { persona, prospectName, companyName, city, calendarLink, transcript, latestText }
async function runPipeline(ctx) {
  ctx.calendarLinksSent = countCalendarLinksSent(ctx.transcript, ctx.calendarLink);

  let route;
  try {
    route = await routeMessage(ctx);
  } catch (e) {
    console.error('[ai] router failed:', e.message);
    return { action: 'handoff', reason: `Router error: ${e.message}`, summary: '', attempts: [] };
  }
  console.log(`[ai] router -> ${route.decision}${route.agreedToCall ? ' (agreed to call)' : ''} | ${route.reason}`);

  if (route.decision === 'negative') return { action: 'negative', reason: route.reason };
  if (route.decision === 'no_reply') return { action: 'no_reply', reason: route.reason };
  if (route.decision === 'handoff') return { action: 'handoff', reason: route.reason, summary: route.summary, attempts: [] };

  // Without a real calendar link the AI can't do the one thing it's for.
  const linkReady = real(ctx.calendarLink);
  if (!linkReady && route.agreedToCall) {
    return { action: 'handoff', reason: 'Prospect agreed to a call but no calendar link is set in config.js.', summary: route.summary, attempts: [] };
  }
  const allowCalendar = linkReady && route.calendarLinkOk;
  return draftLoop(ctx, { allowCalendar, mustIncludeCalendar: allowCalendar && route.agreedToCall, summary: route.summary, reason: route.reason, agreedToCall: route.agreedToCall });
}

async function draftLoop(ctx, { allowCalendar, mustIncludeCalendar, summary, reason, agreedToCall }) {
  const attempts = [];
  let feedback = null;

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    let draft;
    try {
      draft = await draftReply(ctx, allowCalendar, feedback);
    } catch (e) {
      console.error(`[ai] drafter failed (attempt ${i}):`, e.message);
      attempts.push({ attempt: i, draft: '', score: 0, issues: [e.message] });
      continue;
    }

    const guards = guardIssues(draft, ctx, allowCalendar, mustIncludeCalendar);
    if (guards.length) {
      console.log(`[ai] attempt ${i} failed guards: ${guards.join(' | ')}`);
      attempts.push({ attempt: i, draft, score: 0, issues: guards });
      feedback = guards;
      continue;
    }

    let review;
    try {
      review = await critiqueReply(ctx, draft);
    } catch (e) {
      console.error(`[ai] critic failed (attempt ${i}):`, e.message);
      attempts.push({ attempt: i, draft, score: 0, issues: [e.message] });
      continue;
    }
    console.log(`[ai] attempt ${i} score ${review.score}${review.shouldHandoff ? ' (critic wants handoff)' : ''}`);
    attempts.push({ attempt: i, draft, score: review.score, issues: review.issues });

    if (review.shouldHandoff) {
      return { action: 'handoff', reason: `Reviewer flagged this for a human: ${review.issues.join('; ') || reason}`, summary, attempts };
    }
    if (review.score >= SCORE_THRESHOLD) {
      const includesCalendar = allowCalendar && draft.includes(CALENDAR_TOKEN);
      const text = includesCalendar ? draft.split(CALENDAR_TOKEN).join(ctx.calendarLink) : draft;
      return { action: 'reply', text, score: review.score, includesCalendar, agreedToCall, summary, attempts };
    }
    feedback = review.issues.length ? review.issues : ['Score too low. Make it shorter and more directly responsive.'];
  }

  return { action: 'handoff', reason: `No draft reached a score of ${SCORE_THRESHOLD} in ${MAX_ATTEMPTS} attempts.`, summary, attempts };
}

module.exports = {
  runPipeline,
  // exported for tests
  guardIssues, renderTranscript, countCalendarLinksSent, CALENDAR_TOKEN, FACTS, ROUTER_SYSTEM,
};
