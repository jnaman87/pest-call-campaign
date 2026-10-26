'use strict';

/**
 * ============================================================================
 *  THE EMAIL SEQUENCES
 *
 *  Each lead is assigned ONE track when enrolled and gets every email from that
 *  track, in order. Tracks rotate lead by lead, or GHL can choose one by sending
 *  "track": "A" | "B" | "C" in the enroll webhook's custom data.
 *
 *  Each email:
 *    delayDays : days to wait after the previous email (the first one is 0)
 *    subject   : only email 1 has one. Follow-ups use '' so they go out as
 *                replies in the same thread ("Re: <first subject>").
 *    body      : plain text. A blank line starts a new paragraph.
 *
 *  Merge fields:
 *    {{company}}      prospect's company
 *    {{city}}         prospect's city
 *    {{hook}} {{pain}} Personalisation Hook / Current Pain (a line holding only
 *                     an empty field is left out)
 *    {{spots_left}}   founding-partner spots open, e.g. 3     (tracks.C settings)
 *    {{spots_open}}   the same with the word: "3 spots", "1 spot"
 *    {{date}}         when the list closes: "the end of November"
 *    {{sender_name}} {{sender_first}} {{director}} {{calendar_link}} {{our_company}}
 *
 *  The signature and the unsubscribe line are added to every email.
 * ============================================================================
 */

const DAYS = [0, 2, 2, 2, 2];   // email 1, then one every 2 days (5 emails over 8 days)

