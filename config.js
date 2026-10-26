'use strict';

/**
 * ============================================================================
 *  CALL CAMPAIGN SETTINGS
 *  Edit this file, commit, and Railway redeploys. Secrets (API keys) go in
 *  Railway variables, never here. The email copy itself lives in campaign.js.
 * ============================================================================
 */

module.exports = {

  // ── Who is sending ────────────────────────────────────────────────────────
  company: { name: 'Creative Copyz' },

  // The person the prospect books a call with. Also takes handed-off conversations.
  // The AI introduces him with one of these titles when sharing the booking link.
  director: { name: 'Naman', title: 'technical director', otherTitles: ['director', 'founder'] },

  // Who the emails come from.
  //   'director' : every mailbox sends as the director (From name "Naman"), and the
  //                AI replies in his voice ("I"). Matches copy written as Naman.
  //   'personas' : each mailbox sends as its own name below, and the AI refers to
  //                the director in the third person ("a call with Naman").
  senderMode: 'personas',

  // Public booking link for the call.
  calendarLink: 'https://api.leadconnectorhq.com/widget/bookings/thebookedroutesystem-cc-introcall',

  // ── What the AI may say ───────────────────────────────────────────────────
  // The AI answers questions ONLY from these lines and never invents anything.
  // Anything it can't answer from here, it says can be covered on the call.
  offer: {
    // What it is and who it's for.
    summary: 'A speed to lead and reactivation system for pest control companies: it catches the calls their team misses and wakes up the customers they already have, and both turn into booked jobs.',
    // Short, true statements the AI may use when answering questions.
    facts: [
      'It catches every call the team is too busy to take and turns it into a booked job.',
      'For a missed call, it answers, gets the pest type and address, and hands the team a lead that is ready to book.',
      'It follows up on every open quote and old lead until the homeowner books or says no, so the team does not have to remember.',
      'It keeps past customers hearing from the company all year: a seasonal newsletter twice a month, and it re-engages customers who have gone quiet. So they are the first call when a pest shows up.',
      'It is live in 14 days.',
      'It works alongside the software the company already uses.',
      'The call is 15 minutes, and on it Naman shows how the system works and how it would run for their company.',
    ],
    // What the AI may say about price. It never quotes numbers.
    pricing: [
      'Pricing depends on what gets built for each business. Exact numbers are covered on the call.',
    ],
  },

  // ── Sending mailboxes (shared with the AI voice campaign) ─────────────────
  mailboxes: [
    { email: 'anne@ccopyz.com',           name: 'Anne Schull',   title: 'Director of Client Solutions' },
    { email: 'billy@ccopyz.com',          name: 'Billy Cooper',  title: 'Business Development Manager' },
    { email: 'caitlyn@ccopyz.com',        name: 'Caitlyn Smoke', title: 'Account Executive' },
    { email: 'claire@creativecopyz.org',  name: 'Claire Dunphy', title: 'Partnership Manager' },
    { email: 'clint@creativecopyz.org',   name: 'Clint Mac',     title: 'Head of Business Development' },
    { email: 'emily@creativecopyz.org',   name: 'Emily Hathway', title: 'Client Success Manager' },
    { email: 'glenn@ccopyz.org',          name: 'Glenn Ponting', title: 'AI Solutions Director' },
    { email: 'hailey@ccopyz.org',         name: 'Hailey Henz',   title: 'Account Manager' },
    { email: 'harry@ccopyz.net',          name: 'Harry Garrold', title: 'Business Development Executive' },
    { email: 'helen@ccopyz.org',          name: 'Helen Morgan',  title: 'Director of Partnerships' },
    { email: 'james@ccopyz.net',          name: 'James Walkway', title: 'Head of AI Outreach' },
    { email: 'josh@ccopyz.net',           name: 'Josh Walker',   title: 'Account Executive' },
    { email: 'joshua@cretivecopyz.com',   name: 'Joshua Speed',  title: 'Business Development Lead' },
    { email: 'justin@cretivecopyz.com',   name: 'Justin Albus',  title: 'Director of Sales' },
    { email: 'mike@cretivecopyz.com',     name: 'Mike Ten',      title: 'Senior Account Manager' },
    { email: 'phil@creativecopyz.net',    name: 'Phil Jazz',     title: 'Partnership Director' },
    { email: 'samuel@creativecopyz.net',  name: 'Samuel Borne',  title: 'AI Solutions Advisor' },
    { email: 'vanessa@creativecopyz.net', name: 'Vanessa Cruz',  title: 'Client Relations Manager' },
  ],

  // ── Sending limits for THIS campaign ──────────────────────────────────────
  // The voice campaign counts its own sends separately, so a mailbox sends
  // both totals each day. Keep the two campaigns' limits together in mind.
  limits: {
    newLeadsPerMailbox: 2,         // first emails per mailbox per day
    followupsPerMailbox: 8,        // follow-ups per mailbox per day
    secondsBetweenSends: 75,       // pause between any two emails this app sends
    sendWindowStartHour: 8,        // prospect's local time
    sendWindowEndHour: 18,
    resetTimezone: 'Asia/Kolkata', // daily counters reset at midnight here
    noReplyGraceDays: 3,           // after the last email, wait this long before "No Replies"
  },

  // ── GHL ──────────────────────────────────────────────────────────────────
  // Every tag this app adds starts with this, so it never touches the voice
  // campaign's workflows (which use aivoice_...).
  tagPrefix: 'pestcamp',

  // Fill the IDs from  <app-url>/setup/ghl-ids?token=<SETUP_TOKEN>
  ghl: {
    locationId: 'dImqkGzlWhmVksSXL1WY',
    pipeline: {
      pipelineId: 'fydSltFlSMi6UOFQgPlt',
      stages: {
        inSequence:    'f08c134f-b46c-4d21-b430-efe0d3ccde27', // Enrolled in cold-campaign
        bounced:       '948a6221-16bf-45ce-95c7-53670c3351d8', // Bounced
        replyReceived: 'b2b4154a-d4ec-4ea7-a8e5-be70e94b4ca8', // Reply received
        unsubscribed:  'a3b5cd82-29bf-4c95-8b2b-e4fdc4164133', // Unsubscribed / Not Interested
        noReplies:     '83cac12c-653f-4fbe-874a-28532c28855f', // No Replies
        calendarSent:  'a71b2b24-c8b5-4804-a3df-6b77813f5219', // Calendar Link Sent
        callBooked:    'bd60bcb6-7779-492a-9dc7-8ce53a26a525', // Booked
        handoff:       '',  // no Handoff stage: handed-off deals stay where they are (tag only)
      },
    },
  },

  // ── Gmail push ───────────────────────────────────────────────────────────
  // The SAME topic the voice app uses. Gmail allows one notification target
  // per mailbox, so both apps share the topic, each with its own subscription.
  gmail: {
    pubsubTopic: 'projects/aivoice-gmail-mailer-504813/topics/gmail-push-notifications',
  },
};
