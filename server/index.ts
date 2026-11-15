import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import multer from "multer";
import { DateTime } from "luxon";
import { z } from "zod";
import { db } from "./db";
import { clearSession, loginLocked, parseSessionCookie, recordLoginFailure, requireAuth, requireMutationHeader, requireRoles, setSession, verifyPasscode, type AuthenticatedRequest } from "./security";
import { deliverPendingEmails, runSchedulerTick, setDemoClockOffset, startScheduler } from "./scheduler";
import { findInteractionWarnings, transitionDose } from "./domain";
import { appointmentSchema, briefQuestionsSchema, checkinSchema, doseStatusSchema, loginSchema, medicationSchema, proposalDecisionSchema } from "./schemas";
import { createWeeklyLetter, prepareWeeklyLetter } from "./weekly-letter";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const demoMode = process.env.DEMO_MODE === "true" || (process.env.NODE_ENV !== "production" && process.env.DEMO_MODE !== "false");
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((origin) => origin.trim());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Origin is not allowed"));
}, credentials: true }));
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use("/api", requireMutationHeader);

function invalid(res: express.Response, error: z.ZodError) {
  return res.status(400).json({ error: error.issues[0]?.message ?? "Please check the information and try again." });
}
function audit(auth: NonNullable<AuthenticatedRequest["auth"]>, action: string, detail: string) {
  db.prepare("INSERT INTO audit_log(circle_id, member_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)")
    .run(auth.circleId, auth.memberId, auth.name, action, detail);
}
function addProposal(auth: NonNullable<AuthenticatedRequest["auth"]>, entity: string, action: string, payload: unknown) {
  db.prepare("INSERT INTO proposals(circle_id, entity, action, payload, proposed_by) VALUES (?, ?, ?, ?, ?)")
    .run(auth.circleId, entity, action, JSON.stringify(payload), auth.memberId);
  const article = /^[aeiou]/i.test(entity) ? "an" : "a";
  audit(auth, "Suggested a change", `${auth.name} suggested ${action === "create" ? `a new ${entity}` : `${article} ${action} to ${entity}`}.`);
}
function syncDoseSchedule(circleId: number, medicationId: number, times: string[], days: string[]) {
  const timezone = (db.prepare("SELECT timezone FROM circles WHERE id = ?").get(circleId) as { timezone: string }).timezone;
  const today = DateTime.now().setZone(timezone).startOf("day");
  db.prepare("DELETE FROM dose_events WHERE medication_id = ? AND status = 'pending' AND scheduled_at >= ?")
    .run(medicationId, today.toUTC().toISO());
  const insert = db.prepare("INSERT OR IGNORE INTO dose_events(circle_id, medication_id, scheduled_at) VALUES (?, ?, ?)");
  for (let offset = 0; offset < 7; offset++) {
    const date = today.plus({ days: offset });
    if (!days.includes(date.toFormat("ccc"))) continue;
    for (const time of times) {
      const scheduled = DateTime.fromFormat(`${date.toFormat("yyyy-LL-dd")} ${time}`, "yyyy-LL-dd h:mm a", { zone: timezone });
      if (scheduled.isValid) insert.run(circleId, medicationId, scheduled.toUTC().toISO());
    }
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/session", (req, res) => {
  const sessionId = req.cookies?.dhaaga_session ? parseSessionCookie(req.cookies.dhaaga_session) : null;
  const session = sessionId ? db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(sessionId) as { expires_at: string } | undefined : undefined;
  return res.json({ authenticated: Boolean(session && Date.parse(session.expires_at) > Date.now()) });
});

