import { z } from "zod";

export const roleSchema = z.enum(["Elder", "Caretaker", "Family"]);
export const loginSchema = z.object({
  circle: z.string().trim().min(3).max(64),
  passcode: z.string().regex(/^\d{6}$/),
  role: roleSchema,
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254).or(z.literal("")),
});
export const medicationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  dose: z.string().trim().min(1).max(100),
  instructions: z.string().trim().max(500),
  schedule: z.array(z.string().regex(/^(0?[1-9]|1[0-2]):[0-5]\d (AM|PM)$/i)).min(1).max(8),
  days: z.array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])).min(1).max(7),
});
export const appointmentSchema = z.object({
  doctor: z.string().trim().min(1).max(100),
  specialty: z.string().trim().max(100),
  place: z.string().trim().max(200),
  notes: z.string().trim().max(1000),
  starts_at: z.string().datetime(),
}).refine((value) => Date.parse(value.starts_at) > Date.now(), { message: "Appointment must be in the future.", path: ["starts_at"] });
export const doseStatusSchema = z.object({ status: z.enum(["taken", "skipped"]) });
export const proposalDecisionSchema = z.object({ decision: z.enum(["approved", "declined"]) });
export const checkinSchema = z.object({ mood: z.number().int().min(1).max(5), note: z.string().trim().max(500) });
export const briefQuestionsSchema = z.object({
  questions: z.array(z.string().trim().min(1).max(200)).max(10),
});
