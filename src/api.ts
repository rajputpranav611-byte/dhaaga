export type Role = "Elder" | "Caretaker" | "Family";
export type DoseStatus = "pending" | "taken" | "late" | "missed" | "skipped";

export interface Dose {
  id: number;
  medication_id: number;
  medication: string;
  dose: string;
  scheduled_at: string;
  status: DoseStatus;
  taken_at: string | null;
}

export interface Medication {
  id: number;
  name: string;
  dose: string;
  instructions: string;
  schedule: string[];
  days: string[];
}

export interface Appointment {
  id: number;
  doctor: string;
  specialty: string;
  place: string;
  notes: string;
  starts_at: string;
}

export interface Proposal {
  id: number;
  entity: string;
  action: string;
  payload: string;
  proposed_by: string;
  created_at: string;
  status: string;
}

export interface DoctorBrief {
  elderName: string;
  generatedAt: string;
  medications: Medication[];
  adherence: {
    sevenDays: { percentage: number | null; completed: number; total: number };
    thirtyDays: { percentage: number | null; completed: number; total: number };
  };
  missedOrLate: { id: number; medication: string; dose: string; scheduled_at: string; status: "missed" | "late" }[];
  moodTrend: { date: string; average_mood: number; entries: number }[];
  appointments: Appointment[];
  questions: string[];
}

export interface WeeklyLetterPreview {
  weekKey: string;
  recipientCount: number;
  subject: string;
  body: string;
}

export interface WeeklyLetterSendResult extends WeeklyLetterPreview {
  created: boolean;
  sentAt: string | null;
  polished: boolean;
}

export interface Snapshot {
  circle: { name: string; elder_name: string; timezone: string; caretaker_direct_edit: number; escalation_caretaker_minutes: number; escalation_family_minutes: number };
  member: { name: string; role: Role };
  medications: Medication[];
  doses: Dose[];
  appointments: Appointment[];
  proposals: Proposal[];
  audit: { id: number; actor: string; action: string; detail: string; created_at: string }[];
  checkin: { mood: number; note: string } | null;
  outbox: { id: number; kind: string; to_email: string; subject: string; body: string; sent_at: string | null }[];
  adherence: { today: number; week: number; month: number };
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json", "X-Dhaaga-Action": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Something went wrong. Please try again.");
  return result as T;
}

export const api = {
  session: async () => (await request<{ authenticated: boolean }>("/session")).authenticated,
  login: (body: { circle: string; passcode: string; role: Role; name: string; email: string }) =>
    request<{ member: Snapshot["member"] }>("/login", "POST", body),
  logout: () => request("/logout", "POST", {}),
  bootstrap: () => request<Snapshot>("/bootstrap"),
  doctorBrief: () => request<DoctorBrief>("/brief"),
  saveBriefQuestions: (questions: string[]) => request<{ questions: string[] }>("/brief/questions", "PUT", { questions }),
  weeklyLetterPreview: () => request<WeeklyLetterPreview>("/letter/preview"),
  sendWeeklyLetterNow: () => request<WeeklyLetterSendResult>("/letter/send-now", "POST", {}),
  setDose: (id: number, status: "taken" | "skipped") => request(`/doses/${id}`, "PATCH", { status }),
  addMedication: (body: Omit<Medication, "id">) => request<{ proposal?: boolean }>("/medications", "POST", body),
  updateMedication: (id: number, body: Omit<Medication, "id">) => request(`/medications/${id}`, "PATCH", body),
  removeMedication: (id: number) => request(`/medications/${id}`, "DELETE", {}),
  addAppointment: (body: Omit<Appointment, "id">) => request<{ proposal?: boolean }>("/appointments", "POST", body),
  updateAppointment: (id: number, body: Omit<Appointment, "id">) => request(`/appointments/${id}`, "PATCH", body),
  removeAppointment: (id: number) => request(`/appointments/${id}`, "DELETE", {}),
  decide: (id: number, decision: "approved" | "declined") => request(`/proposals/${id}`, "PATCH", { decision }),
  checkin: (mood: number, note: string) => request("/checkins", "POST", { mood, note }),
  checkInteractions: (name: string) => request<{ label: string; findings: { title: string; note: string }[] }>("/interactions", "POST", { name }),
  readPrescription: async (file: File) => {
    const form = new FormData();
    form.append("image", file);
    const response = await fetch("/api/prescription-draft", { method: "POST", credentials: "include", headers: { "X-Dhaaga-Action": "1" }, body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Could not read the prescription.");
    return result as { draft: Omit<Medication, "id" | "days">; needs_elder_confirmation: boolean; image_stored: false };
  },
  advanceClock: (minutes: number) => request<{ created: number }>("/demo/clock", "POST", { minutes }),
  updateCircle: (settings: Partial<{ caretaker_direct_edit: boolean; escalation_caretaker_minutes: number; escalation_family_minutes: number }>) => request("/circle", "PATCH", settings),
};
