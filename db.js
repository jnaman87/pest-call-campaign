'use strict';

/**
 * Database: creates every table this app needs on startup.
 * This app has its OWN Postgres database, separate from the voice campaign.
 */

const { Pool } = require('pg');
const CFG = require('./config');
const { chooseTrack } = require('./engine/render');

const CONN = process.env.DATABASE_URL || '';

const pool = new Pool({
  connectionString: CONN,
  // No SSL on Railway's private network or a local database; SSL everywhere else.
  ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(CONN) || process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: false },
  max: 5,
});

async function init(attempt = 1) {
  // Railway's private network can take a moment to come up after a restart.
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    if (attempt >= 8) throw e;
    console.log(`[db] not ready (${e.code || e.message}), retry ${attempt}/8`);
    await new Promise(r => setTimeout(r, 1000 * attempt));
    return init(attempt + 1);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS enrollments (
      id                      SERIAL PRIMARY KEY,
      contact_id              TEXT,
      prospect_email          TEXT NOT NULL,
      prospect_name           TEXT,
      prospect_city           TEXT,
      prospect_tz             TEXT DEFAULT 'America/New_York',
      company_name            TEXT,
      personalisation_hook    TEXT,
      current_pain            TEXT,
      step                    INTEGER NOT NULL DEFAULT 0,
      status                  TEXT NOT NULL DEFAULT 'active',
      next_send_at            TIMESTAMPTZ,
      enrolled_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      mailbox                 TEXT,
      thread_id               TEXT,
      last_message_id         TEXT,
      last_sent_at            TIMESTAMPTZ,
      opportunity_id          TEXT,
      conversation_history    JSONB DEFAULT '[]'::jsonb,
      conv_status             TEXT,
      calendar_sent_at        TIMESTAMPTZ,
      last_conv_at            TIMESTAMPTZ,
      conv_followup_at        TIMESTAMPTZ,
      last_inbound_message_id TEXT,
      last_inbound_at         BIGINT,
      handoff_at              TIMESTAMPTZ,
      handoff_reason          TEXT,
      first_subject           TEXT,
      booked_at               TIMESTAMPTZ
    );
  `);
  // Columns added after the first release.
  await pool.query(`ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS first_subject TEXT`);
  await pool.query(`ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS booked_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS track TEXT`);
  // First real (human) reply, for the track report.
  await pool.query(`ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ`);
  // Every Gmail thread this lead has been emailed in (each new subject starts one).
  await pool.query(`ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS thread_ids TEXT[] NOT NULL DEFAULT '{}'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS enrollments_threads_idx ON enrollments USING GIN (thread_ids);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS enrollments_due_idx     ON enrollments (status, next_send_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS enrollments_thread_idx  ON enrollments (thread_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS enrollments_contact_idx ON enrollments (contact_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS enrollments_email_idx   ON enrollments (lower(prospect_email));`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mailboxes (
      email           TEXT PRIMARY KEY,
      daily_count     INTEGER NOT NULL DEFAULT 0,
      daily_followups INTEGER NOT NULL DEFAULT 0,
      daily_reset_at  DATE NOT NULL DEFAULT '2000-01-01',
      last_sent_at    TIMESTAMPTZ
    );
  `);

  for (const m of CFG.mailboxes || []) {
    if (!m || !m.email) continue;
    await pool.query(
      `INSERT INTO mailboxes (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [m.email.toLowerCase().trim()]
    );
  }
  console.log(`[db] schema ready, ${CFG.mailboxes.length} mailbox(es)`);
}

// Adds a lead. Returns { duplicate, enrollmentId, track }.
async function enroll(d) {
  const existing = await pool.query(
    `SELECT id FROM enrollments
      WHERE lower(prospect_email) = lower($1)
        AND status NOT IN ('completed', 'unsubscribed', 'bounced', 'stopped')`,
    [d.email]
  );
  if (existing.rows.length) return { duplicate: true, enrollmentId: existing.rows[0].id };

  // Tracks rotate lead by lead (or GHL picks one).
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM enrollments');
  const track = chooseTrack(d.track, n);
  if (!track) throw new Error('No email track is ready to send (check campaign.js)');

  const r = await pool.query(
    `INSERT INTO enrollments
       (contact_id, prospect_email, prospect_name, prospect_city, prospect_tz,
        company_name, personalisation_hook, current_pain, track, step, status, next_send_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'active', NOW())
     RETURNING id`,
    [d.contactId || null, d.email, d.name || null, d.city || null, d.tz || 'America/New_York',
     d.companyName || null, d.hook || null, d.pain || null, track]
  );
  return { duplicate: false, enrollmentId: r.rows[0].id, track };
}

module.exports = { pool, init, enroll };