app.post("/api/login", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const input = parsed.data;
  const circle = db.prepare("SELECT id FROM circles WHERE lower(slug) = lower(?)").get(input.circle.toLowerCase().replace(/_/g, "-")) as { id: number } | undefined;
  const canonicalSlug = input.circle.toLowerCase().replace(/_/g, "-");
  if (loginLocked(req.ip ?? "unknown", canonicalSlug)) return res.status(429).json({ error: "For everyone’s privacy, this circle is taking a short break. Please try again in 15 minutes." });
  const circleCode = circle ? db.prepare("SELECT scrypt_hash, salt FROM circle_codes WHERE circle_id = ? AND role = ?").get(circle.id, input.role) as { scrypt_hash: string; salt: string } | undefined : undefined;
  if (!circle || !circleCode || !verifyPasscode(input.passcode, circleCode.salt, circleCode.scrypt_hash)) {
    recordLoginFailure(req.ip ?? "unknown", canonicalSlug);
    return res.status(401).json({ error: "That circle ID or passcode doesn’t look right. Check with your circle and try again." });
  }
  const email = input.email.toLowerCase();
  let member = db.prepare("SELECT id, name, email FROM members WHERE circle_id = ? AND role = ? AND lower(name) = lower(?)")
    .get(circle.id, input.role, input.name) as { id: number; name: string; email: string } | undefined;
  if (!email && !member?.email) return res.status(400).json({ error: "Please add an email address so your circle can share reminders with you." });
  if (!member) {
    const result = db.prepare("INSERT INTO members(circle_id, name, email, role) VALUES (?, ?, ?, ?)")
      .run(circle.id, input.name, email, input.role);
    member = { id: Number(result.lastInsertRowid), name: input.name, email };
  } else if (email && !member.email) {
    db.prepare("UPDATE members SET email = ? WHERE id = ?").run(email, member.id);
    member.email = email;
  }
  db.prepare("DELETE FROM login_attempts WHERE ip = ? AND circle_slug = ?").run(req.ip ?? "unknown", canonicalSlug);
  setSession(res, member.id);
  return res.json({ member: { name: member.name, role: input.role } });
});

app.post("/api/logout", (req, res) => {
  clearSession(res, req.cookies?.dhaaga_session);
  res.json({ ok: true });
});

