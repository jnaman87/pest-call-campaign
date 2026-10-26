'use strict';
// One shared connection pool (configured in db.js).
module.exports = require('../db').pool;
