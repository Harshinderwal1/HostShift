import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, hashSecret, id, nowIso } from "@/lib/db";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "hotel_manager";
  hotel_id: string | null;
  hotel_name?: string | null;
  status: string;
};

const COOKIE = "hostshift_session";
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function passwordParts(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

export function verifyPassword(password: string, salt: string, expected: string): boolean {
  const actual = Buffer.from(hashSecret(password, salt), "hex");
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)")
    .run(hashToken(token), userId, expires, nowIso());
  return token;
}

export function revokeSession(request: Request): void {
  const token = getCookie(request.headers.get("cookie") || "", COOKIE);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hashToken(token));
}

export function getSessionUser(request: Request): SessionUser | null {
  const token = getCookie(request.headers.get("cookie") || "", COOKIE);
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id,u.email,u.name,u.role,u.hotel_id,u.status,h.name AS hotel_name
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN hotels h ON h.id=u.hotel_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'
  `).get(hashToken(token), nowIso()) as SessionUser | undefined;
  return row ?? null;
}

export function authCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 24 * 60 * 60}${secure}`;
}

export function expiredAuthCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function makeResetToken(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO reset_tokens(token_hash,user_id,expires_at,used,created_at) VALUES(?,?,?,0,?)")
    .run(hashToken(token), userId, new Date(Date.now() + 30 * 60 * 1000).toISOString(), nowIso());
  return token;
}

export function resetPassword(token: string, password: string): boolean {
  const row = db.prepare("SELECT user_id FROM reset_tokens WHERE token_hash=? AND used=0 AND expires_at>? ")
    .get(hashToken(token), nowIso()) as { user_id: string } | undefined;
  if (!row) return false;
  const { salt, hash } = passwordParts(password);
  db.prepare("UPDATE users SET password_hash=?,password_salt=? WHERE id=?").run(hash, salt, row.user_id);
  db.prepare("UPDATE reset_tokens SET used=1 WHERE token_hash=?").run(hashToken(token));
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(row.user_id);
  return true;
}

export function newId(): string { return id(); }

function getCookie(cookieHeader: string, key: string): string | null {
  const entry = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(key.length + 1));
}
