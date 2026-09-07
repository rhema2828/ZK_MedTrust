'use strict';
//
// Loads compliance/compliance_cases.sql — verbatim, DROP TABLE/CREATE
// TABLE/INSERT statements exactly as provided — into a real SQLite
// database file via Node's built-in `node:sqlite` (Node 22+, no native
// module install, no network dependency). This is not a hand-parsed JS
// re-encoding of the file's rows: `db.exec()` below runs the actual SQL.
//
// The .db file lives in build/ (gitignored, same as every other generated
// artifact in this project) and is rebuilt from the .sql source on every
// server boot — cheap (15 rows) and means the .sql file is always the
// single source of truth; the .db file is disposable.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { CRITERIA, bitsFor, passCount } = require('./criteria');

const ROOT = path.join(__dirname, '..');
const SQL_PATH = path.join(__dirname, 'compliance_cases.sql');
const DB_PATH = path.join(ROOT, 'build', 'compliance.db');

let dbInstance = null;

function getDb() {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  // Rebuilt fresh each boot (the .sql source starts with DROP TABLE IF
  // EXISTS, so re-running it against a stale build/compliance.db is safe
  // and idempotent) rather than trying to diff/migrate an existing file.
  const db = new DatabaseSync(DB_PATH);
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  db.exec(sql);
  dbInstance = db;
  return db;
}

// Every column from the .sql schema, in source order — used to load a full
// row without hand-maintaining a column list that could drift from the
// actual CREATE TABLE statement.
function allCases() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM compliance_cases ORDER BY case_id').all();
  return rows.map((row) => ({ ...row })); // drop the null-prototype node:sqlite gives back
}

function caseById(caseId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM compliance_cases WHERE case_id = ?').get(caseId);
  return row ? { ...row } : null;
}

// Public-facing summary: business metadata (never treated as private
// witness data — institution/jurisdiction/amount are exactly what a real
// compliance dashboard would show) plus the 20 real pass/fail booleans and
// the aggregate count. Never includes bits/salts/signatures — those are
// the private witness fields the ZK proof exists to keep out of a plain
// database read (see build-compliance-tree.js).
function summaryFor(row) {
  const bits = bitsFor(row);
  return {
    caseId: row.case_id,
    institution: row.institution,
    jurisdiction: row.jurisdiction,
    amount: row.amount,
    currency: row.currency,
    purpose: row.purpose,
    criteria: CRITERIA.map((c, i) => ({ key: c.key, label: c.label, value: row[c.column], pass: bits[i] === 1 })),
    passCount: passCount(row),
    totalCriteria: CRITERIA.length,
  };
}

module.exports = { getDb, allCases, caseById, summaryFor, DB_PATH };
