'use strict';

// Everything this app does in GHL: tags, notes, DND, the pipeline, contact updates.

const pool = require('./pool');
const CFG = require('../config');

const CRM_API = 'https://services.leadconnectorhq.com';
const CRM_API_KEY = process.env.CRM_API_KEY;
const LOCATION_ID = process.env.CRM_LOCATION_ID || CFG.ghl.locationId;
const PIPE = CFG.ghl.pipeline;

// Tag names all start with the prefix from config.js, e.g. "pestcamp_calendar_sent".
const tag = name => `${CFG.tagPrefix}_${name}`;

function headers(version = '2021-07-28') {
  return { Authorization: `Bearer ${CRM_API_KEY}`, Version: version, 'Content-Type': 'application/json' };
}
const configured = v => v && !/^CHANGE_ME/.test(v);

async function ghl(method, path, body, version) {
  if (!CRM_API_KEY) return { ok: false, status: 0, data: null };
  try {
    const r = await fetch(`${CRM_API}${path}`, {
      method, headers: headers(version), body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) console.error(`[crm] ${method} ${path.split('?')[0]} failed (${r.status}): ${String(text).slice(0, 200)}`);
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    console.error(`[crm] ${method} ${path.split('?')[0]} error: ${e.message}`);
    return { ok: false, status: 0, data: null };
  }
}

async function addTag(contactId, name) {
  if (!contactId) return;
  await ghl('POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { tags: [tag(name)] }, '2021-04-15');
}

async function addNote(contactId, body) {
  if (!contactId) return;
  await ghl('POST', `/contacts/${encodeURIComponent(contactId)}/notes`, { body }, '2021-04-15');
}

// channels: 'all' or a list like ['Email']
async function enableDND(contactId, channels, reason) {
  if (!contactId) return;
  const list = channels === 'all' ? ['Call', 'Email', 'SMS', 'WhatsApp', 'GMB', 'FB'] : channels;
  const dndSettings = Object.fromEntries(list.map(ch => [ch, { status: 'active', message: reason || 'Opted out', code: 'OPTOUT' }]));
  await ghl('PUT', `/contacts/${encodeURIComponent(contactId)}`, channels === 'all' ? { dnd: true, dndSettings } : { dndSettings });
}

async function updateContact(contactId, fields) {
  if (!contactId) return { ok: false };
  return ghl('PUT', `/contacts/${encodeURIComponent(contactId)}`, fields);
}

// The lead's deal in the "Call Campaign" pipeline. Created at enrollment.
async function ensureOpportunity(enrollment) {
  if (!enrollment.contact_id || !configured(PIPE.pipelineId)) return null;
  if (enrollment.opportunity_id) return enrollment.opportunity_id;

  const params = new URLSearchParams({ location_id: LOCATION_ID, contact_id: enrollment.contact_id, pipeline_id: PIPE.pipelineId });
  const found = await ghl('GET', `/opportunities/search?${params}`);
  let id = found.ok && found.data && found.data.opportunities && found.data.opportunities[0] && found.data.opportunities[0].id;

  if (!id) {
    const created = await ghl('POST', '/opportunities/', {
      pipelineId: PIPE.pipelineId,
      locationId: LOCATION_ID,
      pipelineStageId: PIPE.stages.inSequence,
      name: `${enrollment.company_name || enrollment.prospect_email} -- Call Campaign`,
      status: 'open',
      contactId: enrollment.contact_id,
    });
    id = created.ok && created.data && created.data.opportunity && created.data.opportunity.id;
  }
  if (id) await pool.query('UPDATE enrollments SET opportunity_id = $1 WHERE id = $2', [id, enrollment.id]);
  return id || null;
}

// stageKey: one of the keys in config.js ghl.pipeline.stages
async function moveStage(enrollment, stageKey) {
  const stageId = PIPE.stages[stageKey];
  if (!configured(stageId)) return;
  const oppId = await ensureOpportunity(enrollment);
  if (!oppId) return;
  const r = await ghl('PUT', `/opportunities/${oppId}`, { pipelineStageId: stageId });
  if (r.ok) console.log(`[crm] ${enrollment.prospect_email} -> ${stageKey}`);
}

module.exports = {
  tag, addTag, addNote, enableDND, updateContact, ensureOpportunity, moveStage,
  CRM_API, LOCATION_ID, ghl,
};
