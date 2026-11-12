import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve(process.cwd(), process.env.HOSTSHIFT_DB_PATH || "data/hostshift.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS hotels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    area TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    manager_name TEXT NOT NULL DEFAULT '',
    contact_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','hotel_manager')),
    hotel_id TEXT REFERENCES hotels(id),
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY,
    hotel_name TEXT NOT NULL,
    city TEXT NOT NULL,
    area TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    manager_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT
  );
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    city TEXT NOT NULL,
    area TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    radius_km REAL NOT NULL DEFAULT 10,
    roles_json TEXT NOT NULL DEFAULT '[]',
    skills_json TEXT NOT NULL DEFAULT '[]',
    availability_json TEXT NOT NULL DEFAULT '[]',
    language TEXT NOT NULL DEFAULT 'English',
    verified INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    opted_in INTEGER NOT NULL DEFAULT 1,
    completed_shifts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    hotel_id TEXT NOT NULL REFERENCES hotels(id),
    role TEXT NOT NULL,
    skills_json TEXT NOT NULL DEFAULT '[]',
    headcount INTEGER NOT NULL,
    shift_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    pay_amount REAL NOT NULL,
    platform_fee_rate REAL NOT NULL DEFAULT 0.08,
    duties TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL,
    area TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    cancellation_terms TEXT NOT NULL DEFAULT '',
    response_deadline TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL REFERENCES workers(id),
    status TEXT NOT NULL DEFAULT 'invited',
    batch_no INTEGER NOT NULL DEFAULT 1,
    sent_at TEXT NOT NULL,
    responded_at TEXT,
    UNIQUE(shift_id, worker_id)
  );
  CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    shift_id TEXT NOT NULL REFERENCES shifts(id),
    worker_id TEXT NOT NULL REFERENCES workers(id),
    status TEXT NOT NULL DEFAULT 'confirmed',
    start_code TEXT NOT NULL,
    end_code TEXT NOT NULL,
    checked_in_at TEXT,
    checked_out_at TEXT,
    hours REAL,
    scheduled_hours REAL NOT NULL DEFAULT 0,
    overtime_hours REAL NOT NULL DEFAULT 0,
    overtime_pay REAL NOT NULL DEFAULT 0,
    final_pay REAL,
    hours_approved INTEGER NOT NULL DEFAULT 0,
    worker_hours_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(shift_id, worker_id)
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    shift_id TEXT NOT NULL REFERENCES shifts(id),
    assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(id),
    worker_pay REAL NOT NULL,
    overtime_pay REAL NOT NULL DEFAULT 0,
    platform_fee REAL NOT NULL,
    total_amount REAL NOT NULL,
    collection_status TEXT NOT NULL DEFAULT 'qr_ready',
    payout_status TEXT NOT NULL DEFAULT 'not_started',
    provider_ref TEXT,
    qr_payload TEXT NOT NULL,
    expires_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    worker_id TEXT REFERENCES workers(id),
    shift_id TEXT REFERENCES shifts(id),
    channel TEXT NOT NULL DEFAULT 'whatsapp_sandbox',
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS disputes (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES assignments(id),
    reported_by TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    decision TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS support_requests (
    id TEXT PRIMARY KEY,
    hotel_id TEXT NOT NULL REFERENCES hotels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shifts_hotel_date ON shifts(hotel_id, shift_date);
  CREATE INDEX IF NOT EXISTS idx_invitations_shift_status ON invitations(shift_id, status);
  CREATE INDEX IF NOT EXISTS idx_assignments_shift_status ON assignments(shift_id, status);
  CREATE INDEX IF NOT EXISTS idx_messages_worker_created ON messages(worker_id, created_at);
`);

const assignmentColumns = new Set((db.prepare("PRAGMA table_info(assignments)").all() as Array<{ name: string }>).map((column) => column.name));
if (!assignmentColumns.has("scheduled_hours")) db.exec("ALTER TABLE assignments ADD COLUMN scheduled_hours REAL NOT NULL DEFAULT 0");
if (!assignmentColumns.has("overtime_hours")) db.exec("ALTER TABLE assignments ADD COLUMN overtime_hours REAL NOT NULL DEFAULT 0");
if (!assignmentColumns.has("overtime_pay")) db.exec("ALTER TABLE assignments ADD COLUMN overtime_pay REAL NOT NULL DEFAULT 0");
const paymentColumns = new Set((db.prepare("PRAGMA table_info(payments)").all() as Array<{ name: string }>).map((column) => column.name));
if (!paymentColumns.has("overtime_pay")) db.exec("ALTER TABLE payments ADD COLUMN overtime_pay REAL NOT NULL DEFAULT 0");
if (!paymentColumns.has("expires_at")) db.exec("ALTER TABLE payments ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''");

export const nowIso = () => new Date().toISOString();
export const id = () => randomUUID();
export const parseJson = <T,>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
export const hashSecret = (value: string, salt: string) => scryptSync(value, salt, 64).toString("hex");

function seed(): void {
  const count = Number((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n);
  if (count > 0) return;
  const demoMode = process.env.NODE_ENV !== "production" && process.env.HOSTSHIFT_SANDBOX !== "false";
  const adminPassword = process.env.HOSTSHIFT_ADMIN_PASSWORD || (process.env.NODE_ENV === "production" ? "" : "HostshiftDemo!26");
  if (!adminPassword) throw new Error("HOSTSHIFT_ADMIN_PASSWORD is required for the first production admin.");
  const managerPassword = process.env.HOSTSHIFT_DEMO_MANAGER_PASSWORD || (process.env.NODE_ENV === "production" ? "" : "HotelDemo!26");
  const at = nowIso();
  const addUser = (email: string, name: string, role: string, hotelId: string | null, password: string) => {
    const salt = randomBytes(16).toString("hex");
    db.prepare("INSERT INTO users(id,email,name,role,hotel_id,password_hash,password_salt,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id(), email, name, role, hotelId, hashSecret(password, salt), salt, "active", at);
  };
  addUser(process.env.HOSTSHIFT_ADMIN_EMAIL || "admin@hostshift.demo", "Hostshift Pilot Admin", "admin", null, adminPassword);
  if (!demoMode) return;
  const pilotArea = process.env.HOSTSHIFT_PILOT_AREA || "Pilot Demo Area";
  const hotels = [
    { id: "hotel_demo_1", name: "Demo · The Olive Hotel", area: "Central", lat: 28.6139, lng: 77.2090 },
    { id: "hotel_demo_2", name: "Demo · Maple Courtyard", area: "North Quarter", lat: 28.6500, lng: 77.2200 },
    { id: "hotel_demo_3", name: "Demo · Cedar House", area: "South Quarter", lat: 28.5800, lng: 77.2300 },
  ];
  for (const hotel of hotels) {
    db.prepare("INSERT INTO hotels(id,name,city,area,address,latitude,longitude,status,manager_name,contact_email,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(hotel.id, hotel.name, pilotArea, hotel.area, `${hotel.area}, ${pilotArea}`, hotel.lat, hotel.lng, "approved", "Demo Manager", "manager@hostshift.demo", at);
  }
  if (managerPassword) addUser(process.env.HOSTSHIFT_DEMO_MANAGER_EMAIL || "manager@hostshift.demo", "Demo · Aarav Mehta", "hotel_manager", hotels[0].id, managerPassword);
  const workers = [
    ["w_demo_1", "Demo · Priya Sharma", "+919800000101", "Central", 28.6160, 77.2110, 10, ["Banquet Server", "Restaurant Service"], ["Guest service", "Food safety"]],
    ["w_demo_2", "Demo · Rohan Singh", "+919800000102", "North Quarter", 28.6380, 77.2150, 12, ["Kitchen Assistant", "Banquet Server"], ["Food preparation", "Service"]],
    ["w_demo_3", "Demo · Ananya Patel", "+919800000103", "Central", 28.6070, 77.2020, 8, ["Housekeeping Attendant", "Banquet Server"], ["Room cleaning", "Guest service"]],
    ["w_demo_4", "Demo · Vikram Mehta", "+919800000104", "South Quarter", 28.5830, 77.2260, 14, ["Kitchen Assistant", "Restaurant Service"], ["Food safety", "Preparation"]],
    ["w_demo_5", "Demo · Aisha Khan", "+919800000105", "North Quarter", 28.6530, 77.2250, 9, ["Front Desk Assistant", "Banquet Server"], ["Communication", "Guest service"]],
    ["w_demo_6", "Demo · Meena Kumari", "+919800000106", "Central", 28.6200, 77.1950, 10, ["Housekeeping Attendant"], ["Room cleaning", "Laundry"]],
  ] as const;
  for (const [workerId, name, phone, area, lat, lng, radius, roles, skills] of workers) {
    db.prepare("INSERT INTO workers(id,name,phone,city,area,latitude,longitude,radius_km,roles_json,skills_json,availability_json,language,verified,active,opted_in,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(workerId, name, phone, pilotArea, area, lat, lng, radius, JSON.stringify(roles), JSON.stringify(skills), JSON.stringify(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]), "English / Hindi", 1, 1, 1, at);
  }
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const shiftDate = tomorrow.toISOString().slice(0, 10);
  const responseDeadline = new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO shifts(id,hotel_id,role,skills_json,headcount,shift_date,start_time,end_time,pay_amount,platform_fee_rate,duties,city,area,address,latitude,longitude,cancellation_terms,response_deadline,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("shift_demo_1", hotels[0].id, "Banquet Server", JSON.stringify(["Guest service"]), 3, shiftDate, "17:00", "23:00", 1200, 0.08, "DEMO SHIFT · Support banquet setup and guest service.", pilotArea, hotels[0].area, hotels[0].area, hotels[0].lat, hotels[0].lng, "Late cancellations are reviewed by the pilot admin.", responseDeadline, "open", at, at);
  const defaults: Record<string, string> = {
    pilot_area: pilotArea,
    supported_roles: JSON.stringify(["Banquet Server", "Housekeeping Attendant", "Kitchen Assistant", "Restaurant Service", "Front Desk Assistant"]),
    batch_multiplier: "2",
    response_window_minutes: "45",
    cancellation_window_hours: "24",
    late_cancel_compensation_percent: "50",
    platform_fee_percent: "8",
  };
  const set = db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)");
  for (const [key, value] of Object.entries(defaults)) set.run(key, value);
}

seed();

export function audit(actorId: string | null, action: string, entityType: string, entityId: string, reason = ""): void {
  db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,reason,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id(), actorId, action, entityType, entityId, reason, nowIso());
}

export function getSetting(key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
