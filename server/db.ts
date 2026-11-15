import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const requestedFilename = process.env.DHAAGA_DB ?? "data/dhaaga.sqlite";
const filename = requestedFilename === ":memory:" ? requestedFilename : resolve(requestedFilename);
if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });

export const db = new Database(filename);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS circles (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  elder_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  language TEXT NOT NULL DEFAULT 'en',
  caretaker_direct_edit INTEGER NOT NULL DEFAULT 0,
  escalation_caretaker_minutes INTEGER NOT NULL DEFAULT 20,
  escalation_family_minutes INTEGER NOT NULL DEFAULT 45
);
CREATE TABLE IF NOT EXISTS circle_codes (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  scrypt_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  UNIQUE(circle_id, role)
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dose TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  times TEXT NOT NULL,
  days TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  times TEXT NOT NULL,
  days TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dose_events (
  id INTEGER PRIMARY KEY,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','taken','late','missed','skipped')),
  taken_at TEXT,
  marked_by INTEGER REFERENCES members(id),
  UNIQUE(medication_id, scheduled_at)
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  doctor TEXT NOT NULL,
  specialty TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  created_by INTEGER REFERENCES members(id)
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_by INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  decided_by INTEGER REFERENCES members(id)
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id),
  mood INTEGER NOT NULL CHECK(mood BETWEEN 1 AND 5),
  note TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  UNIQUE(circle_id, member_id, date)
);
CREATE TABLE IF NOT EXISTS brief_questions (
  circle_id INTEGER PRIMARY KEY REFERENCES circles(id) ON DELETE CASCADE,
  questions TEXT NOT NULL DEFAULT '[]',
  updated_by INTEGER REFERENCES members(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER REFERENCES circles(id),
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY,
  ip TEXT NOT NULL,
  circle_slug TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  locked_until TEXT
);
CREATE INDEX IF NOT EXISTS dose_events_circle_time ON dose_events(circle_id, scheduled_at);
CREATE INDEX IF NOT EXISTS dose_events_due ON dose_events(scheduled_at, status);
CREATE INDEX IF NOT EXISTS dose_events_medication ON dose_events(medication_id);
CREATE INDEX IF NOT EXISTS circle_codes_circle ON circle_codes(circle_id);
CREATE INDEX IF NOT EXISTS members_circle_role ON members(circle_id, role);
CREATE INDEX IF NOT EXISTS medications_circle_active ON medications(circle_id, active);
CREATE INDEX IF NOT EXISTS schedules_medication ON schedules(medication_id);
CREATE INDEX IF NOT EXISTS appointments_circle_start ON appointments(circle_id, starts_at);
CREATE INDEX IF NOT EXISTS appointments_start ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS proposals_circle_status_created ON proposals(circle_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS checkins_circle_date ON checkins(circle_id, date);
CREATE INDEX IF NOT EXISTS outbox_circle ON outbox(circle_id, id);
CREATE INDEX IF NOT EXISTS outbox_dedupe ON outbox(dedupe_key);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(sent_at, id);
CREATE INDEX IF NOT EXISTS audit_circle ON audit_log(circle_id, id DESC);
CREATE INDEX IF NOT EXISTS sessions_member ON sessions(member_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS login_attempts_ip_circle_time ON login_attempts(ip, circle_slug, attempted_at);
`);

const circleColumns = db.pragma("table_info(circles)") as { name: string }[];
if (!circleColumns.some((column) => column.name === "escalation_caretaker_minutes")) {
  db.exec("ALTER TABLE circles ADD COLUMN escalation_caretaker_minutes INTEGER NOT NULL DEFAULT 20");
}
if (!circleColumns.some((column) => column.name === "escalation_family_minutes")) {
  db.exec("ALTER TABLE circles ADD COLUMN escalation_family_minutes INTEGER NOT NULL DEFAULT 45");
}
