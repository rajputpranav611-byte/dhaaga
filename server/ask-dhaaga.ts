import { DateTime } from "luxon";
import type { z } from "zod";
import { askDhaagaCandidateSchema, appointmentSchema, medicationSchema } from "./schemas";

type Candidate = z.infer<typeof askDhaagaCandidateSchema>;

function timesIn(command: string) {
  const times = new Set<string>();
  const expression = /\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/gi;
  for (const match of command.matchAll(expression)) {
    const hour = Number(match[1]);
    if (hour < 1 || hour > 12) continue;
    const suffix = match[3].replace(/\./g, "").toLowerCase();
    times.add(`${hour}:${match[2] ?? "00"} ${suffix === "am" ? "AM" : "PM"}`);
  }
  if (!times.size) {
    if (/\bmorning\b/i.test(command)) times.add("8:00 AM");
    if (/\bevening\b/i.test(command)) times.add("6:00 PM");
    if (/\bnight\b/i.test(command)) times.add("8:00 PM");
  }
  return [...times].slice(0, 8);
}

function medicineDays(command: string) {
  if (/\b(?:every\s+day|daily|each\s+day)\b/i.test(command)) return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekdays = [
    ["Mon", /\bmon(?:day)?\b/i], ["Tue", /\btue(?:sday)?\b/i], ["Wed", /\bwed(?:nesday)?\b/i],
    ["Thu", /\bthu(?:rsday)?\b/i], ["Fri", /\bfri(?:day)?\b/i], ["Sat", /\bsat(?:urday)?\b/i], ["Sun", /\bsun(?:day)?\b/i],
  ] as const;
  return weekdays.filter(([, pattern]) => pattern.test(command)).map(([day]) => day);
}

function appointmentStart(command: string, timezone: string, now: Date) {
  const time = command.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!time) return "";
  const hour = Number(time[1]);
  if (hour < 1 || hour > 12) return "";
  const suffix = time[3].replace(/\./g, "").toLowerCase();
  const hour24 = (hour % 12) + (suffix === "pm" ? 12 : 0);
  const minute = Number(time[2] ?? "0");
  const localNow = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  let date: DateTime | null = null;
  if (/\btomorrow\b/i.test(command)) date = localNow.plus({ days: 1 }).startOf("day");
  else if (/\btoday\b/i.test(command)) date = localNow.startOf("day");
  else {
    const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const requestedWeekday = weekdayNames.findIndex((day) => new RegExp(`\\b${day}\\b`, "i").test(command));
    if (requestedWeekday >= 0) {
      date = localNow.startOf("week").plus({ days: requestedWeekday });
      if (date <= localNow) date = date.plus({ weeks: 1 });
    } else {
      const numericDate = command.match(/\b(\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?)\b/);
      if (numericDate) {
        const formats = ["d MMM yyyy", "d LLL yyyy", "d MMMM yyyy", "d MMM", "d LLL", "d MMMM"];
        for (const format of formats) {
          const parsed = DateTime.fromFormat(numericDate[1], format, { zone: timezone });
          if (!parsed.isValid) continue;
          date = format.includes("yyyy") ? parsed : parsed.set({ year: localNow.year });
          if (date <= localNow) date = date.plus({ years: 1 });
          break;
        }
      }
    }
  }
  if (!date) return "";
  const startsAt = date.set({ hour: hour24, minute, second: 0, millisecond: 0 });
  return startsAt > localNow ? startsAt.toUTC().toISO() ?? "" : "";
}

