import "dotenv/config";
import { db } from "./db";
import { hashPasscode } from "./security";
import { DateTime } from "luxon";

const circleId = db.prepare("SELECT id FROM circles WHERE slug = 'tulsi-4821'").get() as { id: number } | undefined;
let id = circleId?.id;
if (!id) {
  const result = db.prepare("INSERT INTO circles(slug, name, elder_name, timezone, language) VALUES (?, ?, ?, ?, ?)")
    .run("tulsi-4821", "Tulsi Circle", "Amma", "Asia/Kolkata", "en");
  id = Number(result.lastInsertRowid);
}
const codes = [["Elder", "111111"], ["Caretaker", "222222"], ["Family", "333333"]] as const;
const upsertCode = db.prepare("INSERT INTO circle_codes(circle_id, role, scrypt_hash, salt) VALUES (?, ?, ?, ?) ON CONFLICT(circle_id, role) DO NOTHING");
for (const [role, passcode] of codes) {
  const { salt, hash } = hashPasscode(passcode);
  upsertCode.run(id, role, hash, salt);
}
const upsertMember = db.prepare("INSERT INTO members(circle_id, name, email, role) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE circle_id = ? AND role = ?)");
upsertMember.run(id, "Amma", process.env.DEMO_ELDER_EMAIL ?? "amma@dhaaga.example", "Elder", id, "Elder");
upsertMember.run(id, "Maya", process.env.DEMO_CARETAKER_EMAIL ?? "maya@dhaaga.example", "Caretaker", id, "Caretaker");
upsertMember.run(id, "Ravi", process.env.DEMO_FAMILY_EMAIL ?? "ravi@dhaaga.example", "Family", id, "Family");

const medCount = db.prepare("SELECT COUNT(*) AS count FROM medications WHERE circle_id = ?").get(id) as { count: number };
if (medCount.count === 0) {
  const medication = db.prepare("INSERT INTO medications(circle_id, name, dose, instructions, times, days) VALUES (?, ?, ?, ?, ?, ?)");
  const meds = [
    { name: "Amlodipine", dose: "1 tablet · 5 mg", instructions: "After breakfast", times: ["8:00 AM"] },
    { name: "Metformin", dose: "1 tablet · 500 mg", instructions: "With lunch", times: ["1:30 PM"] },
    { name: "Vitamin D", dose: "1 capsule", instructions: "After dinner", times: ["8:00 PM"] },
  ];
  for (const med of meds) {
    const result = medication.run(id, med.name, med.dose, med.instructions, JSON.stringify(med.times), JSON.stringify(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]));
    db.prepare("INSERT INTO schedules(medication_id, times, days) VALUES (?, ?, ?)").run(result.lastInsertRowid, JSON.stringify(med.times), JSON.stringify(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]));
  }
}
const appointmentCount = db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE circle_id = ?").get(id) as { count: number };
if (!appointmentCount.count) {
  const visit = DateTime.now().setZone("Asia/Kolkata").plus({ days: 3 }).set({ hour: 10, minute: 30, second: 0, millisecond: 0 }).toUTC().toISO()!;
  db.prepare("INSERT INTO appointments(circle_id, doctor, specialty, place, notes, starts_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, "Dr. Meera Shah", "Cardiology", "Lotus Clinic", "Bring the last blood pressure readings.", visit);
}
const eventCount = db.prepare("SELECT COUNT(*) AS count FROM dose_events WHERE circle_id = ?").get(id) as { count: number };
if (!eventCount.count) {
  const meds = db.prepare("SELECT id, times FROM medications WHERE circle_id = ?").all(id) as { id: number; times: string }[];
  const insertDose = db.prepare("INSERT OR IGNORE INTO dose_events(circle_id, medication_id, scheduled_at, status, taken_at) VALUES (?, ?, ?, ?, ?)");
  for (let day = 6; day >= 0; day--) {
    for (const med of meds) {
      for (const time of JSON.parse(med.times) as string[]) {
        const [rawHour, minute, meridiem] = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)?.slice(1) ?? [];
        const hour = Number(rawHour) % 12 + (meridiem?.toUpperCase() === "PM" ? 12 : 0);
        const scheduled = DateTime.now().setZone("Asia/Kolkata").minus({ days: day }).set({ hour, minute: Number(minute), second: 0, millisecond: 0 });
        const isToday = day === 0;
        const missed = day === 2 && med.id === meds[1]?.id;
        const status = missed ? "missed" : isToday && scheduled.toMillis() > Date.now() ? "pending" : "taken";
        const takenAt = status === "taken" ? scheduled.plus({ minutes: 3 }).toUTC().toISO() : null;
        insertDose.run(id, med.id, scheduled.toUTC().toISO(), status, takenAt);
      }
    }
  }
}
