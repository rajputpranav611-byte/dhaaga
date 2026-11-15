import { DateTime } from "luxon";
import { db } from "./db";
import { createWeeklyLetter } from "./weekly-letter";

export type Clock = () => Date;
export interface ReminderResult { created: number; sent: number; }

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
let demoClockOffset = 0;
export function setDemoClockOffset(minutes: number) {
  demoClockOffset += minutes * 60_000;
  return demoClockOffset;
}
export function resetDemoClockOffset() { demoClockOffset = 0; }
export function demoClock() { return new Date(Date.now() + demoClockOffset); }

function makeOutbox(circleId: number, kind: string, to: string, subject: string, body: string, key: string) {
  if (!to) return false;
  const result = db.prepare("INSERT OR IGNORE INTO outbox(circle_id, kind, to_email, subject, body, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)")
    .run(circleId, kind, to, subject, body, key);
  if (result.changes === 1) return true;
  return false;
}

export async function deliverPendingEmails(onlyIds?: number[]) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || onlyIds?.length === 0) return 0;
  const pending = (onlyIds
    ? db.prepare(`SELECT id, to_email, subject, body FROM outbox WHERE sent_at IS NULL AND id IN (${onlyIds.map(() => "?").join(",")}) ORDER BY id`)
      .all(...onlyIds)
    : db.prepare("SELECT id, to_email, subject, body FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT 20").all()) as
      { id: number; to_email: string; subject: string; body: string }[];
  let sent = 0;
  for (const mail of pending) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM ?? "Dhaaga <care@example.com>", to: mail.to_email.split(",").map((address) => address.trim()), subject: mail.subject, html: `<p>${escapeHtml(mail.body).replace(/\n/g, "<br>")}</p>` }),
    });
    if (!response.ok) throw new Error(`Email delivery failed with status ${response.status}`);
    db.prepare("UPDATE outbox SET sent_at = ? WHERE id = ?").run(new Date().toISOString(), mail.id);
    sent++;
  }
  return sent;
}

