import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DHAAGA_DB = ":memory:";
process.env.NODE_ENV = "test";
process.env.DEMO_MODE = "true";
process.env.SESSION_SECRET = "test-only-session-secret";
process.env.RESEND_API_KEY = "";
process.env.GEMINI_API_KEY = "";

let db: (typeof import("../server/db"))["db"];
let security: typeof import("../server/security");
let domain: typeof import("../server/domain");
let schemas: typeof import("../server/schemas");
let scheduler: typeof import("../server/scheduler");
let weeklyLetter: typeof import("../server/weekly-letter");
let askDhaaga: typeof import("../server/ask-dhaaga");
let weekBraid: typeof import("../server/week-braid");
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
  weeklyLetter = await import("../server/weekly-letter");
  askDhaaga = await import("../server/ask-dhaaga");
  weekBraid = await import("../server/week-braid");
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

  it("previews a deterministic weekly letter and restricts manual sending to Elder and Caretaker", async () => {
    const familyCookie = await signIn("Family", "Kabir");
    const preview = await fetch(`${baseUrl}/letter/preview`, { headers: { Cookie: familyCookie } });
    expect(preview.status).toBe(200);
    expect((await preview.json()).body).toContain("Medicine adherence this week:");

    const denied = await fetch(`${baseUrl}/letter/send-now`, {
      method: "POST",
      headers: { Cookie: familyCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: "{}",
    });
    expect(denied.status).toBe(403);

    const caretakerCookie = await signIn("Caretaker", "Nila");
    const sent = await fetch(`${baseUrl}/letter/send-now`, {
      method: "POST",
      headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: "{}",
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ created: true, recipientCount: 1, sentAt: null });
  });

  it("deduplicates weekly letters by ISO week and rejects newly introduced number facts", async () => {
    const fixedDate = new Date("2025-01-08T12:00:00.000Z");
    const first = await weeklyLetter.createWeeklyLetter(circleId, fixedDate);
    const second = await weeklyLetter.createWeeklyLetter(circleId, fixedDate);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.data.weekKey).toBe("2025-W02");
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key = ?")
      .get(`sunday-letter:${circleId}:2025-W02`)).toMatchObject({ count: 1 });
    expect(weeklyLetter.containsOnlyProvidedNumbers("Adherence reached 100%.", "Adherence reached 80%.")).toBe(false);
    expect(weeklyLetter.containsOnlyProvidedNumbers("Adherence reached 80%.", "Adherence reached 80%.")).toBe(true);
  });

  it("creates the weekly letter after 18:00 in the circle's timezone on Sunday", async () => {
    const sundayEvening = new Date("2025-01-05T12:30:00.000Z");
    const result = await scheduler.runSchedulerTick(() => sundayEvening);
    expect(result.created).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key = ?")
      .get(`sunday-letter:${circleId}:2025-W01`)).toMatchObject({ count: 1 });
  });

  it("parses Ask Dhaaga commands conservatively and validates structured results", async () => {
    const incomplete = await askDhaaga.parseAskDhaagaCommand("add Papa's evening BP tablet at 8pm", "Asia/Kolkata");
    expect(incomplete).toMatchObject({ intent: "medicine", confident: false, medicine: { name: "BP tablet", schedule: ["8:00 PM"], dose: "", days: [] } });
    const complete = await askDhaaga.parseAskDhaagaCommand("add aspirin 1 tablet at 8pm every day", "Asia/Kolkata");
    expect(complete).toMatchObject({ intent: "medicine", confident: true, medicine: { name: "aspirin", dose: "1 tablet", schedule: ["8:00 PM"], days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] } });
    expect(schemas.askDhaagaCandidateSchema.safeParse(complete).success).toBe(true);
    expect(schemas.askDhaagaCandidateSchema.safeParse({ ...complete, intent: "medicine", medicine: { ...complete.medicine, days: ["Funday"] } }).success).toBe(false);
    const appointment = await askDhaaga.parseAskDhaagaCommand("book an appointment with Dr. Shah tomorrow at 3pm", "Asia/Kolkata");
    expect(appointment).toMatchObject({ intent: "appointment", confident: true, appointment: { doctor: "Dr. Shah" } });
  });

  it("keeps Ask Dhaaga output as proposals and checks medicine interactions", async () => {
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const incomplete = await fetch(`${baseUrl}/ask-dhaaga`, {
      method: "POST",
      headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ command: "add Papa's evening BP tablet at 8pm" }),
    });
    expect(await incomplete.json()).toMatchObject({ status: "needs-details", intent: "medicine" });

    const existing = Number(db.prepare("INSERT INTO medications(circle_id, name, dose, times, days) VALUES (?, ?, ?, ?, ?)")
      .run(circleId, "Warfarin", "5 mg", '["8:00 AM"]', '["Mon"]').lastInsertRowid);
    const suggested = await fetch(`${baseUrl}/ask-dhaaga`, {
      method: "POST",
      headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ command: "add aspirin 1 tablet at 8pm every day" }),
    });
    const result = await suggested.json();
    expect(suggested.status).toBe(202);
    expect(result).toMatchObject({ status: "proposal", entity: "medicine", payload: { name: "aspirin" } });
    expect(result.warnings[0].title).toContain("Warfarin");
    expect(db.prepare("SELECT COUNT(*) AS count FROM medications WHERE circle_id = ? AND lower(name) = 'aspirin'").get(circleId)).toMatchObject({ count: 0 });
    db.prepare("DELETE FROM medications WHERE id = ?").run(existing);

    const familyCookie = await signIn("Family", "Kabir");
    const denied = await fetch(`${baseUrl}/ask-dhaaga/proposal`, {
      method: "POST",
      headers: { Cookie: familyCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ entity: "medicine", payload: { name: "Aspirin", dose: "1 tablet", instructions: "", schedule: ["8:00 PM"], days: ["Mon"] } }),
    });
    expect(denied.status).toBe(403);
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
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE circle_id = ?").get(circleId)).toMatchObject({ count: 4 });
  });

  it("escalates at exactly 20 and 45 minutes with a fake clock", async () => {
    const scheduledAt = new Date(Date.now() - 60_000);
    const doseId = Number(db.prepare("INSERT INTO dose_events(circle_id, medication_id, scheduled_at) VALUES (?, ?, ?)")
      .run(circleId, medicationId, scheduledAt.toISOString()).lastInsertRowid);
    const runAt = async (minutes: number) => scheduler.runSchedulerTick(() => new Date(scheduledAt.getTime() + minutes * 60_000));
    await runAt(19);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key LIKE ?").get(`dose-caregiver:${doseId}:%`)).toMatchObject({ count: 0 });
    await runAt(20);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key LIKE ?").get(`dose-caregiver:${doseId}:%`)).toMatchObject({ count: 1 });
    await runAt(44);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key LIKE ?").get(`dose-family:${doseId}:%`)).toMatchObject({ count: 0 });
    await runAt(45);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key LIKE ?").get(`dose-family:${doseId}:%`)).toMatchObject({ count: 1 });
  });

  it("lets the Elder decline a suggestion without applying it", async () => {
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const created = await fetch(`${baseUrl}/medications`, {
      method: "POST",
      headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ name: "Declined medicine", dose: "1 tablet", instructions: "", schedule: ["8:00 AM"], days: ["Mon"] }),
    });
    expect(created.status).toBe(202);
    const proposal = db.prepare("SELECT id FROM proposals WHERE circle_id = ? AND payload LIKE '%Declined medicine%' ORDER BY id DESC LIMIT 1")
      .get(circleId) as { id: number };
    const elderCookie = await signIn("Elder", "Asha");
    const declined = await fetch(`${baseUrl}/proposals/${proposal.id}`, {
      method: "PATCH",
      headers: { Cookie: elderCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ decision: "declined" }),
    });
    expect(declined.status).toBe(200);
    expect(db.prepare("SELECT status FROM proposals WHERE id = ?").get(proposal.id)).toMatchObject({ status: "declined" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM medications WHERE circle_id = ? AND name = 'Declined medicine'").get(circleId)).toMatchObject({ count: 0 });
  });

  it("enforces role guards across restricted mutation routes", async () => {
    const familyCookie = await signIn("Family", "Kabir");
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const guarded: { cookie: string; method: string; path: string; body?: unknown }[] = [
      { cookie: familyCookie, method: "PUT", path: "/brief/questions", body: { questions: [] } },
      { cookie: familyCookie, method: "PATCH", path: "/circle", body: { caretaker_direct_edit: true } },
      { cookie: caretakerCookie, method: "PATCH", path: "/circle", body: { caretaker_direct_edit: true } },
      { cookie: familyCookie, method: "POST", path: "/medications", body: {} },
      { cookie: familyCookie, method: "PATCH", path: `/medications/${medicationId}`, body: {} },
      { cookie: familyCookie, method: "DELETE", path: `/medications/${medicationId}`, body: {} },
      { cookie: familyCookie, method: "PATCH", path: "/doses/99999", body: { status: "taken" } },
      { cookie: familyCookie, method: "PATCH", path: "/proposals/99999", body: { decision: "approved" } },
      { cookie: caretakerCookie, method: "PATCH", path: "/proposals/99999", body: { decision: "approved" } },
      { cookie: familyCookie, method: "POST", path: "/checkins", body: { mood: 4, note: "" } },
      { cookie: caretakerCookie, method: "POST", path: "/checkins", body: { mood: 4, note: "" } },
      { cookie: familyCookie, method: "POST", path: "/letter/send-now", body: {} },
      { cookie: familyCookie, method: "POST", path: "/demo/clock", body: { minutes: 1 } },
      { cookie: caretakerCookie, method: "POST", path: "/demo/clock", body: { minutes: 1 } },
      { cookie: familyCookie, method: "POST", path: "/interactions", body: { name: "Aspirin" } },
      { cookie: familyCookie, method: "POST", path: "/prescription-draft", body: {} },
      { cookie: familyCookie, method: "POST", path: "/ask-dhaaga", body: { command: "add aspirin 1 tablet at 8pm daily" } },
      { cookie: familyCookie, method: "POST", path: "/ask-dhaaga/proposal", body: { entity: "medicine", payload: { name: "Aspirin", dose: "1 tablet", instructions: "", schedule: ["8:00 PM"], days: ["Mon"] } } },
    ];
    for (const route of guarded) {
      const response = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: { Cookie: route.cookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
        body: JSON.stringify(route.body ?? {}),
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
    }
    const familyOutbox = await fetch(`${baseUrl}/outbox`, { headers: { Cookie: familyCookie } });
    expect(familyOutbox.status).toBe(403);
  });

  it("keeps caretaker medicine create, edit, and removal as proposals while Elder changes apply", async () => {
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const body = { name: "Role matrix medicine", dose: "1 tablet", instructions: "", schedule: ["8:00 AM"], days: ["Mon"] };
    expect((await fetch(`${baseUrl}/medications`, { method: "POST", headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" }, body: JSON.stringify(body) })).status).toBe(202);
    expect((await fetch(`${baseUrl}/medications/${medicationId}`, { method: "PATCH", headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" }, body: JSON.stringify(body) })).status).toBe(202);
    expect((await fetch(`${baseUrl}/medications/${medicationId}`, { method: "DELETE", headers: { Cookie: caretakerCookie, "X-Dhaaga-Action": "1" } })).status).toBe(202);
    expect(db.prepare("SELECT COUNT(*) AS count FROM medications WHERE circle_id = ? AND name = 'Role matrix medicine'").get(circleId)).toMatchObject({ count: 0 });

    const elderCookie = await signIn("Elder", "Asha");
    const direct = await fetch(`${baseUrl}/medications`, { method: "POST", headers: { Cookie: elderCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" }, body: JSON.stringify(body) });
    expect(direct.status).toBe(201);
    const { id } = await direct.json() as { id: number };
    expect((await fetch(`${baseUrl}/medications/${id}`, { method: "PATCH", headers: { Cookie: elderCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" }, body: JSON.stringify({ ...body, name: "Updated role matrix medicine" }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/medications/${id}`, { method: "DELETE", headers: { Cookie: elderCookie, "X-Dhaaga-Action": "1" } })).status).toBe(200);
  });

  it("allows Caretaker and Elder dose updates while rejecting Family", async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const firstDose = Number(db.prepare("INSERT INTO dose_events(circle_id, medication_id, scheduled_at) VALUES (?, ?, ?)")
      .run(circleId, medicationId, scheduledAt).lastInsertRowid);
    const secondDose = Number(db.prepare("INSERT INTO dose_events(circle_id, medication_id, scheduled_at) VALUES (?, ?, ?)")
      .run(circleId, medicationId, new Date(Date.parse(scheduledAt) + 60 * 60_000).toISOString()).lastInsertRowid);
    const familyCookie = await signIn("Family", "Kabir");
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const elderCookie = await signIn("Elder", "Asha");
    const update = (cookie: string, id: number, status: "taken" | "skipped") => fetch(`${baseUrl}/doses/${id}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ status }),
    });
    expect((await update(familyCookie, firstDose, "taken")).status).toBe(403);
    expect((await update(caretakerCookie, firstDose, "taken")).status).toBe(200);
    expect((await update(elderCookie, secondDose, "skipped")).status).toBe(200);
    expect(db.prepare("SELECT status FROM dose_events WHERE id = ?").get(firstDose)).toMatchObject({ status: "taken" });
    expect(db.prepare("SELECT status FROM dose_events WHERE id = ?").get(secondDose)).toMatchObject({ status: "skipped" });
  });

  it("allows all roles to propose appointments while only Elder edits apply", async () => {
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const familyCookie = await signIn("Family", "Kabir");
    const elderCookie = await signIn("Elder", "Asha");
    const appointment = { doctor: "Dr. Matrix", specialty: "General", place: "Clinic", notes: "", starts_at: new Date(Date.now() + 86_400_000).toISOString() };
    expect((await fetch(`${baseUrl}/appointments`, { method: "POST", headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" }, body: JSON.stringify(appointment) })).status).toBe(202);
    expect((await fetch(`${baseUrl}/appointments`, { method: "POST", headers: { Cookie: familyCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" }, body: JSON.stringify(appointment) })).status).toBe(202);
    const created = await fetch(`${baseUrl}/appointments`, { method: "POST", headers: { Cookie: elderCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" }, body: JSON.stringify(appointment) });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: number };
    expect((await fetch(`${baseUrl}/appointments/${id}`, { method: "PATCH", headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" }, body: JSON.stringify({ ...appointment, doctor: "Dr. Caretaker" }) })).status).toBe(202);
    expect((await fetch(`${baseUrl}/appointments/${id}`, { method: "PATCH", headers: { Cookie: familyCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" }, body: JSON.stringify({ ...appointment, doctor: "Dr. Family" }) })).status).toBe(202);
    expect((await fetch(`${baseUrl}/appointments/${id}`, { method: "DELETE", headers: { Cookie: caretakerCookie, "X-Dhaaga-Action": "1" } })).status).toBe(202);
    expect((await fetch(`${baseUrl}/appointments/${id}`, { method: "DELETE", headers: { Cookie: familyCookie, "X-Dhaaga-Action": "1" } })).status).toBe(202);
    expect((await fetch(`${baseUrl}/appointments/${id}`, { method: "DELETE", headers: { Cookie: elderCookie, "X-Dhaaga-Action": "1" } })).status).toBe(200);
  });

  it("allows Elder-only circle changes and daily check-ins", async () => {
    const elderCookie = await signIn("Elder", "Asha");
    const settings = await fetch(`${baseUrl}/circle`, {
      method: "PATCH",
      headers: { Cookie: elderCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ escalation_caretaker_minutes: 25, escalation_family_minutes: 50 }),
    });
    expect(settings.status).toBe(200);
    const checkin = await fetch(`${baseUrl}/checkins`, {
      method: "POST",
      headers: { Cookie: elderCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ mood: 4, note: "Doing well." }),
    });
    expect(checkin.status).toBe(200);
  });

  it("allows the Caretaker interaction check and Elder Time Machine", async () => {
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const interaction = await fetch(`${baseUrl}/interactions`, {
      method: "POST",
      headers: { Cookie: caretakerCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ name: "Vitamin C" }),
    });
    expect(interaction.status).toBe(200);
    const elderCookie = await signIn("Elder", "Asha");
    const clock = await fetch(`${baseUrl}/demo/clock`, {
      method: "POST",
      headers: { Cookie: elderCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ minutes: 1 }),
    });
    expect(clock.status).toBe(200);
    scheduler.resetDemoClockOffset();
  });

  it("rejects unsupported prescription MIME types", async () => {
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const form = new FormData();
    form.append("image", new Blob(["not an image"], { type: "text/plain" }), "note.txt");
    const response = await fetch(`${baseUrl}/prescription-draft`, {
      method: "POST",
      headers: { Cookie: caretakerCookie, "X-Dhaaga-Action": "1" },
      body: form,
    });
    expect(response.status).toBe(400);
  });

  it("rejects prescription uploads larger than 4 MB", async () => {
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "image/png" }), "large.png");
    const response = await fetch(`${baseUrl}/prescription-draft`, {
      method: "POST",
      headers: { Cookie: caretakerCookie, "X-Dhaaga-Action": "1" },
      body: form,
    });
    expect(response.status).toBe(413);
  });

  it("returns a validated editable prescription draft without storing the image", async () => {
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const form = new FormData();
    form.append("image", new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }), "prescription.png");
    const response = await fetch(`${baseUrl}/prescription-draft`, {
      method: "POST",
      headers: { Cookie: caretakerCookie, "X-Dhaaga-Action": "1" },
      body: form,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ needs_elder_confirmation: true, image_stored: false, draft: { schedule: ["8:00 AM"] } });
  });

  it("validates the prescription output schema and rejects malformed schedules", () => {
    const valid = { name: "Vitamin D", dose: "1 capsule", instructions: "", schedule: ["8:00 PM"] };
    expect(schemas.prescriptionDraftSchema.safeParse(valid).success).toBe(true);
    expect(schemas.prescriptionDraftSchema.safeParse({ ...valid, schedule: ["later"] }).success).toBe(false);
    expect(schemas.prescriptionDraftSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("covers the offline interaction-rule groups and safety wording", () => {
    const cases: [string, string, string][] = [
      ["warfarin", "aspirin", "Warfarin"],
      ["lisinopril", "potassium", "ACE inhibitor"],
      ["sildenafil", "nitroglycerin", "Nitrate"],
      ["sertraline", "ibuprofen", "SSRI"],
      ["naproxen", "ibuprofen", "Two anti-inflammatory"],
      ["paracetamol", "acetaminophen", "duplicate paracetamol"],
    ];
    for (const [proposed, existing, title] of cases) {
      const warning = domain.findInteractionWarnings(proposed, [existing])[0];
      expect(warning?.title.toLowerCase(), `${proposed} with ${existing}`).toContain(title.toLowerCase());
      expect(warning?.note).toContain("Ask your doctor or pharmacist.");
    }
  });

  it("rejects mutating requests without the Dhaaga custom header", async () => {
    const caretakerCookie = await signIn("Caretaker", "Nila");
    const response = await fetch(`${baseUrl}/medications`, {
      method: "POST",
      headers: { Cookie: caretakerCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Should not be added", dose: "1 tablet", instructions: "", schedule: ["8:00 AM"], days: ["Mon"] }),
    });
    expect(response.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS count FROM medications WHERE circle_id = ? AND name = 'Should not be added'").get(circleId)).toMatchObject({ count: 0 });
  });

  it("allows Family to create an appointment proposal through Ask Dhaaga", async () => {
    const familyCookie = await signIn("Family", "Kabir");
    const response = await fetch(`${baseUrl}/ask-dhaaga`, {
      method: "POST",
      headers: { Cookie: familyCookie, "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
      body: JSON.stringify({ command: "book an appointment with Dr. Shah tomorrow at 3pm" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "proposal", entity: "appointment", payload: { doctor: "Dr. Shah" } });
  });

  it("falls back to the template when a Sunday Letter rewrite adds a number", () => {
    const data = weeklyLetter.collectWeeklyLetterData(circleId, new Date("2025-01-08T12:00:00.000Z"));
    const template = weeklyLetter.renderWeeklyLetter(data);
    const invalid = weeklyLetter.validatePolishedWeeklyLetter("Everyone had a 100% week.", data, template);
    expect(invalid).toEqual({ body: template, polished: false });
    const valid = weeklyLetter.validatePolishedWeeklyLetter(template.replace("Hello family,", "Hello, dear family,"), data, template);
    expect(valid).toMatchObject({ polished: true });
  });

  it("builds seven timezone-aware braid strands from dose events", async () => {
    const records = [
      { scheduledAt: "2025-01-07T03:00:00.000Z", status: "taken" },
      { scheduledAt: "2025-01-07T04:00:00.000Z", status: "missed" },
      { scheduledAt: "2025-01-08T03:00:00.000Z", status: "pending" },
    ];
    const insert = db.prepare("INSERT INTO dose_events(circle_id, medication_id, scheduled_at, status) VALUES (?, ?, ?, ?)");
    for (const record of records) insert.run(circleId, medicationId, record.scheduledAt, record.status);
    const days = weekBraid.collectWeekBraid(circleId, new Date("2025-01-08T12:00:00.000Z"));
    expect(days).toHaveLength(7);
    expect(days[0].date).toBe("2025-01-02");
    expect(days[6].date).toBe("2025-01-08");
    expect(days[5]).toMatchObject({ completed: 1, total: 2, percentage: 50 });
    expect(days[6]).toMatchObject({ completed: 0, total: 1, percentage: 0 });
    const familyCookie = await signIn("Family", "Kabir");
    const bootstrap = await fetch(`${baseUrl}/bootstrap`, { headers: { Cookie: familyCookie } });
    expect((await bootstrap.json()).weekBraid).toHaveLength(7);
    for (const record of records) db.prepare("DELETE FROM dose_events WHERE circle_id = ? AND scheduled_at = ?").run(circleId, record.scheduledAt);
  });
});
