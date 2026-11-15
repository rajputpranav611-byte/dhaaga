import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "./db";

export type Role = "Elder" | "Caretaker" | "Family";
export interface AuthenticatedRequest extends Request {
  auth?: { memberId: number; circleId: number; role: Role; name: string; email: string };
}

const sessionSecret = process.env.SESSION_SECRET ?? "local-development-secret-change-me";
const cookieName = "dhaaga_session";
const codeLength = 6;
if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("Production requires a SESSION_SECRET with at least 32 characters.");
}

export function hashPasscode(passcode: string, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(passcode, salt, 64).toString("hex") };
}

export function verifyPasscode(passcode: string, salt: string, expected: string) {
  if (!/^\d{6}$/.test(passcode)) return false;
  const actual = scryptSync(passcode, salt, 64);
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function makeSessionCookie(sessionId: string) {
  const signature = createHmac("sha256", sessionSecret).update(sessionId).digest("hex");
  return `${sessionId}.${signature}`;
}

export function parseSessionCookie(value: string) {
  const split = value.lastIndexOf(".");
  if (split < 1) return null;
  const id = value.slice(0, split);
  const signature = value.slice(split + 1);
  const expected = createHmac("sha256", sessionSecret).update(id).digest("hex");
  const givenBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (givenBytes.length !== expectedBytes.length || !timingSafeEqual(givenBytes, expectedBytes)) return null;
  return id;
}

export function setSession(res: Response, memberId: number) {
  const sessionId = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(id, member_id, expires_at) VALUES (?, ?, ?)").run(
    sessionId, memberId, new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  );
  res.cookie(cookieName, makeSessionCookie(sessionId), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    maxAge: 14 * 24 * 60 * 60 * 1000, path: "/",
  });
}

export function clearSession(res: Response, value?: string) {
  if (value) {
    const id = parseSessionCookie(value);
    if (id) db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
  res.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const raw = req.cookies?.[cookieName] as string | undefined;
  const id = raw ? parseSessionCookie(raw) : null;
  if (!id) return res.status(401).json({ error: "Please enter your circle first." });
  const session = db.prepare(`
    SELECT s.member_id, s.expires_at, m.circle_id, m.role, m.name, m.email
    FROM sessions s JOIN members m ON m.id = s.member_id WHERE s.id = ?
  `).get(id) as { member_id: number; expires_at: string; circle_id: number; role: Role; name: string; email: string } | undefined;
  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    clearSession(res);
    return res.status(401).json({ error: "Your circle session has expired. Please sign in again." });
  }
  req.auth = { memberId: session.member_id, circleId: session.circle_id, role: session.role, name: session.name, email: session.email };
  next();
}

export function requireMutationHeader(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (req.get("X-Dhaaga-Action") !== "1") return res.status(403).json({ error: "This action needs to come from the Dhaaga app." });
  next();
}

export function requireRoles(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return res.status(403).json({ error: "Your circle role cannot make this change." });
    next();
  };
}

export function loginLocked(ip: string, slug: string, now = Date.now()) {
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").run(new Date(now - 25 * 60_000).toISOString());
  const lock = db.prepare("SELECT MAX(locked_until) AS locked_until FROM login_attempts WHERE ip = ? AND circle_slug = ?")
    .get(ip, slug) as { locked_until: string | null };
  if (lock.locked_until && Date.parse(lock.locked_until) > now) return true;
  const count = db.prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE ip = ? AND circle_slug = ? AND attempted_at > ?")
    .get(ip, slug, new Date(now - 10 * 60_000).toISOString()) as { count: number };
  return count.count >= 5;
}

export function recordLoginFailure(ip: string, slug: string, now = Date.now()) {
  db.prepare("INSERT INTO login_attempts(ip, circle_slug, attempted_at) VALUES (?, ?, ?)").run(ip, slug, new Date(now).toISOString());
  const count = db.prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE ip = ? AND circle_slug = ? AND attempted_at > ?")
    .get(ip, slug, new Date(now - 10 * 60_000).toISOString()) as { count: number };
  if (count.count >= 5) db.prepare("UPDATE login_attempts SET locked_until = ? WHERE ip = ? AND circle_slug = ? AND attempted_at = ?")
    .run(new Date(now + 15 * 60_000).toISOString(), ip, slug, new Date(now).toISOString());
}

export const PASSCODE_LENGTH = codeLength;