function ruleBasedCandidate(command: string, timezone: string, now: Date): Candidate {
  const appointmentIntent = /\b(?:appointment|doctor visit|visit with)\b/i.test(command) ||
    /\b(?:book|schedule)\b.*\b(?:with|appointment|doctor)\b/i.test(command);
  const medicineIntent = /\b(?:medicine|medication|tablet|pill|capsule|dose|mg|mcg|ml)\b/i.test(command);
  if (appointmentIntent) {
    const doctorMatch = command.match(/\b(?:with|for)\s+(dr\.?\s+.+?)(?=\s+(?:on|at|tomorrow|today|next)\b|$)/i);
    const appointment = {
      doctor: doctorMatch?.[1].trim() ?? "",
      specialty: "",
      place: "",
      notes: "",
      starts_at: appointmentStart(command, timezone, now),
    };
    return askDhaagaCandidateSchema.parse({
      intent: "appointment",
      confident: appointmentSchema.safeParse(appointment).success,
      medicine: {},
      appointment,
    });
  }
  if (medicineIntent) {
    const dose = command.match(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|tablets?|capsules?|pills?|puffs?)\b/i)?.[0] ?? "";
    const name = command
      .replace(/^\s*(?:please\s+)?(?:add|start|schedule|set up)\s+/i, "")
      .replace(/^(?:my|papa'?s|mum'?s|mom'?s|dad'?s|amma'?s|grandma'?s)\s+/i, "")
      .replace(/\b(?:every\s+day|daily|each\s+day|morning|evening|night)\b/gi, "")
      .replace(/\b(?:at\s*)?\d{1,2}(?::[0-5]\d)?\s*a\.?m\.?|\b(?:at\s*)?\d{1,2}(?::[0-5]\d)?\s*p\.?m\.?/gi, "")
      .replace(dose ? new RegExp(dose.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : /$^/, "")
      .replace(/\b(?:medicine|medication)\s+(?:called|named)\s+/gi, "")
      .replace(/^[\s'’]+|[\s'’]+$/g, "")
      .replace(/\s+/g, " ")
      .replace(/^(?:of|for)\s+/i, "")
      .trim();
    const medicine = {
      name,
      dose,
      instructions: "",
      schedule: timesIn(command),
      days: medicineDays(command),
    };
    return askDhaagaCandidateSchema.parse({
      intent: "medicine",
      confident: medicationSchema.safeParse(medicine).success,
      medicine,
      appointment: {},
    });
  }
  return askDhaagaCandidateSchema.parse({ intent: "unknown", confident: false, medicine: {}, appointment: {} });
}

const geminiOutputSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["medicine", "appointment", "unknown"] },
    confident: { type: "boolean" },
    medicine: {
      type: "object",
      properties: {
        name: { type: "string" }, dose: { type: "string" }, instructions: { type: "string" },
        schedule: { type: "array", items: { type: "string" } },
        days: { type: "array", items: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] } },
      },
      required: ["name", "dose", "instructions", "schedule", "days"],
      additionalProperties: false,
    },
    appointment: {
      type: "object",
      properties: {
        doctor: { type: "string" }, specialty: { type: "string" }, place: { type: "string" },
        notes: { type: "string" }, starts_at: { type: "string" },
      },
      required: ["doctor", "specialty", "place", "notes", "starts_at"],
      additionalProperties: false,
    },
  },
  required: ["intent", "confident", "medicine", "appointment"],
  additionalProperties: false,
};

export async function parseAskDhaagaCommand(command: string, timezone: string, now = new Date()): Promise<Candidate> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return ruleBasedCandidate(command, timezone, now);
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    contents: `Parse this healthcare command into exactly the supplied JSON shape. Do not invent missing facts. Set confident to false and leave unknown fields empty when required details are absent or unclear. Medicine requests need a name, dose, at least one 12-hour schedule time, and days. Appointment requests need a doctor and a future date and time. Convert appointment dates relative to this local time and timezone: ${DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone).toISO()} (${timezone}). Use empty strings and arrays for unknowns. COMMAND: ${command}`,
    config: { responseMimeType: "application/json", responseJsonSchema: geminiOutputSchema },
  });
  const text = response.text?.replace(/```(?:json)?|```/g, "").trim() ?? "";
  let output: unknown;
  try { output = JSON.parse(text); } catch { throw new Error("The command could not be parsed as structured data."); }
  const parsed = askDhaagaCandidateSchema.safeParse(output);
  if (!parsed.success) throw new Error("The command parser returned details in an unexpected format.");
  return parsed.data;
}
