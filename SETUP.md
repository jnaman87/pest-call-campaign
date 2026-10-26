# Call Campaign: setup

A separate app from the voice campaign. Its own GitHub repo, its own Railway service, its own Postgres. It sends from the same 18 mailboxes.

## What it does

1. A GHL tag enrolls a lead. The app puts it on track A, B or C (rotating lead by lead, or GHL picks one by sending `track` in custom data) and tags the contact `pestcamp_track_a` / `_b` / `_c`. The lead gets all 5 emails of its track, one every 2 days, all in one thread (emails 2 to 5 are "Re:" replies to email 1). No greeting line on any email.
2. Any real reply stops the cold sequence for good. From then on only the conversation AI writes to them.
   - Agrees to a call: gets the calendar link.
   - Asks a question: gets an answer from `config.js > offer`, then an invite to book.
   - Not interested / unsubscribe: campaign stops, Email DND, Unsubscribed stage.
   - Phone number, proposed time, price pushback, frustration, AI unsure: handed to you (prospect is told, you get an alert email).
3. Auto-replies: out of office is tagged and the sequence continues. Business closed stops. "Email changed, write to X" switches the lead to X in Postgres and GHL and restarts at email 1.
4. Bounce: stops, Email DND, Bounced stage.
5. Booked call (GHL workflow): campaign stops, Call Booked stage.
6. Got the link but no booking and no reply after 2 days: one reminder, then nothing.
7. No reply to the whole sequence: No Replies stage after 3 days.

Each mailbox sends under its own name and is signed with that name and title (e.g. "Anne Schull, Director of Client Solutions | Creative Copyz"). When the AI shares the booking link it always names the call as being with "Naman, our technical director" (or director / founder). Neither the emails nor the AI ever open with a greeting.

**Track C countdown** (top of Track C in `campaign.js`): from `countdownStart` (Nov 1) emails show 5 spots for 5 days, 3 spots for the next 10, then 1. The number is based on the day the email is sent. The list "closes at the end of November": no new leads join Track C after Nov 22 (so all 5 emails land by Nov 30), and any Track C email still due after Nov 30 is skipped. From then on new leads rotate between A and B.

**Track B closes for 2027** (it mentions 2026 and "before 2027"): no new leads after Dec 23, and any Track B email still due after Dec 31 is skipped. From Dec 24 new leads go to Track A only.

**Which track is winning:** `<app-url>/admin/track-report?token=<AUDIT_TOKEN>` with "All time / By month / By week" links. Per track: leads, emailed, replied, got the link, booked, negative, bounced, and rates. The best track in each period is highlighted. Add `&format=json` for raw numbers.

## 1. GitHub

New repo (e.g. `call-campaign`). Upload every file from this folder except `node_modules`.

## 2. Railway

1. New service from that repo.
2. In the same project, add a Postgres database for this service.
3. Variables (copy the shared ones from the voice app):

| Variable | Value |
|---|---|
| `DATABASE_URL` | reference variable from the new Postgres |
| `CRM_API_KEY` | same as voice app |
| `OPENAI_API_KEY` | same as voice app |
| `GOOGLE_SA_CCOPYZ_COM`, `GOOGLE_SA_CCOPYZ_ORG`, `GOOGLE_SA_CCOPYZ_NET`, `GOOGLE_SA_CREATIVECOPYZ_ORG`, `GOOGLE_SA_CREATIVECOPYZ_NET`, `GOOGLE_SA_CRETIVECOPYZ_COM` | same as voice app |
| `HANDOFF_ALERT_EMAIL` | where handoff alerts go |
| `AUDIT_TOKEN` | any long random string |
| `SETUP_TOKEN` | any long random string |

4. Settings > Networking > Generate Domain. That URL is `<app-url>` below.

## 3. Gmail push (Google Cloud)

Gmail sends one notification target per mailbox, so this app shares the voice app's topic.

Pub/Sub > Topics > `gmail-push-notifications` > Create subscription:
- Delivery type: Push
- Endpoint: `<app-url>/gmail-webhook`

Keep the voice app's subscription as it is. Both apps get every notification and each only handles its own leads.

## 4. GHL

**Pipeline** named exactly `Call Campaign`, stages in this order:
In Sequence, Reply Received, Calendar Sent, Call Booked, Handoff, No Replies, Unsubscribed, Bounced.

Open `<app-url>/setup/ghl-ids?token=<SETUP_TOKEN>` and paste the IDs into `config.js > ghl.pipeline`.

**Calendar**: the one prospects book you on. Put its share link in `config.js > calendarLink`.

**Workflow 1: enroll**
- Trigger: Contact Tag added `pestcamp_enroll`
- Action: Webhook, POST `<app-url>/enroll`
- Custom data: `city`, `state`, `country` (the business's location; the app works out its timezone from these and only emails 8am to 6pm there), plus optional `companyName` and `track` (A, B or C; leave out to rotate). If the city isn't recognised it uses the state, then the country, then US Eastern.

**Workflow 2: booked**
- Trigger: Customer Booked Appointment, filtered to the call calendar
- Action: Webhook, POST `<app-url>/webhook/call-booked`

If the voice campaign's booking workflow listens to all calendars, filter it to its own calendar so the two don't overlap.

**Tags the app adds** (all start with `pestcamp_`): `track_a`, `track_b`, `track_c`, `reply_received`, `calendar_sent`, `call_booked`, `human_handoff`, `reply_negative`, `unsubscribed`, `bounced`, `no_response`, `email_1_sent`, `autoreply_outofoffice`, `autoreply_closed`, `autoreply_wrongemail`.

## 5. Limits

`config.js > limits`: 2 new leads + 8 follow-ups per mailbox per day to start. These add to the voice campaign's own limits in the same mailboxes.

## Checks

- `<app-url>/` health
- `<app-url>/stats` leads by status, today's sends per mailbox
- `<app-url>/admin/track-report?token=<AUDIT_TOKEN>&by=week` track performance
- `<app-url>/admin/reply-audit?token=<AUDIT_TOKEN>&days=7` confirms every reply was processed (changes nothing)

## Hand a lead back to the AI after a handoff

```sql
UPDATE enrollments SET status = 'conversation', conv_status = 'active' WHERE id = <id>;
```

## Don't put one lead in both campaigns

The two apps don't know about each other's leads. A lead in both would get two sequences from different senders.