module.exports = {
  tracks: {
    // ── Track A: Winter rodent season ───────────────────────────────────────
    A: {
      name: 'Winter rodent season',
      steps: [
        { delayDays: DAYS[0], variants: [{ subject: 'missed calls and quiet customers', body:
`Winter pushes rodents, roaches and ants indoors, so your phones ring while your team is out on jobs.

I set up a speed to lead and reactivation system. It catches the calls your team misses, and it wakes up the customers you already have.

Both turn into booked jobs.

Open to a 15 minute call where {{director}}, our technical director, shows you how it works?` }] },

        { delayDays: DAYS[1], variants: [{ subject: '', body:
`Say 8 calls a month go unanswered and 3 of them would have booked. That's 36 jobs a year going to whoever picked up.

Our system answers those calls, gets the pest type and address, and hands your team a lead that's ready to book.

No missed call goes cold.

Want {{director}} to show you how it works?` }] },

        { delayDays: DAYS[2], variants: [{ subject: '', body:
`Every pest company has open quotes and old leads sitting untouched. Rodent exclusion and attic work are the big ones.

The system follows up on each one until the homeowner books or says no.

Your team doesn't have to remember.

Worth a 15 minute call?` }] },

        { delayDays: DAYS[3], variants: [{ subject: '', body:
`When a homeowner hears scratching in the attic, they call the pest company they remember.

The system sends your customer list a seasonal newsletter twice a month, and it re-engages the ones who've gone quiet.

You stay on their mind all year.

Want to see how it would run for {{company}}?` }] },

        { delayDays: DAYS[4], variants: [{ subject: '', body:
`Here's what I'd set up for {{company}}:

Missed calls become booked jobs
Open quotes and old leads get followed up
Past customers hear from you twice a month

Live in 14 days, and it works alongside the software you already use.

Want to see it on a quick call?` }] },
      ],
    },

    // ── Track B: End-of-year upgrade ────────────────────────────────────────
    // Mentions 2026 / "before 2027": no new leads once their 5 emails can't all
    // land by closesOn, and anything still due after it is skipped.
    B: {
      name: 'End-of-year upgrade',
      closesOn: '2026-12-31',
      steps: [
        { delayDays: DAYS[0], variants: [{ subject: 'before 2027, {{company}}', body:
`Winter is when smart pest companies fix their operations, so they're ready before spring termite season.

I set up a speed to lead and reactivation system. It catches the calls your team misses, and it wakes up the customers you already have.

It's running before your busy months.

Open to a 15 minute call where {{director}}, our technical director, shows you how it works?` }] },

        { delayDays: DAYS[1], variants: [{ subject: '', body:
`Say 8 calls a month went unanswered this year and 3 of them would have booked. That's 36 jobs that went to the next company on Google.

Our system answers those calls, gets the pest type and address, and hands your team a lead that's ready to book.

Start 2027 without that leak.

Want {{director}} to show you how it works?` }] },

        { delayDays: DAYS[2], variants: [{ subject: '', body:
`Every pest company ends the year with open quotes and old leads that went quiet. Termite and rodent exclusion quotes are worth the most and get chased the least.

The system follows up on each one until the homeowner books or says no.

Nothing gets forgotten.

Worth a 15 minute call?` }] },

        { delayDays: DAYS[3], variants: [{ subject: '', body:
`When spring termite season hits, homeowners call the pest company they've heard from all winter.

The system sends your customer list a seasonal newsletter twice a month and re-engages the ones who've gone quiet.

That company is you.

Want to see how it would run for {{company}}?` }] },

        { delayDays: DAYS[4], variants: [{ subject: '', body:
`Here's what I'd set up for {{company}}:

Missed calls become booked jobs
Open quotes and old leads get followed up
Past customers hear from you twice a month

Live in 14 days, and it works alongside the software you already use.

Want to see it on a quick call?` }] },
      ],
    },

    // ── Track C: First 5 founding partners ──────────────────────────────────
    // {{spots_left}} counts down by the date each email is SENT (not per lead):
    //   from countdownStart: 5 spots for 5 days, then 3 for 10 days, then 1.
    // New leads stop joining Track C once their 5 emails can no longer all go
    // out before closesOn. Any Track C email still due after closesOn is skipped.
    C: {
      name: 'First 5 founding partners',
      countdownStart: '2026-11-01',
      countdown: [ { days: 5, spots: 5 }, { days: 10, spots: 3 }, { days: 10, spots: 1 } ],
      closesOn: '2026-11-30',           // last day the list is open
      closeDate: 'the end of November', // {{date}}
      steps: [
        { delayDays: DAYS[0], variants: [{ subject: '5 pest control companies', body:
`I'm setting up my first 5 pest control companies with a speed to lead and reactivation system. It catches the calls their team misses, and it wakes up the customers they already have.

Both turn into booked jobs.

I'm choosing the last few now.

Open to a 15 minute call where {{director}}, our technical director, shows you how it works?` }] },

        { delayDays: DAYS[1], variants: [{ subject: '', body:
`Say 8 calls a month go unanswered and 3 of them would have booked. That's 36 jobs a year going to whoever picked up.

Our system answers those calls, gets the pest type and address, and hands your team a lead that's ready to book.

I have {{spots_left}} of 5 spots open.

Want {{director}} to show you how it works?` }] },

        { delayDays: DAYS[2], variants: [{ subject: '', body:
`Every open quote or old lead that goes quiet is a job you already did the work to win.

The system follows up on each one until the homeowner books or says no.

I have {{spots_open}} open.

Worth a 15 minute call?` }] },

        { delayDays: DAYS[3], variants: [{ subject: '', body:
`Most customers only hear from their pest company when they get a bill.

The system sends your customer list a seasonal newsletter twice a month and re-engages the ones who've gone quiet.

You're the first call when a pest shows up.

Want to see how it would run for {{company}}?` }] },

        { delayDays: DAYS[4], variants: [{ subject: '', body:
`Here's what the 5 companies get:

Missed calls become booked jobs
Open quotes and old leads get followed up
Past customers hear from you twice a month

Live in 14 days, and it works alongside the software you already use.

I close the list at {{date}}.

Want one of the spots?` }] },
      ],
    },
  },

  signature: `{{sender_name}}
{{sender_title}} | {{our_company}}`,

  unsubscribeLine: 'To stop receiving these emails, simply reply with "unsubscribe".',
};
