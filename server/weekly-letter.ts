import { DateTime } from "luxon";
import { z } from "zod";
import { db } from "./db";

const numberWords = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth",
]);

export interface WeeklyLetterData {
  elderName: string;
  timezone: string;
  weekKey: string;
  weekLabel: string;
  previousWeekLabel: string;
  thisWeek: { percentage: number | null; completed: number; total: number };
  lastWeek: { percentage: number | null; completed: number; total: number };
  moodThisWeek: { average: number | null; checkins: number };
  moodLastWeek: { average: number | null; checkins: number };
  missedDoses: { medication: string; scheduledAt: string }[];
  upcomingAppointments: { doctor: string; specialty: string; startsAt: string; place: string }[];
  suggestion: string;
}

function doseAdherence(circleId: number, start: DateTime, end: DateTime) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status IN ('taken','late') THEN 1 ELSE 0 END) AS completed
    FROM dose_events WHERE circle_id = ? AND scheduled_at >= ? AND scheduled_at <= ?
  `).get(circleId, start.toUTC().toISO(), end.toUTC().toISO()) as { total: number; completed: number | null };
  return {
    percentage: row.total ? Math.round((Number(row.completed ?? 0) / row.total) * 100) : null,
    completed: Number(row.completed ?? 0),
    total: row.total,
  };
}

function moodSummary(circleId: number, start: DateTime, end: DateTime) {
  const row = db.prepare(`
    SELECT ROUND(AVG(mood), 1) AS average, COUNT(*) AS checkins
    FROM checkins WHERE circle_id = ? AND date >= ? AND date <= ?
  `).get(circleId, start.toFormat("yyyy-LL-dd"), end.toFormat("yyyy-LL-dd")) as { average: number | null; checkins: number };
  return { average: row.average === null ? null : Number(row.average), checkins: row.checkins };
}

export function collectWeeklyLetterData(circleId: number, now = new Date()): WeeklyLetterData {
  const circle = db.prepare("SELECT elder_name, timezone FROM circles WHERE id = ?").get(circleId) as { elder_name: string; timezone: string } | undefined;
  if (!circle) throw new Error("Cannot prepare a letter for an unknown circle.");
  const localNow = DateTime.fromJSDate(now, { zone: "utc" }).setZone(circle.timezone);
  const weekStart = localNow.startOf("week");
  const lastWeekStart = weekStart.minus({ weeks: 1 });
  const previousWeekEnd = weekStart.minus({ milliseconds: 1 });
  const missedDoses = db.prepare(`
    SELECT m.name AS medication, d.scheduled_at AS scheduledAt
    FROM dose_events d JOIN medications m ON m.id = d.medication_id
    WHERE d.circle_id = ? AND d.status = 'missed' AND d.scheduled_at >= ? AND d.scheduled_at <= ?
    ORDER BY d.scheduled_at
  `).all(circleId, weekStart.toUTC().toISO(), localNow.toUTC().toISO()) as WeeklyLetterData["missedDoses"];
  const upcomingAppointments = db.prepare(`
    SELECT doctor, specialty, starts_at AS startsAt, place
    FROM appointments
    WHERE circle_id = ? AND starts_at >= ? AND starts_at <= ?
    ORDER BY starts_at LIMIT 10
  `).all(circleId, localNow.toUTC().toISO(), localNow.plus({ days: 14 }).toUTC().toISO()) as WeeklyLetterData["upcomingAppointments"];
  const hasMissedDoses = missedDoses.length > 0;
  const suggestion = upcomingAppointments.length
    ? "If it feels useful, you could gather any questions the circle would like to bring to the upcoming visit."
    : hasMissedDoses
      ? "A gentle family-and-caretaker check-in may help you understand what would make the daily routine easier."
      : "A small check-in between family and caretaker can help everyone feel included in the week.";
  return {
    elderName: circle.elder_name,
    timezone: circle.timezone,
    weekKey: localNow.toFormat("kkkk-'W'WW"),
    weekLabel: `${weekStart.toFormat("d LLL")}–${localNow.toFormat("d LLL yyyy")}`,
    previousWeekLabel: `${lastWeekStart.toFormat("d LLL")}–${previousWeekEnd.toFormat("d LLL yyyy")}`,
    thisWeek: doseAdherence(circleId, weekStart, localNow),
    lastWeek: doseAdherence(circleId, lastWeekStart, previousWeekEnd),
    moodThisWeek: moodSummary(circleId, weekStart, localNow),
    moodLastWeek: moodSummary(circleId, lastWeekStart, previousWeekEnd),
    missedDoses,
    upcomingAppointments,
    suggestion,
  };
}

function adherenceCopy(value: WeeklyLetterData["thisWeek"], label: string) {
  return value.percentage === null
    ? `No doses were scheduled in ${label}`
    : `${value.percentage}% (${value.completed} of ${value.total} scheduled doses)`;
}

function moodCopy(value: WeeklyLetterData["moodThisWeek"]) {
  return value.average === null
    ? "No mood check-ins were recorded."
    : `The average check-in was ${value.average} out of 5 across ${value.checkins} ${value.checkins === 1 ? "entry" : "entries"}.`;
}

function dateCopy(value: string, timezone: string) {
  return DateTime.fromISO(value, { zone: "utc" }).setZone(timezone).toFormat("ccc, d LLL");
}

export function renderWeeklyLetter(data: WeeklyLetterData) {
  const missedCopy = data.missedDoses.length
    ? data.missedDoses.map((dose) => `${dose.medication} (${dateCopy(dose.scheduledAt, data.timezone)})`).join("; ")
    : "No missed doses were recorded this week.";
  const appointmentsCopy = data.upcomingAppointments.length
    ? data.upcomingAppointments.map((appointment) => `${appointment.doctor}${appointment.specialty ? `, ${appointment.specialty}` : ""} on ${dateCopy(appointment.startsAt, data.timezone)}${appointment.place ? ` at ${appointment.place}` : ""}`).join("; ")
    : "No upcoming appointments are listed for the next two weeks.";
  return [
    `Hello family,`,
    ``,
    `Here is a small picture of ${data.elderName}’s week (${data.weekLabel}).`,
    `Medicine adherence this week: ${adherenceCopy(data.thisWeek, "this week")}.`,
    `Last week (${data.previousWeekLabel}): ${adherenceCopy(data.lastWeek, "last week")}.`,
    `Mood this week: ${moodCopy(data.moodThisWeek)}`,
    `Mood last week: ${moodCopy(data.moodLastWeek)}`,
    `Missed doses: ${missedCopy}`,
    `Coming up: ${appointmentsCopy}`,
    ``,
    `A gentle suggestion: ${data.suggestion}`,
    ``,
    `With care,`,
    `Your Dhaaga circle`,
  ].join("\n");
}

export function containsOnlyProvidedNumbers(candidate: string, source: string) {
  const facts = (value: string) => {
    const digits = value.match(/\d+(?:\.\d+)?%?/g) ?? [];
    const words = (value.toLowerCase().match(/\b[a-z]+\b/g) ?? []).filter((word) => numberWords.has(word));
    return [...digits, ...words];
  };
  const provided = new Set(facts(source));
  return facts(candidate).every((fact) => provided.has(fact));
}

export function validatePolishedWeeklyLetter(candidate: string, data: WeeklyLetterData, template: string) {
  const parsed = z.string().trim().min(1).max(5000).safeParse(candidate);
  if (!parsed.success || !containsOnlyProvidedNumbers(parsed.data, `${JSON.stringify(data)}\n${template}`)) {
    return { body: template, polished: false };
  }
  return { body: parsed.data, polished: true };
}

export async function prepareWeeklyLetter(circleId: number, now = new Date(), polish = true) {
  const data = collectWeeklyLetterData(circleId, now);
  const subject = `A small note from ${data.elderName}’s week`;
  const template = renderWeeklyLetter(data);
  const key = process.env.GEMINI_API_KEY;
  if (!polish || !key) return { data, subject, body: template, polished: false };
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: key });
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      contents: `Gently polish the wording of this family letter. Do not add, remove, or change facts. Do not introduce any number unless it appears in the supplied source. Return only the revised letter body.\nSOURCE DATA: ${JSON.stringify(data)}\nTEMPLATE:\n${template}`,
    });
    return { data, subject, ...validatePolishedWeeklyLetter(response.text ?? "", data, template) };
  } catch {
    return { data, subject, body: template, polished: false };
  }
  return { data, subject, body: template, polished: false };
}

export async function createWeeklyLetter(circleId: number, now = new Date()) {
  const prepared = await prepareWeeklyLetter(circleId, now);
  const recipients = db.prepare(`
    SELECT email FROM members WHERE circle_id = ? AND role = 'Family' AND email <> '' ORDER BY email
  `).all(circleId) as { email: string }[];
  if (!recipients.length) return { ...prepared, created: false, recipientCount: 0 };
  const result = db.prepare(`
    INSERT OR IGNORE INTO outbox(circle_id, kind, to_email, subject, body, dedupe_key)
    VALUES (?, 'sunday-letter', ?, ?, ?, ?)
  `).run(circleId, recipients.map((person) => person.email).join(", "), prepared.subject, prepared.body, `sunday-letter:${circleId}:${prepared.data.weekKey}`);
  return { ...prepared, created: result.changes === 1, recipientCount: recipients.length };
}
