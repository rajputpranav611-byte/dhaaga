import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DHAAGA_DB = ":memory:";
process.env.NODE_ENV = "test";
process.env.DEMO_MODE = "true";
process.env.SESSION_SECRET = "test-only-session-secret";
process.env.RESEND_API_KEY = "";

let db: (typeof import("../server/db"))["db"];
let security: typeof import("../server/security");
let domain: typeof import("../server/domain");
let schemas: typeof import("../server/schemas");
let scheduler: typeof import("../server/scheduler");
let server: ReturnType<typeof import("node:http").createServer> | undefined;
let baseUrl = "";
let circleId = 0;
let medicationId = 0;

beforeAll(async () => {
  db = (await import("../server/db")).db;
  security = await import("../server/security");
  domain = await import("../server/domain");
  schemas = await import("../server/schemas");
  scheduler = await import("../server/scheduler");
  const { app } = await import("../server/index");
  const circle = db.prepare("INSERT INTO circles(slug, name, elder_name, timezone) VALUES (?, ?, ?, ?)")
    .run("test-circle", "Test Circle", "Asha", "Asia/Kolkata");
  circleId = Number(circle.lastInsertRowid);
  for (const [role, passcode] of [["Elder", "111111"], ["Caretaker", "222222"], ["Family", "333333"]] as const) {
    const { hash, salt } = security.hashPasscode(passcode);
    db.prepare("INSERT INTO circle_codes(circle_id, role, scrypt_hash, salt) VALUES (?, ?, ?, ?)").run(circleId, role, hash, salt);
  }
  db.prepare("INSERT INTO members(circle_id, name, email, role) VALUES (?, ?, ?, ?)").run(circleId, "Asha", "asha@example.test", "Elder");
  db.prepare("INSERT INTO members(circle_id, name, email, role) VALUES (?, ?, ?, ?), (?, ?, ?, ?)")
    .run(circleId, "Nila", "nila@example.test", "Caretaker", circleId, "Kabir", "kabir@example.test", "Family");
  const medication = db.prepare("INSERT INTO medications(circle_id, name, dose, times, days) VALUES (?, ?, ?, ?, ?)")
    .run(circleId, "Amlodipine", "1 tablet", '["8:00 AM"]', '["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]');
  medicationId = Number(medication.lastInsertRowid);
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test HTTP server did not start.");
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

afterAll(async () => {
  scheduler?.resetDemoClockOffset();
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  db?.close();
});

async function signIn(role: "Elder" | "Caretaker" | "Family", name: string) {
  const passcode = role === "Elder" ? "111111" : role === "Caretaker" ? "222222" : "333333";
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
    body: JSON.stringify({ circle: "TEST-CIRCLE", passcode, role, name, email: `${name.toLowerCase()}@example.test` }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Login did not return a session cookie.");
  return cookie;
}

describe("Dhaaga core flows", () => {
  it("verifies salted passcodes and locks a circle after repeated failures", () => {
    const { salt, hash } = security.hashPasscode("654321");
    expect(security.verifyPasscode("654321", salt, hash)).toBe(true);
    expect(security.verifyPasscode("654322", salt, hash)).toBe(false);
    const now = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) security.recordLoginFailure("test-ip", "test-lockout", now + attempt);
    expect(security.loginLocked("test-ip", "test-lockout", now + 5)).toBe(true);
    expect(security.loginLocked("test-ip", "test-lockout", now + 16 * 60_000)).toBe(false);
  });

  it("enforces the role matrix and dose status transitions", () => {
    expect(domain.canRolePerform("Elder", "approve")).toBe(true);
    expect(domain.canRolePerform("Caretaker", "manage_medicine")).toBe(true);
    expect(domain.canRolePerform("Family", "view")).toBe(true);
    expect(domain.canRolePerform("Family", "manage_medicine")).toBe(false);
    expect(domain.canRolePerform("Caretaker", "approve")).toBe(false);
    expect(domain.transitionDose("pending", "taken", 10_000, 11_000)).toBe("late");
    expect(domain.transitionDose("pending", "taken", 11_000, 10_000)).toBe("taken");
    expect(domain.transitionDose("taken", "skipped", 10_000, 11_000)).toBeNull();
    expect(domain.transitionDose("missed", "taken", 10_000, 11_000)).toBe("late");
  });

  it("validates schedule and appointment payloads and finds curated interactions", () => {
    const medication = { name: "Vitamin D", dose: "1 capsule", instructions: "", schedule: ["8:00 PM"], days: ["Mon"] };
    expect(schemas.medicationSchema.safeParse(medication).success).toBe(true);
    expect(schemas.medicationSchema.safeParse({ ...medication, schedule: ["25:90"] }).success).toBe(false);
    expect(schemas.appointmentSchema.safeParse({ doctor: "Dr. Shah", specialty: "", place: "", notes: "", starts_at: new Date(Date.now() + 60_000).toISOString() }).success).toBe(true);
    const warning = domain.findInteractionWarnings("Aspirin", ["warfarin 2mg"]);
    expect(warning[0]?.note).toContain("Ask your doctor or pharmacist.");
    expect(domain.findInteractionWarnings("amoxicillin", ["warfarin"])).toHaveLength(0);
    expect(domain.findInteractionWarnings("Diclofenac", ["ibuprofen"])).toHaveLength(1);
    expect(domain.findInteractionWarnings("Sildenafil", ["nitroglycerin"])).toHaveLength(1);
    expect(domain.findInteractionWarnings("Spironolactone", ["lisinopril"])).toHaveLength(1);
    expect(domain.findInteractionWarnings("Paracetamol", ["acetaminophen"])).toHaveLength(1);
  });

  it("serves a database-backed doctor brief to Family and leaves empty periods explicit", async () => {
    const familyCookie = await signIn("Family", "Kabir");
    const response = await fetch(`${baseUrl}/brief`, { headers: { Cookie: familyCookie } });
    expect(response.status).toBe(200);
    const brief = await response.json() as { medications: { name: string }[]; adherence: { sevenDays: { percentage: number | null; total: number } }; missedOrLate: unknown[]; moodTrend: unknown[]; questions: string[] };
    expect(brief.medications.map((medication) => medication.name)).toContain("Amlodipine");
    expect(brief.adherence.sevenDays).toMatchObject({ percentage: null, total: 0 });
    expect(brief.missedOrLate).toEqual([]);
    expect(brief.moodTrend).toEqual([]);
    expect(brief.questions).toEqual([]);
  });

  it("lets a Caretaker save doctor questions but rejects Family writes", async () => {
    const familyCookie = await signIn("Family", "Kabir");
    const denied = await fetch(`${baseUrl}/brief/questions`, {
      method: "PUT",
      headers: { Cookie: familyCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ questions: ["What should we watch for?"] }),
    });
    expect(denied.status).toBe(403);

    const caretakerCookie = await signIn("Caretaker", "Nila");
    const saved = await fetch(`${baseUrl}/brief/questions`, {
      method: "PUT",
      headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ questions: ["What should we watch for?", "When should we call?"] }),
    });
    expect(saved.status).toBe(200);
    const readBack = await fetch(`${baseUrl}/brief`, { headers: { Cookie: familyCookie } });
    expect((await readBack.json()).questions).toEqual(["What should we watch for?", "When should we call?"]);
  });

  it("deduplicates dose reminders and creates the escalation follow-ups using a fake clock", async () => {
    const scheduledAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const doseId = Number(db.prepare("INSERT INTO dose_events(circle_id, medication_id, scheduled_at) VALUES (?, ?, ?)").run(circleId, medicationId, scheduledAt).lastInsertRowid);
    const now = new Date(Date.parse(scheduledAt) - 5 * 60_000);
    const first = await scheduler.runSchedulerTick(() => now);
    const second = await scheduler.runSchedulerTick(() => now);
    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key = ?").get(`dose-upcoming:${doseId}`)).toMatchObject({ count: 1 });

    const overdueAt = new Date(Date.now() - 21 * 60_000).toISOString();
    db.prepare("INSERT INTO dose_events(circle_id, medication_id, scheduled_at) VALUES (?, ?, ?)").run(circleId, medicationId, overdueAt);
    await scheduler.runSchedulerTick(() => new Date(Date.parse(overdueAt) + 47 * 60_000));
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind = 'caregiver-followup'").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind = 'family-followup'").get()).toMatchObject({ count: 1 });
    await scheduler.runSchedulerTick(() => new Date(Date.parse(overdueAt) + 48 * 60_000));
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind = 'family-followup'").get()).toMatchObject({ count: 1 });
  });

  it("routes family changes through elder approval and blocks restricted writes", async () => {
    const familyCookie = await signIn("Family", "Kabir");
    const restricted = await fetch(`${baseUrl}/medications`, {
      method: "POST",
      headers: { Cookie: familyCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ name: "New tablet", dose: "1 tablet", instructions: "", schedule: ["8:00 AM"], days: ["Mon"] }),
    });
    expect(restricted.status).toBe(403);
    const proposed = await fetch(`${baseUrl}/appointments`, {
      method: "POST",
      headers: { Cookie: familyCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ doctor: "Dr. Shah", specialty: "Cardiology", place: "Lotus Clinic", notes: "", starts_at: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString() }),
    });
    expect(proposed.status).toBe(202);
    expect(db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE circle_id = ? AND doctor = 'Dr. Shah'").get(circleId)).toMatchObject({ count: 0 });

    const elderCookie = await signIn("Elder", "Asha");
    const pending = db.prepare("SELECT id FROM proposals WHERE circle_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(circleId) as { id: number };
    const approved = await fetch(`${baseUrl}/proposals/${pending.id}`, {
      method: "PATCH",
      headers: { Cookie: elderCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(approved.status).toBe(200);
    expect(db.prepare("SELECT status FROM proposals WHERE id = ?").get(pending.id)).toMatchObject({ status: "approved" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE circle_id = ? AND doctor = 'Dr. Shah'").get(circleId)).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE circle_id = ?").get(circleId)).toMatchObject({ count: 3 });
  });
});