app.get("/api/bootstrap", requireAuth, (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  const circle = db.prepare("SELECT name, elder_name, timezone, caretaker_direct_edit, escalation_caretaker_minutes, escalation_family_minutes FROM circles WHERE id = ?").get(auth.circleId) as { name: string; elder_name: string; timezone: string; caretaker_direct_edit: number; escalation_caretaker_minutes: number; escalation_family_minutes: number };
  const localStart = DateTime.now().setZone(circle.timezone).startOf("day").toUTC().toISO()!;
  const localEnd = DateTime.now().setZone(circle.timezone).endOf("day").toUTC().toISO()!;
  const monthStart = DateTime.now().setZone(circle.timezone).startOf("day").minus({ days: 29 }).toUTC().toISO()!;
  const weekStart = DateTime.now().setZone(circle.timezone).startOf("day").minus({ days: 6 }).toUTC().toISO()!;
  const score = (start: string, end: string) => {
    const result = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('taken','late') THEN 1 ELSE 0 END) AS completed
      FROM dose_events WHERE circle_id = ? AND scheduled_at BETWEEN ? AND ?
    `).get(auth.circleId, start, end) as { total: number; completed: number | null };
    return result.total ? Math.round((Number(result.completed ?? 0) / result.total) * 100) : 100;
  };
  const adherence = { today: score(localStart, localEnd), week: score(weekStart, localEnd), month: score(monthStart, localEnd) };
  const medications = (db.prepare("SELECT id, name, dose, instructions, times AS schedule, days FROM medications WHERE circle_id = ? AND active = 1 ORDER BY id").all(auth.circleId) as { id: number; name: string; dose: string; instructions: string; schedule: string; days: string }[])
    .map((med) => ({ ...med, schedule: JSON.parse(med.schedule) as string[], days: JSON.parse(med.days) as string[] }));
  const doses = db.prepare(`
    SELECT d.id, d.medication_id, m.name AS medication, m.dose, d.scheduled_at, d.status, d.taken_at
    FROM dose_events d JOIN medications m ON m.id = d.medication_id
    WHERE d.circle_id = ? AND d.scheduled_at BETWEEN ? AND ? ORDER BY d.scheduled_at
  `).all(auth.circleId, localStart, localEnd);
  const appointments = db.prepare("SELECT id, doctor, specialty, place, notes, starts_at FROM appointments WHERE circle_id = ? AND starts_at >= ? ORDER BY starts_at")
    .all(auth.circleId, new Date().toISOString());
  const proposals = db.prepare(`
    SELECT p.id, p.entity, p.action, p.payload, p.status, p.created_at, m.name AS proposed_by
    FROM proposals p LEFT JOIN members m ON m.id = p.proposed_by
    WHERE p.circle_id = ? AND p.status = 'pending' ORDER BY p.created_at DESC
  `).all(auth.circleId);
  const auditRows = db.prepare("SELECT id, actor, action, detail, created_at FROM audit_log WHERE circle_id = ? ORDER BY id DESC LIMIT 20").all(auth.circleId);
  const checkin = db.prepare("SELECT mood, note FROM checkins WHERE circle_id = ? AND date = ? ORDER BY id DESC LIMIT 1")
    .get(auth.circleId, DateTime.now().setZone(circle.timezone).toFormat("yyyy-LL-dd")) ?? null;
  const outbox = auth.role === "Family" ? [] : db.prepare("SELECT id, kind, to_email, subject, body, sent_at FROM outbox WHERE circle_id = ? ORDER BY id DESC LIMIT 100").all(auth.circleId);
  res.json({ circle, member: { name: auth.name, role: auth.role }, medications, doses, appointments, proposals, audit: auditRows, checkin, outbox, adherence });
});

app.get("/api/brief", requireAuth, (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  const circle = db.prepare("SELECT timezone FROM circles WHERE id = ?").get(auth.circleId) as { timezone: string };
  const now = DateTime.now().setZone(circle.timezone);
  const today = now.toFormat("yyyy-LL-dd");
  const range = (days: number) => ({
    start: now.startOf("day").minus({ days: days - 1 }).toUTC().toISO()!,
    end: now.endOf("day").toUTC().toISO()!,
  });
  const adherenceFor = (days: number) => {
    const period = range(days);
    const result = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status IN ('taken','late') THEN 1 ELSE 0 END) AS completed
      FROM dose_events WHERE circle_id = ? AND scheduled_at BETWEEN ? AND ?
    `).get(auth.circleId, period.start, period.end) as { total: number; completed: number | null };
    return {
      percentage: result.total ? Math.round((Number(result.completed ?? 0) / result.total) * 100) : null,
      completed: Number(result.completed ?? 0),
      total: result.total,
    };
  };
  const medications = (db.prepare(`
    SELECT id, name, dose, instructions, times AS schedule, days
    FROM medications WHERE circle_id = ? AND active = 1 ORDER BY name
  `).all(auth.circleId) as { id: number; name: string; dose: string; instructions: string; schedule: string; days: string }[])
    .map((medication) => ({ ...medication, schedule: JSON.parse(medication.schedule) as string[], days: JSON.parse(medication.days) as string[] }));
  const missedOrLate = db.prepare(`
    SELECT d.id, m.name AS medication, m.dose, d.scheduled_at, d.status
    FROM dose_events d JOIN medications m ON m.id = d.medication_id
    WHERE d.circle_id = ? AND d.status IN ('missed','late') AND d.scheduled_at >= ? AND d.scheduled_at <= ?
    ORDER BY d.scheduled_at DESC LIMIT 50
  `).all(auth.circleId, range(30).start, range(30).end);
  const moodTrend = db.prepare(`
    SELECT date, ROUND(AVG(mood), 1) AS average_mood, COUNT(*) AS entries
    FROM checkins WHERE circle_id = ? AND date BETWEEN ? AND ?
    GROUP BY date ORDER BY date
  `).all(auth.circleId, now.minus({ days: 6 }).toFormat("yyyy-LL-dd"), today);
  const appointments = db.prepare(`
    SELECT id, doctor, specialty, place, notes, starts_at
    FROM appointments WHERE circle_id = ? AND starts_at >= ? ORDER BY starts_at
  `).all(auth.circleId, now.toUTC().toISO());
  const questionsRow = db.prepare("SELECT questions FROM brief_questions WHERE circle_id = ?").get(auth.circleId) as { questions: string } | undefined;
  return res.json({
    elderName: (db.prepare("SELECT elder_name FROM circles WHERE id = ?").get(auth.circleId) as { elder_name: string }).elder_name,
    generatedAt: now.toISO(),
    medications,
    adherence: { sevenDays: adherenceFor(7), thirtyDays: adherenceFor(30) },
    missedOrLate,
    moodTrend,
    appointments,
    questions: questionsRow ? JSON.parse(questionsRow.questions) as string[] : [],
  });
});