export async function runSchedulerTick(clock: Clock = demoClock): Promise<ReminderResult> {
  const now = clock();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const recentCutoff = new Date(nowMs - 24 * 60 * 60_000).toISOString();
  const dueCutoff = new Date(nowMs - 5 * 60_000).toISOString();
  const upcomingCutoff = new Date(nowMs + 15 * 60_000).toISOString();
  let created = 0;
  const joinedDoseRows = db.prepare(`
    SELECT d.id, d.circle_id, d.status, d.scheduled_at, d.medication_id, m.name AS medication,
           c.timezone, c.elder_name, c.escalation_caretaker_minutes, c.escalation_family_minutes,
           recipient.role AS recipient_role, recipient.email AS recipient_email
    FROM dose_events d
    JOIN medications m ON m.id = d.medication_id
    JOIN circles c ON c.id = d.circle_id
    LEFT JOIN members recipient ON recipient.circle_id = d.circle_id
      AND recipient.email <> '' AND recipient.role IN ('Elder','Caretaker','Family')
    WHERE d.status IN ('pending','missed')
      AND d.scheduled_at >= ? AND d.scheduled_at <= ?
      AND (d.scheduled_at >= ? OR d.scheduled_at <= ?)
    ORDER BY d.id
  `).all(recentCutoff, upcomingCutoff, nowIso, dueCutoff) as {
    id: number; circle_id: number; status: string; scheduled_at: string; medication_id: number;
    medication: string; timezone: string; elder_name: string; escalation_caretaker_minutes: number;
    escalation_family_minutes: number; recipient_role: string | null; recipient_email: string | null;
  }[];
  const doses = new Map<number, {
    id: number; circle_id: number; status: string; scheduled_at: string; medication_id: number;
    medication: string; timezone: string; elder_name: string; escalation_caretaker_minutes: number;
    escalation_family_minutes: number; people: { role: string; email: string }[];
  }>();
  for (const row of joinedDoseRows) {
    let dose = doses.get(row.id);
    if (!dose) {
      dose = { ...row, people: [] };
      doses.set(row.id, dose);
    }
    if (row.recipient_role && row.recipient_email) dose.people.push({ role: row.recipient_role, email: row.recipient_email });
  }
  for (const dose of doses.values()) {
    const at = Date.parse(dose.scheduled_at);
    if (!Number.isFinite(at)) continue;
    const people = dose.people;
    const elder = people.find((person) => person.role === "Elder");
    const caretakers = people.filter((person) => person.role === "Caretaker");
    const family = people.filter((person) => person.role === "Family");
    const localDate = DateTime.fromMillis(at, { zone: dose.timezone }).toFormat("yyyy-LL-dd");
    if (dose.status === "pending" && at - nowMs <= 15 * 60_000 && at > nowMs) {
      if (elder && makeOutbox(dose.circle_id, "upcoming-dose", elder.email, `A gentle nudge for ${dose.medication}`, `Hi ${escapeHtml(dose.elder_name)}, ${escapeHtml(dose.medication)} is coming up soon. Your circle is here if you need a hand.`, `dose-upcoming:${dose.id}`)) created++;
    }
    if (dose.status === "pending" && nowMs >= at + 30 * 60_000) {
      db.prepare("UPDATE dose_events SET status = 'missed' WHERE id = ? AND status = 'pending'").run(dose.id);
      if (elder && makeOutbox(dose.circle_id, "missed-dose", elder.email, `A check-in about ${dose.medication}`, `Hi ${escapeHtml(dose.elder_name)}, it looks like the ${escapeHtml(dose.medication)} dose may have been missed. If that is not right, you can update it in your circle. Please follow your care plan.`, `dose-missed:${dose.id}`)) created++;
    }
    const age = nowMs - at;
    if (age >= dose.escalation_caretaker_minutes * 60_000) {
      for (const person of caretakers) {
        if (makeOutbox(dose.circle_id, "caregiver-followup", person.email, `A gentle check-in for ${dose.elder_name}`, `Hello, ${dose.elder_name} may need a hand checking in on ${dose.medication} today. When you have a moment, please reach out.`, `dose-caregiver:${dose.id}:${person.email}:${localDate}`)) created++;
      }
    }
    if (age >= dose.escalation_family_minutes * 60_000) {
      for (const person of family) {
        if (makeOutbox(dose.circle_id, "family-followup", person.email, `A note about ${dose.elder_name}’s day`, `Hello, there may be a missed ${dose.medication} dose to check in about. A gentle call or message could help. Please follow the care plan together.`, `dose-family:${dose.id}:${person.email}:${localDate}`)) created++;
      }
    }
  }
  const appointmentRows = db.prepare(`
    SELECT a.id, a.circle_id, a.doctor, a.starts_at, c.timezone, c.elder_name, elder.email AS elder_email
    FROM appointments a JOIN circles c ON c.id = a.circle_id
    JOIN members elder ON elder.circle_id = a.circle_id AND elder.role = 'Elder' AND elder.email <> ''
    WHERE a.starts_at >= ? AND a.starts_at <= ?
    ORDER BY a.id
  `).all(nowIso, new Date(nowMs + 24.5 * 60 * 60_000).toISOString()) as {
    id: number; circle_id: number; doctor: string; starts_at: string; timezone: string;
    elder_name: string; elder_email: string;
  }[];
  for (const appointment of appointmentRows) {
    const lead = Date.parse(appointment.starts_at) - nowMs;
    if (lead <= 0 || (lead > 24 * 60 * 60_000 && lead > 2 * 60 * 60_000)) continue;
    const bucket = lead <= 2 * 60 * 60_000 ? "2h" : "24h";
    if (Math.abs(lead - (bucket === "2h" ? 2 * 60 * 60_000 : 24 * 60 * 60_000)) > 30 * 60_000) continue;
    if (makeOutbox(appointment.circle_id, "appointment", appointment.elder_email, `A note before your visit with ${appointment.doctor}`, `Hello ${appointment.elder_name}, a gentle reminder that your appointment with ${appointment.doctor} is ${bucket === "2h" ? "in about two hours" : "tomorrow"}.`, `appointment:${appointment.id}:${bucket}:${appointment.elder_email}`)) created++;
  }
  const circles = db.prepare("SELECT id, timezone FROM circles").all() as { id: number; timezone: string }[];
  for (const circle of circles) {
    const circleNow = DateTime.fromJSDate(now, { zone: "utc" }).setZone(circle.timezone);
    if (circleNow.weekday === 7 && circleNow.hour >= 18) {
      const letter = await createWeeklyLetter(circle.id, now);
      if (letter.created) created++;
    }
  }
  return { created, sent: await deliverPendingEmails() };
}

export function startScheduler() {
  const timer = setInterval(() => { void runSchedulerTick().catch(() => console.error("Dhaaga scheduler tick failed.")); }, 30_000);
  return () => clearInterval(timer);
}
