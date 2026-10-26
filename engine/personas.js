'use strict';

// Sender name and title for each mailbox, from config.js.
// In 'director' mode every mailbox sends as the director.
const CFG = require('../config');

const BY_EMAIL = {};
for (const m of CFG.mailboxes || []) {
  if (m && m.email) BY_EMAIL[m.email.toLowerCase()] = { fullName: m.name, title: m.title };
}

const directorMode = () => CFG.senderMode !== 'personas';

function getPersona(mailbox) {
  if (directorMode()) return { fullName: CFG.director.name, title: CFG.director.title, isDirector: true };
  return BY_EMAIL[String(mailbox || '').toLowerCase()] ||
    { fullName: CFG.company.name + ' Team', title: 'Account Manager' };
}

module.exports = { getPersona, directorMode };