app.put("/api/brief/questions", requireAuth, requireRoles("Elder", "Caretaker"), (req: AuthenticatedRequest, res) => {
  const parsed = briefQuestionsSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  db.prepare(`
    INSERT INTO brief_questions(circle_id, questions, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(circle_id) DO UPDATE SET questions = excluded.questions, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(req.auth!.circleId, JSON.stringify(parsed.data.questions), req.auth!.memberId, new Date().toISOString());
  audit(req.auth!, "Updated doctor brief questions", `${req.auth!.name} updated questions for a doctor visit.`);
  return res.json({ questions: parsed.data.questions });
});

app.patch("/api/circle", requireAuth, requireRoles("Elder"), (req: AuthenticatedRequest, res) => {
  const parsed = z.object({
    caretaker_direct_edit: z.boolean().optional(),
    escalation_caretaker_minutes: z.number().int().min(5).max(240).optional(),
    escalation_family_minutes: z.number().int().min(10).max(360).optional(),
  }).refine((value) => Object.keys(value).length > 0).safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const circle = db.prepare("SELECT caretaker_direct_edit, escalation_caretaker_minutes, escalation_family_minutes FROM circles WHERE id = ?")
    .get(req.auth!.circleId) as { caretaker_direct_edit: number; escalation_caretaker_minutes: number; escalation_family_minutes: number };
  const updated = {
    caretaker_direct_edit: parsed.data.caretaker_direct_edit === undefined ? circle.caretaker_direct_edit : Number(parsed.data.caretaker_direct_edit),
    escalation_caretaker_minutes: parsed.data.escalation_caretaker_minutes ?? circle.escalation_caretaker_minutes,
    escalation_family_minutes: parsed.data.escalation_family_minutes ?? circle.escalation_family_minutes,
  };
  if (updated.escalation_family_minutes <= updated.escalation_caretaker_minutes) return res.status(400).json({ error: "The family check-in should come after the caretaker check-in." });
  db.prepare("UPDATE circles SET caretaker_direct_edit = ?, escalation_caretaker_minutes = ?, escalation_family_minutes = ? WHERE id = ?")
    .run(updated.caretaker_direct_edit, updated.escalation_caretaker_minutes, updated.escalation_family_minutes, req.auth!.circleId);
  audit(req.auth!, "Updated circle settings", `${req.auth!.name} updated the circle’s care settings.`);
  return res.json(updated);
});

app.post("/api/medications", requireAuth, requireRoles("Elder", "Caretaker"), (req: AuthenticatedRequest, res) => {
  const parsed = medicationSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const auth = req.auth!;
  const circle = db.prepare("SELECT caretaker_direct_edit FROM circles WHERE id = ?").get(auth.circleId) as { caretaker_direct_edit: number };
  if (auth.role === "Caretaker" && !circle.caretaker_direct_edit) {
    addProposal(auth, "medicine", "create", parsed.data);
    return res.status(202).json({ proposal: true });
  }
  const create = db.transaction(() => {
    const result = db.prepare("INSERT INTO medications(circle_id, name, dose, instructions, times, days) VALUES (?, ?, ?, ?, ?, ?)")
      .run(auth.circleId, parsed.data.name, parsed.data.dose, parsed.data.instructions, JSON.stringify(parsed.data.schedule), JSON.stringify(parsed.data.days));
    db.prepare("INSERT INTO schedules(medication_id, times, days) VALUES (?, ?, ?)")
      .run(result.lastInsertRowid, JSON.stringify(parsed.data.schedule), JSON.stringify(parsed.data.days));
    syncDoseSchedule(auth.circleId, Number(result.lastInsertRowid), parsed.data.schedule, parsed.data.days);
    audit(auth, "Added a medicine", `${auth.name} added ${parsed.data.name} to the daily thread.`);
    return Number(result.lastInsertRowid);
  });
  return res.status(201).json({ id: create() });
});

app.patch("/api/medications/:id", requireAuth, requireRoles("Elder", "Caretaker"), (req: AuthenticatedRequest, res) => {
  const parsed = medicationSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const auth = req.auth!;
  const medication = db.prepare("SELECT id, name FROM medications WHERE id = ? AND circle_id = ? AND active = 1")
    .get(Number(req.params.id), auth.circleId) as { id: number; name: string } | undefined;
  if (!medication) return res.status(404).json({ error: "That medicine is no longer on the thread." });
  const circle = db.prepare("SELECT caretaker_direct_edit FROM circles WHERE id = ?").get(auth.circleId) as { caretaker_direct_edit: number };
  if (auth.role === "Caretaker" && !circle.caretaker_direct_edit) {
    addProposal(auth, "medicine", "update", { ...parsed.data, id: medication.id, previous_name: medication.name });
    return res.status(202).json({ proposal: true });
  }
  db.prepare("UPDATE medications SET name = ?, dose = ?, instructions = ?, times = ?, days = ? WHERE id = ? AND circle_id = ?")
    .run(parsed.data.name, parsed.data.dose, parsed.data.instructions, JSON.stringify(parsed.data.schedule), JSON.stringify(parsed.data.days), medication.id, auth.circleId);
  db.prepare("UPDATE schedules SET times = ?, days = ? WHERE medication_id = ?")
    .run(JSON.stringify(parsed.data.schedule), JSON.stringify(parsed.data.days), medication.id);
  syncDoseSchedule(auth.circleId, medication.id, parsed.data.schedule, parsed.data.days);
  audit(auth, "Updated a medicine", `${auth.name} updated ${medication.name}.`);
  return res.json({ ok: true });
});

app.delete("/api/medications/:id", requireAuth, requireRoles("Elder", "Caretaker"), (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  const medication = db.prepare("SELECT id, name FROM medications WHERE id = ? AND circle_id = ? AND active = 1")
    .get(Number(req.params.id), auth.circleId) as { id: number; name: string } | undefined;
  if (!medication) return res.status(404).json({ error: "That medicine is no longer on the thread." });
  const circle = db.prepare("SELECT caretaker_direct_edit FROM circles WHERE id = ?").get(auth.circleId) as { caretaker_direct_edit: number };
  if (auth.role === "Caretaker" && !circle.caretaker_direct_edit) {
    addProposal(auth, "medicine", "delete", { id: medication.id, name: medication.name });
    return res.status(202).json({ proposal: true });
  }
  db.prepare("DELETE FROM medications WHERE id = ? AND circle_id = ?").run(medication.id, auth.circleId);
  audit(auth, "Removed a medicine", `${auth.name} removed ${medication.name} from the daily thread.`);
  return res.json({ ok: true });
});

app.patch("/api/doses/:id", requireAuth, requireRoles("Elder", "Caretaker"), (req: AuthenticatedRequest, res) => {
  const parsed = doseStatusSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const auth = req.auth!;
  const dose = db.prepare("SELECT id, status, scheduled_at FROM dose_events WHERE id = ? AND circle_id = ?").get(Number(req.params.id), auth.circleId) as { id: number; status: string; scheduled_at: string } | undefined;
  if (!dose) return res.status(404).json({ error: "That dose is not on this circle’s thread." });
  const status = transitionDose(dose.status as "pending" | "taken" | "late" | "missed" | "skipped", parsed.data.status, Date.parse(dose.scheduled_at), Date.now());
  if (!status) return res.status(409).json({ error: "This dose has already been recorded." });
  db.prepare("UPDATE dose_events SET status = ?, taken_at = ?, marked_by = ? WHERE id = ?")
    .run(status, parsed.data.status === "taken" ? new Date().toISOString() : null, auth.memberId, dose.id);
  audit(auth, parsed.data.status === "taken" ? "Marked a dose taken" : "Skipped a dose", `${auth.name} marked a dose ${parsed.data.status}.`);
  return res.json({ status });
});

app.post("/api/appointments", requireAuth, requireRoles("Elder", "Caretaker", "Family"), (req: AuthenticatedRequest, res) => {
  const parsed = appointmentSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const auth = req.auth!;
  if (auth.role !== "Elder") {
    addProposal(auth, "appointment", "create", parsed.data);
    return res.status(202).json({ proposal: true });
  }
  const result = db.prepare("INSERT INTO appointments(circle_id, doctor, specialty, place, notes, starts_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(auth.circleId, parsed.data.doctor, parsed.data.specialty, parsed.data.place, parsed.data.notes, parsed.data.starts_at, auth.memberId);
  audit(auth, "Added an appointment", `${auth.name} added a visit with ${parsed.data.doctor}.`);
  return res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.patch("/api/appointments/:id", requireAuth, requireRoles("Elder", "Caretaker", "Family"), (req: AuthenticatedRequest, res) => {
  const parsed = appointmentSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const auth = req.auth!;
  const appointment = db.prepare("SELECT id, doctor FROM appointments WHERE id = ? AND circle_id = ?")
    .get(Number(req.params.id), auth.circleId) as { id: number; doctor: string } | undefined;
  if (!appointment) return res.status(404).json({ error: "That visit is no longer on the calendar." });
  if (auth.role !== "Elder") {
    addProposal(auth, "appointment", "update", { ...parsed.data, id: appointment.id, previous_doctor: appointment.doctor });
    return res.status(202).json({ proposal: true });
  }
  db.prepare("UPDATE appointments SET doctor = ?, specialty = ?, place = ?, notes = ?, starts_at = ? WHERE id = ? AND circle_id = ?")
    .run(parsed.data.doctor, parsed.data.specialty, parsed.data.place, parsed.data.notes, parsed.data.starts_at, appointment.id, auth.circleId);
  audit(auth, "Updated an appointment", `${auth.name} updated a visit with ${appointment.doctor}.`);
  return res.json({ ok: true });
});

app.delete("/api/appointments/:id", requireAuth, requireRoles("Elder", "Caretaker", "Family"), (req: AuthenticatedRequest, res) => {
  const auth = req.auth!;
  const appointment = db.prepare("SELECT id, doctor FROM appointments WHERE id = ? AND circle_id = ?")
    .get(Number(req.params.id), auth.circleId) as { id: number; doctor: string } | undefined;
  if (!appointment) return res.status(404).json({ error: "That visit is no longer on the calendar." });
  if (auth.role !== "Elder") {
    addProposal(auth, "appointment", "delete", { id: appointment.id, doctor: appointment.doctor });
    return res.status(202).json({ proposal: true });
  }
  db.prepare("DELETE FROM appointments WHERE id = ? AND circle_id = ?").run(appointment.id, auth.circleId);
  audit(auth, "Removed an appointment", `${auth.name} removed a visit with ${appointment.doctor}.`);
  return res.json({ ok: true });
});

app.patch("/api/proposals/:id", requireAuth, requireRoles("Elder"), (req: AuthenticatedRequest, res) => {
  const parsed = proposalDecisionSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const auth = req.auth!;
  const proposal = db.prepare("SELECT * FROM proposals WHERE id = ? AND circle_id = ? AND status = 'pending'")
    .get(Number(req.params.id), auth.circleId) as { id: number; entity: string; action: string; payload: string } | undefined;
  if (!proposal) return res.status(404).json({ error: "That suggestion is no longer waiting." });
  const apply = db.transaction(() => {
    if (parsed.data.decision === "approved" && proposal.action === "create" && proposal.entity === "medicine") {
      const payload = medicationSchema.parse(JSON.parse(proposal.payload));
      const result = db.prepare("INSERT INTO medications(circle_id, name, dose, instructions, times, days) VALUES (?, ?, ?, ?, ?, ?)")
        .run(auth.circleId, payload.name, payload.dose, payload.instructions, JSON.stringify(payload.schedule), JSON.stringify(payload.days));
      db.prepare("INSERT INTO schedules(medication_id, times, days) VALUES (?, ?, ?)").run(result.lastInsertRowid, JSON.stringify(payload.schedule), JSON.stringify(payload.days));
      syncDoseSchedule(auth.circleId, Number(result.lastInsertRowid), payload.schedule, payload.days);
    } else if (parsed.data.decision === "approved" && proposal.action === "create" && proposal.entity === "appointment") {
      const payload = appointmentSchema.parse(JSON.parse(proposal.payload));
      db.prepare("INSERT INTO appointments(circle_id, doctor, specialty, place, notes, starts_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(auth.circleId, payload.doctor, payload.specialty, payload.place, payload.notes, payload.starts_at, auth.memberId);
    } else if (parsed.data.decision === "approved" && proposal.entity === "medicine" && proposal.action === "update") {
      const { id, ...payload } = JSON.parse(proposal.payload) as { id: number } & z.infer<typeof medicationSchema>;
      const medication = medicationSchema.parse(payload);
      db.prepare("UPDATE medications SET name = ?, dose = ?, instructions = ?, times = ?, days = ? WHERE id = ? AND circle_id = ?")
        .run(medication.name, medication.dose, medication.instructions, JSON.stringify(medication.schedule), JSON.stringify(medication.days), id, auth.circleId);
      db.prepare("UPDATE schedules SET times = ?, days = ? WHERE medication_id = ?")
        .run(JSON.stringify(medication.schedule), JSON.stringify(medication.days), id);
      syncDoseSchedule(auth.circleId, id, medication.schedule, medication.days);
    } else if (parsed.data.decision === "approved" && proposal.entity === "medicine" && proposal.action === "delete") {
      const payload = z.object({ id: z.number().int() }).parse(JSON.parse(proposal.payload));
      db.prepare("DELETE FROM medications WHERE id = ? AND circle_id = ?").run(payload.id, auth.circleId);
    } else if (parsed.data.decision === "approved" && proposal.entity === "appointment" && proposal.action === "update") {
      const { id, ...payload } = JSON.parse(proposal.payload) as { id: number } & z.infer<typeof appointmentSchema>;
      const appointment = appointmentSchema.parse(payload);
      db.prepare("UPDATE appointments SET doctor = ?, specialty = ?, place = ?, notes = ?, starts_at = ? WHERE id = ? AND circle_id = ?")
        .run(appointment.doctor, appointment.specialty, appointment.place, appointment.notes, appointment.starts_at, id, auth.circleId);
    } else if (parsed.data.decision === "approved" && proposal.entity === "appointment" && proposal.action === "delete") {
      const payload = z.object({ id: z.number().int() }).parse(JSON.parse(proposal.payload));
      db.prepare("DELETE FROM appointments WHERE id = ? AND circle_id = ?").run(payload.id, auth.circleId);
    }
    db.prepare("UPDATE proposals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?")
      .run(parsed.data.decision, new Date().toISOString(), auth.memberId, proposal.id);
    const article = /^[aeiou]/i.test(proposal.entity) ? "an" : "a";
    audit(auth, parsed.data.decision === "approved" ? "Approved a suggestion" : "Set a suggestion aside",
      `${auth.name} ${parsed.data.decision === "approved" ? "approved" : "declined"} ${article} ${proposal.entity} suggestion.`);
  });
  try { apply(); } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "This suggestion needs a quick update before it can be approved." });
    throw error;
  }
  return res.json({ status: parsed.data.decision });
});

app.post("/api/checkins", requireAuth, requireRoles("Elder"), (req: AuthenticatedRequest, res) => {
  const parsed = checkinSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const auth = req.auth!;
  const timezone = (db.prepare("SELECT timezone FROM circles WHERE id = ?").get(auth.circleId) as { timezone: string }).timezone;
  const date = DateTime.now().setZone(timezone).toFormat("yyyy-LL-dd");
  db.prepare("INSERT INTO checkins(circle_id, member_id, mood, note, date) VALUES (?, ?, ?, ?, ?) ON CONFLICT(circle_id, member_id, date) DO UPDATE SET mood = excluded.mood, note = excluded.note")
    .run(auth.circleId, auth.memberId, parsed.data.mood, parsed.data.note, date);
  audit(auth, "Shared a check-in", `${auth.name} shared a daily wellbeing check-in.`);
  return res.json({ ok: true });
});

app.get("/api/letter/preview", requireAuth, async (req: AuthenticatedRequest, res) => {
  const letter = await prepareWeeklyLetter(req.auth!.circleId, new Date(), false);
  const recipients = db.prepare("SELECT COUNT(*) AS count FROM members WHERE circle_id = ? AND role = 'Family' AND email <> ''")
    .get(req.auth!.circleId) as { count: number };
  return res.json({ weekKey: letter.data.weekKey, recipientCount: recipients.count, subject: letter.subject, body: letter.body, data: letter.data });
});

app.post("/api/letter/send-now", requireAuth, requireRoles("Elder", "Caretaker"), async (req: AuthenticatedRequest, res) => {
  const letter = await createWeeklyLetter(req.auth!.circleId, new Date());
  if (!letter.recipientCount) return res.json({ ...letter, sent: 0 });
  const dedupeKey = `sunday-letter:${req.auth!.circleId}:${letter.data.weekKey}`;
  const saved = db.prepare("SELECT id, subject, body, sent_at FROM outbox WHERE dedupe_key = ?").get(dedupeKey) as { id: number; subject: string; body: string; sent_at: string | null } | undefined;
  if (!saved) throw new Error("The weekly letter could not be found in the outbox after saving.");
  try {
    await deliverPendingEmails([saved.id]);
  } catch {
    return res.status(502).json({ error: "The letter is saved in the outbox, but email delivery failed. It is still available there." });
  }
  const delivered = db.prepare("SELECT sent_at FROM outbox WHERE id = ?").get(saved.id) as { sent_at: string | null };
  return res.json({ ...letter, subject: saved.subject, body: saved.body, sentAt: delivered.sent_at, sent: Number(Boolean(delivered.sent_at)) });
});

app.get("/api/outbox", requireAuth, (req: AuthenticatedRequest, res) => {
  if (req.auth!.role === "Family") return res.status(403).json({ error: "Outbox messages are private to the circle’s care team." });
  const rows = db.prepare("SELECT id, kind, to_email, subject, body, sent_at FROM outbox WHERE circle_id = ? ORDER BY id DESC LIMIT 100").all(req.auth!.circleId);
  return res.json({ messages: rows });
});

app.post("/api/demo/clock", requireAuth, requireRoles("Elder"), async (req: AuthenticatedRequest, res) => {
  if (!demoMode) return res.status(404).json({ error: "Demo tools are not enabled." });
  const parsed = z.object({ minutes: z.number().int().min(1).max(120) }).safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const offset = setDemoClockOffset(parsed.data.minutes);
  const result = await runSchedulerTick(() => new Date(Date.now() + offset));
  return res.json({ minutes: parsed.data.minutes, ...result });
});

app.post("/api/interactions", requireAuth, requireRoles("Elder", "Caretaker"), async (req: AuthenticatedRequest, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error);
  const names = db.prepare("SELECT name FROM medications WHERE circle_id = ? AND active = 1").all(req.auth!.circleId) as { name: string }[];
  let findings = findInteractionWarnings(parsed.data.name, names.map((item) => item.name));
  if (process.env.GEMINI_API_KEY && findings.length) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
        contents: `Rewrite each finding in plain, gentle language without adding medical claims or changing its meaning. Return a JSON array with one string per finding. Preserve the final sentence exactly: "Ask your doctor or pharmacist."\n${JSON.stringify(findings.map((item) => item.note))}`,
      });
      const rewritten = z.array(z.string().trim().min(1).max(500)).length(findings.length)
        .safeParse(JSON.parse(response.text?.replace(/```(?:json)?|```/g, "").trim() ?? ""));
      if (!rewritten.success) return res.status(502).json({ error: "The optional interaction wording rewrite failed. Nothing was added; please try again." });
      findings = findings.map((finding, index) => {
        const note = rewritten.data[index];
        return { ...finding, note: note.endsWith("Ask your doctor or pharmacist.") ? note : `${note} Ask your doctor or pharmacist.` };
      });
    } catch {
      return res.status(502).json({ error: "The optional interaction wording rewrite failed. Nothing was added; please try again." });
    }
  }
  return res.json({ label: "Starter list, not exhaustive", findings });
});

app.post("/api/prescription-draft", requireAuth, requireRoles("Elder", "Caretaker"), upload.single("image"), async (req: AuthenticatedRequest, res) => {
  if (!req.file || !["image/jpeg", "image/png", "image/webp"].includes(req.file.mimetype)) return res.status(400).json({ error: "Choose a JPEG, PNG, or WebP prescription photo under 4 MB." });
  const bytes = req.file.buffer;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isWebp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!(isJpeg || isPng || isWebp)) return res.status(400).json({ error: "This file does not look like the selected image type." });
  let suggestion = { name: "Medicine name from prescription", dose: "Confirm the dose", instructions: "Please check each detail with the prescription.", schedule: ["8:00 AM"] };
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: key });
      const answer = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
        contents: [{ inlineData: { mimeType: req.file.mimetype, data: bytes.toString("base64") } }, { text: "Read this prescription and return JSON only with name, dose, instructions, and schedule (array of 12-hour times). Do not infer missing details; use empty strings or an empty array." }],
      });
      const raw = answer.text?.replace(/```(?:json)?|```/g, "").trim();
      const parsed = medicationSchema.pick({ name: true, dose: true, instructions: true, schedule: true }).safeParse(JSON.parse(raw ?? ""));
      if (!parsed.success) return res.status(502).json({ error: "The prescription was read, but its details need to be entered by hand." });
      suggestion = parsed.data;
    } catch (error) {
      console.error("Prescription parsing could not complete.");
      return res.status(502).json({ error: "The prescription could not be read just now. You can enter the details by hand." });
    }
  }
  return res.json({ draft: medicationSchema.pick({ name: true, dose: true, instructions: true, schedule: true }).parse(suggestion), needs_elder_confirmation: true, image_stored: false });
});

app.get("/api/demo", (_req, res) => res.json({ enabled: demoMode }));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "That photo is over 4 MB. Please choose a smaller image." });
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "That request could not be read. Please check the information and try again." });
  console.error("Dhaaga request failed.");
  return res.status(500).json({ error: "Something went wrong on this side. Please try again." });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`Dhaaga API listening on http://localhost:${port}`);
    startScheduler();
  });
}

export { app };
