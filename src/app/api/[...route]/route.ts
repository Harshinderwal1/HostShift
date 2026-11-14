import { db, audit, getSetting, id, nowIso, parseJson, setSetting } from "@/lib/db";
import { authCookie, createSession, getSessionUser, makeResetToken, passwordParts, resetPassword, revokeSession, verifyPassword } from "@/lib/auth";
import { eligibleWorkers } from "@/lib/matching";
import { enqueueWhatsApp, logWorkerReply, makeSandboxPaymentPayload } from "@/lib/providers";
import { randomInt } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Row = Record<string, any>;
type User = NonNullable<ReturnType<typeof getSessionUser>>;

const ok = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers });
const fail = (message: string, status = 400) => ok({ error: message }, status);
const sandbox = () => process.env.HOSTSHIFT_SANDBOX !== "false" && process.env.NODE_ENV !== "production";
const clean = (value: unknown, max = 500) => String(value ?? "").trim().slice(0, max);
const numeric = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const loginWindows = new Map<string, { count: number; startedAt: number }>();
const workerRegistrationWindows = new Map<string, { count: number; startedAt: number }>();
const shiftStartInstant = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`).getTime();

async function bodyOf(request: Request): Promise<Row> {
  try { return await request.json() as Row; } catch { return {}; }
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const requestUrlHost = new URL(request.url).host.toLowerCase();
    const hostHeader = request.headers.get("host")?.trim().toLowerCase();
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0].trim().toLowerCase();
    return [hostHeader, forwardedHost, requestUrlHost].filter(Boolean).includes(originHost);
  } catch { return false; }
}

function requireUser(request: Request, roles: Array<"admin" | "hotel_manager">): User | Response {
  const user = getSessionUser(request);
  if (!user) return fail("Please sign in to continue.", 401);
  if (!roles.includes(user.role)) return fail("You do not have access to this action.", 403);
  return user;
}

function ownShift(shiftId: string, user: User): Row | undefined {
  const query = user.role === "admin"
    ? db.prepare("SELECT s.*,h.name AS hotel_name,h.status AS hotel_status FROM shifts s JOIN hotels h ON h.id=s.hotel_id WHERE s.id=?")
    : db.prepare("SELECT s.*,h.name AS hotel_name,h.status AS hotel_status FROM shifts s JOIN hotels h ON h.id=s.hotel_id WHERE s.id=? AND s.hotel_id=?");
  return (user.role === "admin" ? query.get(shiftId) : query.get(shiftId, user.hotel_id)) as Row | undefined;
}

function ownAssignment(assignmentId: string, user: User): Row | undefined {
  const query = user.role === "admin"
    ? db.prepare("SELECT a.*,s.hotel_id,s.role,s.shift_date,s.start_time,s.end_time,s.pay_amount,s.platform_fee_rate,w.name AS worker_name,w.phone AS worker_phone FROM assignments a JOIN shifts s ON s.id=a.shift_id JOIN workers w ON w.id=a.worker_id WHERE a.id=?")
    : db.prepare("SELECT a.*,s.hotel_id,s.role,s.shift_date,s.start_time,s.end_time,s.pay_amount,s.platform_fee_rate,w.name AS worker_name,w.phone AS worker_phone FROM assignments a JOIN shifts s ON s.id=a.shift_id JOIN workers w ON w.id=a.worker_id WHERE a.id=? AND s.hotel_id=?");
  return (user.role === "admin" ? query.get(assignmentId) : query.get(assignmentId, user.hotel_id)) as Row | undefined;
}

function hoursBetween(start: string, end: string): number {
  const toMinutes = (value: string) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };
  let minutes = toMinutes(end) - toMinutes(start);
  if (minutes <= 0) minutes += 1440;
  return Math.round((minutes / 60) * 100) / 100;
}

function overtimeFor(assignment: Row, actualHours: number): { overtimeHours: number; overtimePay: number } {
  const scheduledHours = Math.max(0.25, numeric(assignment.scheduled_hours, hoursBetween(assignment.start_time, assignment.end_time)) || hoursBetween(assignment.start_time, assignment.end_time));
  const overtimeHours = Math.round(Math.max(0, actualHours - scheduledHours) * 100) / 100;
  const overtimePay = Math.round(overtimeHours * (Number(assignment.pay_amount) / scheduledHours) * 100) / 100;
  return { overtimeHours, overtimePay };
}

async function handle(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const input = ["POST", "PATCH", "PUT", "DELETE"].includes(method) ? await bodyOf(request) : {};
  if (input && !sameOrigin(request)) return fail("Request origin could not be verified.", 403);

  if (method === "GET" && path.join("/") === "session") {
    const supportedRoles = parseJson<string[]>(getSetting("supported_roles", JSON.stringify(["Banquet Server", "Housekeeping Attendant", "Kitchen Assistant", "Restaurant Service", "Front Desk Assistant"])), []);
    return ok({ user: getSessionUser(request), sandbox: sandbox(), pilotArea: getSetting("pilot_area", "Pilot Area"), supportedRoles });
  }

  if (method === "POST" && path.join("/") === "auth/login") {
    const email = clean(input.email, 200).toLowerCase();
    const password = String(input.password ?? "");
    if (!email || password.length < 1) return fail("Enter your email and password.");
    const remote = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const attemptKey = `${remote}:${email}`;
    const window = loginWindows.get(attemptKey);
    if (window && Date.now() - window.startedAt < 15 * 60_000 && window.count >= 8) return fail("Too many sign-in attempts. Try again in 15 minutes.", 429);
    if (!window || Date.now() - window.startedAt >= 15 * 60_000) loginWindows.set(attemptKey, { count: 1, startedAt: Date.now() });
    else window.count += 1;
    const user = db.prepare("SELECT * FROM users WHERE email=?").get(email) as Row | undefined;
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) return fail("Email or password is incorrect.", 401);
    if (user.status === "pending") return fail("Your hotel access request is still awaiting pilot team approval.", 403);
    if (user.status !== "active") return fail("Email or password is incorrect.", 401);
    loginWindows.delete(attemptKey);
    const token = createSession(user.id);
    audit(user.id, "sign_in", "user", user.id);
    return ok({ user: { id: user.id, email: user.email, name: user.name, role: user.role, hotel_id: user.hotel_id } }, 200, { "Set-Cookie": authCookie(token) });
  }

  if (method === "POST" && path.join("/") === "auth/logout") {
    const user = getSessionUser(request);
    if (user) audit(user.id, "sign_out", "user", user.id);
    revokeSession(request);
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return ok({ ok: true }, 200, { "Set-Cookie": `hostshift_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}` });
  }

  if (method === "POST" && path.join("/") === "auth/forgot") {
    const email = clean(input.email, 200).toLowerCase();
    const user = db.prepare("SELECT id FROM users WHERE email=? AND status='active'").get(email) as Row | undefined;
    const response: Row = { ok: true, message: "If an approved account exists, password reset instructions are ready." };
    if (user && sandbox()) {
      const token = makeResetToken(user.id);
      response.sandboxResetUrl = `/reset-password?token=${encodeURIComponent(token)}`;
    }
    return ok(response);
  }

  if (method === "POST" && path.join("/") === "auth/reset") {
    const token = clean(input.token, 500);
    const password = String(input.password ?? "");
    if (password.length < 10) return fail("Use a password with at least 10 characters.");
    if (!resetPassword(token, password)) return fail("This reset link is invalid or expired.", 400);
    return ok({ ok: true, message: "Password changed. Sign in with your new password." });
  }

  if (method === "POST" && path.join("/") === "access-requests") {
    const hotelName = clean(input.hotelName, 140);
    const managerName = clean(input.managerName, 120);
    const email = clean(input.email, 200).toLowerCase();
    const phone = clean(input.phone, 40);
    const city = clean(input.city, 100);
    const area = clean(input.area, 100);
    const password = String(input.password ?? "");
    if (!hotelName || !managerName || !email.includes("@") || !phone || !city || !area || !password) return fail("Complete all required hotel, manager, and password details.");
    if (password.length < 10) return fail("Choose a password with at least 10 characters.");
    const existing = db.prepare("SELECT id FROM access_requests WHERE email=? AND status='pending'").get(email);
    if (existing) return fail("An access request for this email is already under review.", 409);
    if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) return fail("An account already exists with this business email. Sign in or use a different email.", 409);
    const requestId = id();
    const userId = id();
    const { salt, hash } = passwordParts(password);
    const at = nowIso();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO access_requests(id,hotel_name,city,area,address,manager_name,email,phone,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(requestId, hotelName, city, area, clean(input.address, 240), managerName, email, phone, "pending", at);
      db.prepare("INSERT INTO users(id,email,name,role,hotel_id,password_hash,password_salt,status,created_at) VALUES(?,?,?,'hotel_manager',NULL,?,?, 'pending',?)")
        .run(userId, email, managerName, hash, salt, at);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no transaction remained open */ }
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return fail("An account or pending request already exists for this business email.", 409);
      throw error;
    }
    return ok({ ok: true, message: "Request received. The pilot team will verify the hotel; you can sign in with your chosen password after approval." }, 201);
  }

  if (method === "POST" && path.join("/") === "worker-registration-requests") {
    const name = clean(input.name, 120);
    const phone = clean(input.phone, 40).replace(/[^\d+]/g, "");
    const city = clean(input.city, 100) || getSetting("pilot_area", "Pilot Area");
    const area = clean(input.area, 100);
    const latitude = Math.round(Number(input.latitude) * 1000) / 1000;
    const longitude = Math.round(Number(input.longitude) * 1000) / 1000;
    const radiusKm = numeric(input.radiusKm, 10);
    const configuredRoles = parseJson<string[]>(getSetting("supported_roles", JSON.stringify(["Banquet Server", "Housekeeping Attendant", "Kitchen Assistant", "Restaurant Service", "Front Desk Assistant"])), []);
    const requestedRoles = Array.isArray(input.roles) ? input.roles.map((value: unknown) => clean(value, 80)).filter(Boolean) : [];
    const roleMap = new Map(configuredRoles.map((role) => [role.toLowerCase(), role]));
    const roles = [...new Set(requestedRoles.map((role) => roleMap.get(role.toLowerCase())).filter((role): role is string => Boolean(role)))];
    const skills = Array.isArray(input.skills) ? input.skills.map((value: unknown) => clean(value, 80)).filter(Boolean) : clean(input.skills, 500).split(",").map((value) => value.trim()).filter(Boolean);
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "All days"];
    const requestedAvailability = Array.isArray(input.availability) ? input.availability.map((value: unknown) => clean(value, 20)) : [];
    const availability = [...new Set(requestedAvailability.filter((day) => days.includes(day)))];
    if (!name || !/^\+[1-9]\d{7,14}$/.test(phone) || !city || !area || !roles.length || !availability.length || input.optedIn !== true) {
      return fail("Add your name, WhatsApp number with country code, area, at least one role and available day, and agree to WhatsApp shift alerts.");
    }
    if (requestedRoles.some((role) => !roleMap.has(role.toLowerCase()))) return fail("Choose only job roles currently available in the pilot area.");
    if (String(input.latitude ?? "").trim() === "" || String(input.longitude ?? "").trim() === "" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return fail("Add a valid approximate map pin near your area. Do not enter your home address.");
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 100) return fail("Choose a travel radius between 1 and 100 km.");
    const remote = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const rate = workerRegistrationWindows.get(remote);
    if (rate && Date.now() - rate.startedAt < 60 * 60_000 && rate.count >= 5) return fail("Too many registration requests. Try again in an hour.", 429);
    if (!rate || Date.now() - rate.startedAt >= 60 * 60_000) workerRegistrationWindows.set(remote, { count: 1, startedAt: Date.now() });
    else rate.count += 1;
    const workerId = id();
    const at = nowIso();
    try {
      db.prepare("INSERT INTO workers(id,name,phone,city,area,latitude,longitude,radius_km,roles_json,skills_json,availability_json,language,verified,active,opted_in,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,1,1,?)")
        .run(workerId, name, phone, city, area, latitude, longitude, radiusKm, JSON.stringify(roles), JSON.stringify(skills), JSON.stringify(availability), clean(input.language, 40) || "Hindi", at);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return fail("This WhatsApp number is already registered. Contact the pilot team if you need help.", 409);
      throw error;
    }
    audit(null, "worker_registration_request", "worker", workerId, `Public form registration; WhatsApp shift-alert consent recorded at ${at}.`);
    return ok({ ok: true, message: "Registration received. The pilot team will verify your details before sending shift invitations." }, 201);
  }

  if (method === "GET" && path.join("/") === "hotel/overview") {
    const auth = requireUser(request, ["hotel_manager"]);
    if (auth instanceof Response) return auth;
    const shifts = db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM assignments a WHERE a.shift_id=s.id AND a.status NOT IN ('cancelled','cancelled_late','no_show')) AS assigned_count,
      (SELECT COUNT(*) FROM invitations i WHERE i.shift_id=s.id AND i.status='interested') AS interested_count
      FROM shifts s WHERE s.hotel_id=? ORDER BY s.shift_date,s.start_time LIMIT 100`).all(auth.hotel_id) as Row[];
    const stats = db.prepare(`SELECT
      SUM(CASE WHEN status IN ('open','inviting_workers','awaiting_hotel_selection') THEN 1 ELSE 0 END) AS open_shifts,
      SUM(CASE WHEN status='filled' THEN 1 ELSE 0 END) AS filled_shifts,
      SUM(CASE WHEN status='payment_pending' THEN 1 ELSE 0 END) AS payment_pending
      FROM shifts WHERE hotel_id=?`).get(auth.hotel_id) as Row;
    const payments = db.prepare(`SELECT p.*,s.role,s.shift_date,w.name AS worker_name FROM payments p JOIN shifts s ON s.id=p.shift_id JOIN assignments a ON a.id=p.assignment_id JOIN workers w ON w.id=a.worker_id WHERE s.hotel_id=? ORDER BY p.created_at DESC LIMIT 20`).all(auth.hotel_id) as Row[];
    const supportRequests = db.prepare("SELECT * FROM support_requests WHERE hotel_id=? ORDER BY created_at DESC LIMIT 50").all(auth.hotel_id);
    return ok({ hotel: db.prepare("SELECT id,name,city,area,address,latitude,longitude FROM hotels WHERE id=?").get(auth.hotel_id), shifts, stats, payments, supportRequests, supportedRoles: parseJson(getSetting("supported_roles", "[]"), [] as string[]) });
  }

  if (method === "GET" && path.join("/") === "hotel/shifts") {
    const auth = requireUser(request, ["hotel_manager"]);
    if (auth instanceof Response) return auth;
    const shifts = db.prepare(`SELECT s.*,h.name AS hotel_name,
      (SELECT COUNT(*) FROM assignments a WHERE a.shift_id=s.id AND a.status NOT IN ('cancelled','cancelled_late','no_show')) AS assigned_count,
      (SELECT COUNT(*) FROM invitations i WHERE i.shift_id=s.id AND i.status='interested') AS interested_count
      FROM shifts s JOIN hotels h ON h.id=s.hotel_id WHERE s.hotel_id=? ORDER BY s.shift_date DESC,s.start_time`).all(auth.hotel_id) as Row[];
    return ok({ shifts });
  }

  if (method === "POST" && path.join("/") === "hotel/shifts") {
    const auth = requireUser(request, ["hotel_manager"]);
    if (auth instanceof Response) return auth;
    const role = clean(input.role, 80);
    const headcount = Math.floor(numeric(input.headcount));
    const pay = numeric(input.payAmount);
    const date = clean(input.date, 10);
    const start = clean(input.startTime, 5);
    const end = clean(input.endTime, 5);
    if (!role || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || headcount < 1 || headcount > 100 || pay <= 0) return fail("Check the role, date, time, headcount, and worker pay.");
    const hotel = db.prepare("SELECT * FROM hotels WHERE id=? AND status='approved'").get(auth.hotel_id) as Row | undefined;
    if (!hotel) return fail("This hotel is not approved for posting shifts.", 403);
    const shiftId = id();
    const at = nowIso();
    const deadline = input.responseDeadline ? new Date(String(input.responseDeadline)).toISOString() : new Date(Date.now() + Number(getSetting("response_window_minutes", "45")) * 60_000).toISOString();
    const skills = Array.isArray(input.skills) ? input.skills.map((v: unknown) => clean(v, 80)).filter(Boolean) : clean(input.skills, 300).split(",").map((v) => v.trim()).filter(Boolean);
    db.prepare(`INSERT INTO shifts(id,hotel_id,role,skills_json,headcount,shift_date,start_time,end_time,pay_amount,platform_fee_rate,duties,city,area,address,latitude,longitude,cancellation_terms,response_deadline,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      shiftId, hotel.id, role, JSON.stringify(skills), headcount, date, start, end, pay,
      numeric(getSetting("platform_fee_percent", "8")) / 100, clean(input.duties, 600), hotel.city, hotel.area,
      hotel.address, hotel.latitude, hotel.longitude,
      clean(input.cancellationTerms, 600) || `Hotel cancellations within ${getSetting("cancellation_window_hours", "24")} hours are reviewed for agreed compensation.`,
      deadline, "open", at, at,
    );
    audit(auth.id, "create_shift", "shift", shiftId);
    return ok({ shift: db.prepare("SELECT * FROM shifts WHERE id=?").get(shiftId) }, 201);
  }

  if (method === "PATCH" && path[0] === "hotel" && path[1] === "shifts" && path.length === 3) {
    const auth = requireUser(request, ["hotel_manager"]);
    if (auth instanceof Response) return auth;
    const shift = ownShift(path[2], auth);
    if (!shift) return fail("Shift not found.", 404);
    if (shift.status !== "open" || Number((db.prepare("SELECT COUNT(*) AS n FROM invitations WHERE shift_id=?").get(shift.id) as Row).n) > 0) return fail("A shift can only be edited before worker invitations are sent.", 409);
    const role = clean(input.role, 80);
    const headcount = Math.floor(numeric(input.headcount));
    const pay = numeric(input.payAmount);
    const date = clean(input.date, 10);
    const start = clean(input.startTime, 5);
    const end = clean(input.endTime, 5);
    if (!role || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || headcount < 1 || headcount > 100 || pay <= 0) return fail("Check the role, date, time, headcount, and worker pay.");
    const skills = Array.isArray(input.skills) ? input.skills.map((v: unknown) => clean(v, 80)).filter(Boolean) : clean(input.skills, 300).split(",").map((v) => v.trim()).filter(Boolean);
    db.prepare("UPDATE shifts SET role=?,skills_json=?,headcount=?,shift_date=?,start_time=?,end_time=?,pay_amount=?,duties=?,cancellation_terms=?,updated_at=? WHERE id=?")
      .run(role, JSON.stringify(skills), headcount, date, start, end, pay, clean(input.duties, 600), clean(input.cancellationTerms, 600), nowIso(), shift.id);
    audit(auth.id, "edit_shift", "shift", shift.id, "Edited before worker invitations were sent.");
    return ok({ shift: db.prepare("SELECT * FROM shifts WHERE id=?").get(shift.id) });
  }

  if (method === "POST" && path.join("/") === "hotel/support") {
    const auth = requireUser(request, ["hotel_manager"]);
    if (auth instanceof Response) return auth;
    const category = clean(input.category, 60);
    const description = clean(input.description, 1200);
    if (!category || !description) return fail("Choose an issue type and describe the issue.");
    const requestId = id();
    const at = nowIso();
    db.prepare("INSERT INTO support_requests(id,hotel_id,user_id,category,description,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)")
      .run(requestId, auth.hotel_id, auth.id, category, description, at, at);
    audit(auth.id, "open_support_request", "support_request", requestId);
    return ok({ ok: true, id: requestId }, 201);
  }

  if (method === "GET" && path[0] === "shifts" && path[2] === "matches" && path.length === 3) {
    const auth = requireUser(request, ["hotel_manager", "admin"]);
    if (auth instanceof Response) return auth;
    const shift = ownShift(path[1], auth);
    if (!shift) return fail("Shift not found.", 404);
    const already = new Set((db.prepare("SELECT worker_id FROM invitations WHERE shift_id=?").all(shift.id) as Row[]).map((row) => row.worker_id));
    const matches = eligibleWorkers(shift).filter((worker) => !already.has(worker.id));
    const invitations = db.prepare("SELECT i.*,w.name AS worker_name,w.area AS worker_area FROM invitations i JOIN workers w ON w.id=i.worker_id WHERE i.shift_id=? ORDER BY i.batch_no,i.sent_at").all(shift.id);
    const assignments = db.prepare("SELECT a.*,w.name AS worker_name,w.phone AS worker_phone FROM assignments a JOIN workers w ON w.id=a.worker_id WHERE a.shift_id=? ORDER BY a.created_at").all(shift.id);
    return ok({ matches, invitations, assignments, shift });
  }

  if (method === "POST" && path[0] === "shifts" && path[2] === "invite" && path.length === 3) {
    const auth = requireUser(request, ["hotel_manager", "admin"]);
    if (auth instanceof Response) return auth;
    const shift = ownShift(path[1], auth);
    if (!shift) return fail("Shift not found.", 404);
    if (["cancelled", "filled", "completed"].includes(shift.status)) return fail("This shift is no longer accepting invitations.", 409);
    const already = new Set((db.prepare("SELECT worker_id FROM invitations WHERE shift_id=?").all(shift.id) as Row[]).map((row) => row.worker_id));
    const matches = eligibleWorkers(shift).filter((worker) => !already.has(worker.id));
    const multiplier = Math.max(1, Math.min(5, numeric(getSetting("batch_multiplier", "2"), 2)));
    const batchSize = Math.max(Number(shift.headcount), Math.ceil(Number(shift.headcount) * multiplier));
    const batchNo = Number((db.prepare("SELECT COALESCE(MAX(batch_no),0) AS n FROM invitations WHERE shift_id=?").get(shift.id) as Row).n) + 1;
    const selected = matches.slice(0, batchSize);
    const insert = db.prepare("INSERT INTO invitations(id,shift_id,worker_id,status,batch_no,sent_at) VALUES(?,?,?,'invited',?,?)");
    for (const worker of selected) {
      const invitationId = id();
      insert.run(invitationId, shift.id, worker.id, batchNo, nowIso());
      const openSlots = Math.max(0, Number(shift.headcount) - Number((db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE shift_id=? AND status NOT IN ('cancelled','cancelled_late','no_show')").get(shift.id) as Row).n));
      const distanceLabel = worker.distance_km == null ? "area match" : `about ${Number(worker.distance_km).toFixed(1)} km away`;
      enqueueWhatsApp(worker.id, shift.id, `${shift.hotel_name}: ${shift.role}, ${shift.shift_date} ${shift.start_time}–${shift.end_time}. Pay ₹${Number(shift.pay_amount).toFixed(0)} per shift. ${shift.area}, ${shift.city} (${distanceLabel}). ${shift.duties || "Temporary hospitality shift."} Openings: ${openSlots}. Reply Interested or Unavailable by ${new Date(shift.response_deadline).toLocaleString()}. Simulated only; no real WhatsApp sent.`);
    }
    db.prepare("UPDATE shifts SET status=?,updated_at=? WHERE id=?").run(selected.length ? "inviting_workers" : "open", nowIso(), shift.id);
    audit(auth.id, "invite_workers", "shift", shift.id, `${selected.length} simulated invitation(s), batch ${batchNo}`);
    return ok({ invited: selected.length, batchNo, batchSize, remainingMatches: Math.max(0, matches.length - selected.length), sandbox: true });
  }

  if (method === "POST" && path[0] === "shifts" && path[2] === "confirm" && path.length === 3) {
    const auth = requireUser(request, ["hotel_manager", "admin"]);
    if (auth instanceof Response) return auth;
    const shift = ownShift(path[1], auth);
    if (!shift) return fail("Shift not found.", 404);
    const workerIds = Array.isArray(input.workerIds) ? input.workerIds.map(String) : [];
    if (!workerIds.length) return fail("Select at least one interested worker.");
    const currentCount = Number((db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE shift_id=? AND status NOT IN ('cancelled','cancelled_late','no_show')").get(shift.id) as Row).n);
    if (currentCount + workerIds.length > Number(shift.headcount)) return fail("Selecting these workers would exceed the shift headcount.", 409);
    const confirmed: string[] = [];
    const makeAssignment = db.prepare("INSERT INTO assignments(id,shift_id,worker_id,status,start_code,end_code,scheduled_hours,created_at) VALUES(?,?,?,'confirmed',?,?,?,?)");
    for (const workerId of workerIds) {
      const invitation = db.prepare("SELECT id FROM invitations WHERE shift_id=? AND worker_id=? AND status='interested'").get(shift.id, workerId) as Row | undefined;
      if (!invitation) continue;
      const assignmentId = id();
      const startCode = String(randomInt(100000, 1_000_000));
      let endCode = String(randomInt(100000, 1_000_000));
      while (endCode === startCode) endCode = String(randomInt(100000, 1_000_000));
      makeAssignment.run(assignmentId, shift.id, workerId, startCode, endCode, hoursBetween(shift.start_time, shift.end_time), nowIso());
      db.prepare("UPDATE invitations SET status='selected' WHERE id=?").run(invitation.id);
      const worker = db.prepare("SELECT name FROM workers WHERE id=?").get(workerId) as Row;
      enqueueWhatsApp(workerId, shift.id, `Your ${shift.role} shift at ${shift.hotel_name} on ${shift.shift_date} is confirmed. Start and end check-in codes will be provided by the hotel manager. Sandbox message.`);
      confirmed.push(worker.name);
    }
    const total = currentCount + confirmed.length;
    const status = total >= Number(shift.headcount) ? "filled" : "awaiting_hotel_selection";
    db.prepare("UPDATE shifts SET status=?,updated_at=? WHERE id=?").run(status, nowIso(), shift.id);
    if (status === "filled") db.prepare("UPDATE invitations SET status='waitlisted' WHERE shift_id=? AND status='interested'").run(shift.id);
    audit(auth.id, "confirm_workers", "shift", shift.id, `${confirmed.length} worker(s)`);
    return ok({ confirmed, status });
  }

  if (method === "POST" && path[0] === "shifts" && path[2] === "cancel" && path.length === 3) {
    const auth = requireUser(request, ["hotel_manager", "admin"]);
    if (auth instanceof Response) return auth;
    const shift = ownShift(path[1], auth);
    if (!shift) return fail("Shift not found.", 404);
    if (["completed", "cancelled"].includes(shift.status)) return fail("This shift is already closed.", 409);
    const hoursToStart = (shiftStartInstant(shift.shift_date, shift.start_time) - Date.now()) / 3_600_000;
    const isLate = hoursToStart < numeric(getSetting("cancellation_window_hours", "24"));
    const assignments = db.prepare("SELECT a.*,w.name AS worker_name FROM assignments a JOIN workers w ON w.id=a.worker_id WHERE a.shift_id=? AND a.status NOT IN ('cancelled','cancelled_late','no_show','completed')").all(shift.id) as Row[];
    db.prepare("UPDATE shifts SET status='cancelled',updated_at=? WHERE id=?").run(nowIso(), shift.id);
    db.prepare("UPDATE invitations SET status='cancelled' WHERE shift_id=? AND status IN ('invited','interested','waitlisted')").run(shift.id);
    for (const assignment of assignments) {
      const compensation = isLate ? Number(shift.pay_amount) * numeric(getSetting("late_cancel_compensation_percent", "50")) / 100 : 0;
      db.prepare("UPDATE assignments SET status=?,final_pay=? WHERE id=?").run(isLate ? "cancelled_late" : "cancelled", compensation, assignment.id);
      enqueueWhatsApp(assignment.worker_id, shift.id, `The ${shift.role} shift on ${shift.shift_date} has been cancelled by the hotel.${isLate ? ` The agreed late-cancellation compensation review is ${compensation.toFixed(0)}.` : ""} Sandbox message.`);
      if (isLate && compensation > 0) {
        const disputeId = id();
        const at = nowIso();
        db.prepare("INSERT INTO disputes(id,assignment_id,reported_by,category,description,status,created_at,updated_at) VALUES(?,?,?,'late_cancellation',?,'open',?,?)")
          .run(disputeId, assignment.id, auth.name, `Late hotel cancellation. Agreed worker compensation of ₹${compensation.toFixed(2)} is pending pilot review.`, at, at);
      }
    }
    audit(auth.id, "cancel_shift", "shift", shift.id, isLate ? "Late hotel cancellation; compensation review required." : "Hotel cancelled shift.");
    return ok({ ok: true, late: isLate, affectedWorkers: assignments.length });
  }

  if (method === "POST" && path[0] === "sandbox" && path[1] === "invitations" && path[3] === "reply" && path.length === 4) {
    if (!sandbox()) return fail("Sandbox actions are disabled.", 404);
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const status = input.status === "interested" ? "interested" : "unavailable";
    const invitation = db.prepare("SELECT i.*,w.name AS worker_name FROM invitations i JOIN workers w ON w.id=i.worker_id WHERE i.id=?").get(path[2]) as Row | undefined;
    if (!invitation || invitation.status !== "invited") return fail("Invitation is no longer awaiting a reply.", 404);
    const inviteShift = db.prepare("SELECT response_deadline FROM shifts WHERE id=?").get(invitation.shift_id) as Row | undefined;
    if (inviteShift && new Date(inviteShift.response_deadline).getTime() < Date.now()) {
      db.prepare("UPDATE invitations SET status='expired',responded_at=? WHERE id=?").run(nowIso(), invitation.id);
      audit(auth.id, "expire_invitation", "invitation", invitation.id, "Reply window closed before a worker response.");
      return fail("This reply window has closed. Invite the next worker batch if positions remain.", 409);
    }
    db.prepare("UPDATE invitations SET status=?,responded_at=? WHERE id=?").run(status, nowIso(), invitation.id);
    logWorkerReply(invitation.worker_id, invitation.shift_id, `${invitation.worker_name} replied: ${status}`);
    audit(auth.id, "simulate_worker_reply", "invitation", invitation.id, `Admin sandbox simulated worker response: ${status}.`);
    const shift = db.prepare("SELECT status FROM shifts WHERE id=?").get(invitation.shift_id) as Row;
    if (status === "interested") db.prepare("UPDATE shifts SET status='awaiting_hotel_selection',updated_at=? WHERE id=?").run(nowIso(), invitation.shift_id);
    return ok({ ok: true, status: status === "interested" ? "awaiting_hotel_selection" : shift.status });
  }

  if (method === "POST" && path[0] === "sandbox" && path[1] === "workers" && path.length === 2) {
    if (!sandbox()) return fail("Sandbox actions are disabled.", 404);
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const name = clean(input.name, 120);
    const phone = clean(input.phone, 40);
    const city = clean(input.city, 100) || getSetting("pilot_area", "Pilot Area");
    const area = clean(input.area, 100);
    const roles = Array.isArray(input.roles) ? input.roles.map((v: unknown) => clean(v, 80)).filter(Boolean) : clean(input.roles, 300).split(",").map((v) => v.trim()).filter(Boolean);
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    if (!name || !phone || !area || !roles.length || String(input.latitude ?? "").trim() === "" || String(input.longitude ?? "").trim() === "" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return fail("Enter worker name, phone, area, valid approximate coordinates, and at least one role.");
    const workerId = id();
    try {
      db.prepare("INSERT INTO workers(id,name,phone,city,area,latitude,longitude,radius_km,roles_json,skills_json,availability_json,language,verified,active,opted_in,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(workerId, name, phone, city, area, latitude, longitude, Math.max(1, numeric(input.radiusKm, 10)), JSON.stringify(roles), JSON.stringify(Array.isArray(input.skills) ? input.skills : clean(input.skills, 300).split(",").map((v) => v.trim()).filter(Boolean)), JSON.stringify(Array.isArray(input.availability) ? input.availability : (clean(input.availability, 300).split(",").map((v) => v.trim()).filter(Boolean).length ? clean(input.availability, 300).split(",").map((v) => v.trim()).filter(Boolean) : ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"])), clean(input.language, 40) || "Hindi", 0, 1, input.optedIn === true ? 1 : 0, nowIso());
    } catch { return fail("That phone number is already registered.", 409); }
    audit(auth.id, "register_worker_sandbox", "worker", workerId, "Created in WhatsApp registration simulator.");
    return ok({ worker: db.prepare("SELECT * FROM workers WHERE id=?").get(workerId) }, 201);
  }

  if (method === "POST" && path[0] === "sandbox" && path[1] === "assignments" && path[3] === "attendance" && path.length === 4) {
    if (!sandbox()) return fail("Sandbox actions are disabled.", 404);
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const assignment = ownAssignment(path[2], auth);
    if (!assignment) return fail("Assignment not found.", 404);
    const action = input.action === "check_out" ? "check_out" : "check_in";
    const expectedCode = action === "check_in" ? assignment.start_code : assignment.end_code;
    if (String(input.code ?? "") !== expectedCode) return fail("That attendance code is not valid.", 400);
    if (action === "check_in") {
      if (assignment.checked_in_at) return fail("This worker is already checked in.", 409);
      db.prepare("UPDATE assignments SET checked_in_at=?,status='checked_in' WHERE id=?").run(nowIso(), assignment.id);
      db.prepare("UPDATE shifts SET status='in_progress',updated_at=? WHERE id=?").run(nowIso(), assignment.shift_id);
      enqueueWhatsApp(assignment.worker_id, assignment.shift_id, `Sandbox check-in recorded for ${assignment.role}.`);
      audit(auth.id, "simulate_worker_check_in", "assignment", assignment.id, "Attendance recorded in sandbox.");
      return ok({ ok: true, status: "checked_in" });
    }
    if (!assignment.checked_in_at || assignment.checked_out_at) return fail("Check-in is required before check-out, and check-out can happen only once.", 409);
    const hours = Math.round(Math.max(0.25, Math.min(24, (Date.now() - new Date(assignment.checked_in_at).getTime()) / 3_600_000)) * 100) / 100;
    const overtime = overtimeFor(assignment, hours);
    db.prepare("UPDATE assignments SET checked_out_at=?,hours=?,overtime_hours=?,overtime_pay=?,status='attendance_review' WHERE id=?").run(nowIso(), hours, overtime.overtimeHours, overtime.overtimePay, assignment.id);
    const stillWorking = Number((db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE shift_id=? AND status NOT IN ('cancelled','cancelled_late','no_show') AND checked_out_at IS NULL").get(assignment.shift_id) as Row).n);
    db.prepare("UPDATE shifts SET status=?,updated_at=? WHERE id=?").run(stillWorking ? "in_progress" : "attendance_review", nowIso(), assignment.shift_id);
    enqueueWhatsApp(assignment.worker_id, assignment.shift_id, `Sandbox check-out recorded. Hotel will review ${hours} hours${overtime.overtimeHours ? ` including ${overtime.overtimeHours} overtime hours` : ""} and pay.`);
    audit(auth.id, "simulate_worker_check_out", "assignment", assignment.id, `Attendance recorded in sandbox; ${hours} hours, including ${overtime.overtimeHours} overtime hours.`);
    return ok({ ok: true, hours, overtimeHours: overtime.overtimeHours, overtimePay: overtime.overtimePay, status: "attendance_review" });
  }

  if (method === "POST" && path[0] === "admin" && path[1] === "assignments" && path[3] === "manual-attendance" && path.length === 4) {
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const assignment = ownAssignment(path[2], auth);
    if (!assignment) return fail("Assignment not found.", 404);
    const reason = clean(input.reason, 500);
    const action = input.action === "check_out" ? "check_out" : "check_in";
    if (!reason) return fail("Add the reason for recording attendance manually.");
    if (action === "check_in") {
      if (assignment.checked_in_at) return fail("This worker is already checked in.", 409);
      db.prepare("UPDATE assignments SET checked_in_at=?,status='checked_in' WHERE id=?").run(nowIso(), assignment.id);
      db.prepare("UPDATE shifts SET status='in_progress',updated_at=? WHERE id=?").run(nowIso(), assignment.shift_id);
      audit(auth.id, "manual_check_in", "assignment", assignment.id, reason);
      return ok({ ok: true, status: "checked_in" });
    }
    if (!assignment.checked_in_at || assignment.checked_out_at) return fail("A valid check-in is required before recording a check-out.", 409);
    const hours = Math.round(Math.max(0.25, Math.min(24, (Date.now() - new Date(assignment.checked_in_at).getTime()) / 3_600_000)) * 100) / 100;
    const overtime = overtimeFor(assignment, hours);
    const at = nowIso();
    db.prepare("UPDATE assignments SET checked_out_at=?,hours=?,overtime_hours=?,overtime_pay=?,status='attendance_review' WHERE id=?").run(at, hours, overtime.overtimeHours, overtime.overtimePay, assignment.id);
    const stillWorking = Number((db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE shift_id=? AND status NOT IN ('cancelled','cancelled_late','no_show') AND checked_out_at IS NULL").get(assignment.shift_id) as Row).n);
    db.prepare("UPDATE shifts SET status=?,updated_at=? WHERE id=?").run(stillWorking ? "in_progress" : "attendance_review", at, assignment.shift_id);
    audit(auth.id, "manual_check_out", "assignment", assignment.id, `${reason} Recorded ${hours} hours, including ${overtime.overtimeHours} overtime hours.`);
    return ok({ ok: true, hours, overtimeHours: overtime.overtimeHours, overtimePay: overtime.overtimePay, status: "attendance_review" });
  }

  if (method === "POST" && path[0] === "sandbox" && path[1] === "assignments" && path[3] === "confirm-hours" && path.length === 4) {
    if (!sandbox()) return fail("Sandbox actions are disabled.", 404);
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const assignment = ownAssignment(path[2], auth);
    if (!assignment || !assignment.hours_approved) return fail("The hotel must approve hours before the worker can confirm them.", 409);
    db.prepare("UPDATE assignments SET worker_hours_confirmed=1,status='payment_pending' WHERE id=?").run(assignment.id);
    logWorkerReply(assignment.worker_id, assignment.shift_id, `${assignment.worker_name} confirmed ${assignment.hours} recorded hours, including ${assignment.overtime_hours} overtime hours, and total pay ₹${Number(assignment.final_pay).toFixed(2)}.`);
    return ok({ ok: true, status: "payment_pending" });
  }

  if (method === "POST" && path[0] === "sandbox" && path[1] === "assignments" && path[3] === "no-show-response" && path.length === 4) {
    if (!sandbox()) return fail("Sandbox actions are disabled.", 404);
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const assignment = ownAssignment(path[2], auth);
    if (!assignment || !["no_show_review", "no_show_response_attended", "no_show_response_confirmed"].includes(assignment.status)) return fail("This assignment is not awaiting a no-show response.", 409);
    const response = input.response === "attended" ? "attended" : "confirms_absence";
    const message = response === "attended" ? `${assignment.worker_name} says they attended and wants the hotel to review their attendance.` : `${assignment.worker_name} confirms they could not attend the shift.`;
    const dispute = db.prepare("SELECT id FROM disputes WHERE assignment_id=? AND category='no_show' AND status='open' ORDER BY created_at DESC LIMIT 1").get(assignment.id) as Row | undefined;
    if (!dispute) return fail("Open no-show review not found.", 404);
    db.prepare("UPDATE disputes SET description=description || ?,updated_at=? WHERE id=?").run(`\nWorker response: ${message}`, nowIso(), dispute.id);
    db.prepare("UPDATE assignments SET status=? WHERE id=?").run(response === "attended" ? "no_show_response_attended" : "no_show_response_confirmed", assignment.id);
    logWorkerReply(assignment.worker_id, assignment.shift_id, message);
    audit(auth.id, "simulate_no_show_worker_response", "dispute", dispute.id, response);
    return ok({ ok: true, response });
  }

  if (method === "POST" && path[0] === "assignments" && path[2] === "approve-hours" && path.length === 3) {
    const auth = requireUser(request, ["hotel_manager", "admin"]);
    if (auth instanceof Response) return auth;
    const assignment = ownAssignment(path[1], auth);
    if (!assignment) return fail("Assignment not found.", 404);
    if (!assignment.checked_out_at) return fail("The worker must check out before hours can be approved.", 409);
    const hours = numeric(input.hours, Number(assignment.hours));
    const overtime = overtimeFor(assignment, hours);
    const minimumPay = Number(assignment.pay_amount) + overtime.overtimePay;
    const finalPay = numeric(input.finalPay, minimumPay);
    if (hours <= 0 || hours > 24 || finalPay < 0) return fail("Enter valid hours and final pay.");
    if (finalPay + 0.005 < minimumPay) return fail(`Recorded overtime requires at least ₹${minimumPay.toFixed(2)} total pay.`, 409);
    db.prepare("UPDATE assignments SET hours=?,overtime_hours=?,overtime_pay=?,final_pay=?,hours_approved=1,status=? WHERE id=?")
      .run(hours, overtime.overtimeHours, overtime.overtimePay, finalPay, assignment.worker_hours_confirmed ? "payment_pending" : "attendance_review", assignment.id);
    enqueueWhatsApp(assignment.worker_id, assignment.shift_id, `Please confirm ${hours} recorded hours${overtime.overtimeHours ? `, including ${overtime.overtimeHours} overtime hours (₹${overtime.overtimePay.toFixed(2)} extra)` : ""}, and total pay of ₹${finalPay.toFixed(2)} for ${assignment.role}. Simulated only.`);
    audit(auth.id, "approve_hours", "assignment", assignment.id, `Hours ${hours}; overtime ${overtime.overtimeHours}; final pay ${finalPay}.`);
    return ok({ ok: true, hours, overtimeHours: overtime.overtimeHours, overtimePay: overtime.overtimePay, finalPay, workerConfirmationRequired: !assignment.worker_hours_confirmed });
  }

  if (method === "POST" && path[0] === "assignments" && path[2] === "payment" && path.length === 3) {
    const auth = requireUser(request, ["hotel_manager", "admin"]);
    if (auth instanceof Response) return auth;
    const assignment = ownAssignment(path[1], auth);
    if (!assignment) return fail("Assignment not found.", 404);
    if (!assignment.hours_approved || !assignment.worker_hours_confirmed) return fail("Both the hotel and worker must confirm hours before payment.", 409);
    let payment = db.prepare("SELECT * FROM payments WHERE assignment_id=?").get(assignment.id) as Row | undefined;
    const expiresAt = payment?.expires_at ? new Date(payment.expires_at).getTime() : Number.NaN;
    if (!payment || (payment.collection_status === "qr_ready" && (!Number.isFinite(expiresAt) || expiresAt <= Date.now()))) {
      const workerPay = Number(assignment.final_pay ?? assignment.pay_amount);
      const fee = Math.round(workerPay * Number(assignment.platform_fee_rate) * 100) / 100;
      const paymentId = payment?.id || id();
      const qrExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const payload = makeSandboxPaymentPayload(paymentId, workerPay + fee, qrExpiresAt);
      const at = nowIso();
      if (payment) {
        db.prepare("UPDATE payments SET worker_pay=?,overtime_pay=?,platform_fee=?,total_amount=?,qr_payload=?,expires_at=?,updated_at=? WHERE id=?")
          .run(workerPay, Number(assignment.overtime_pay || 0), fee, workerPay + fee, payload, qrExpiresAt, at, paymentId);
      } else {
        db.prepare("INSERT INTO payments(id,shift_id,assignment_id,worker_pay,overtime_pay,platform_fee,total_amount,collection_status,payout_status,qr_payload,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'qr_ready','not_started',?,?,?,?)")
          .run(paymentId, assignment.shift_id, assignment.id, workerPay, Number(assignment.overtime_pay || 0), fee, workerPay + fee, payload, qrExpiresAt, at, at);
      }
      payment = db.prepare("SELECT * FROM payments WHERE id=?").get(paymentId) as Row;
    }
    db.prepare("UPDATE shifts SET status='payment_pending',updated_at=? WHERE id=?").run(nowIso(), assignment.shift_id);
    audit(auth.id, "create_payment_request", "payment", payment.id, "Shift-specific sandbox QR created.");
    return ok({ payment, sandbox: true });
  }

  if (method === "POST" && path[0] === "payments" && path[2] === "sandbox-success" && path.length === 3) {
    if (!sandbox()) return fail("Sandbox actions are disabled.", 404);
    const auth = requireUser(request, ["admin", "hotel_manager"]);
    if (auth instanceof Response) return auth;
    const payment = db.prepare("SELECT * FROM payments WHERE id=?").get(path[1]) as Row | undefined;
    if (!payment) return fail("Payment not found.", 404);
    const assignment = ownAssignment(payment.assignment_id, auth);
    if (!assignment) return fail("Payment not found.", 404);
    if (payment.collection_status === "received") return ok({ ok: true, alreadyReceived: true });
    const qrExpiry = payment.expires_at ? new Date(payment.expires_at).getTime() : Number.NaN;
    if (!Number.isFinite(qrExpiry) || qrExpiry <= Date.now()) return fail("This payment QR has expired. Create a refreshed QR from the shift details.", 410);
    db.prepare("UPDATE payments SET collection_status='received',payout_status='paid',provider_ref=?,updated_at=? WHERE id=?")
      .run(`sandbox_${payment.id.slice(0, 8)}`, nowIso(), payment.id);
    db.prepare("UPDATE assignments SET status='completed' WHERE id=?").run(payment.assignment_id);
    db.prepare("UPDATE workers SET completed_shifts=completed_shifts+1 WHERE id=(SELECT worker_id FROM assignments WHERE id=?)").run(payment.assignment_id);
    const remaining = Number((db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE shift_id=? AND status!='completed' AND status NOT IN ('cancelled','cancelled_late','no_show')").get(payment.shift_id) as Row).n);
    const assigned = Number((db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE shift_id=? AND status NOT IN ('cancelled','cancelled_late','no_show')").get(payment.shift_id) as Row).n);
    if (!remaining && assigned >= Number((db.prepare("SELECT headcount FROM shifts WHERE id=?").get(payment.shift_id) as Row).headcount)) db.prepare("UPDATE shifts SET status='completed',updated_at=? WHERE id=?").run(nowIso(), payment.shift_id);
    else if (!remaining) db.prepare("UPDATE shifts SET status='awaiting_hotel_selection',updated_at=? WHERE id=?").run(nowIso(), payment.shift_id);
    const paidAssignment = db.prepare("SELECT worker_id,shift_id FROM assignments WHERE id=?").get(payment.assignment_id) as Row;
    enqueueWhatsApp(paidAssignment.worker_id, paidAssignment.shift_id, `Sandbox payout of ${Number(payment.worker_pay).toFixed(2)} is marked complete. No real money moved.`);
    audit(auth.id, "sandbox_payment_complete", "payment", payment.id, "Simulated collection and worker payout.");
    return ok({ ok: true, collectionStatus: "received", payoutStatus: "paid", sandbox: true });
  }

  if (method === "POST" && path.join("/") === "assignments/disputes") {
    const auth = requireUser(request, ["hotel_manager"]);
    if (auth instanceof Response) return auth;
    const assignmentId = clean(input.assignmentId, 80);
    const assignment = ownAssignment(assignmentId, auth);
    if (!assignment) return fail("Assignment not found.", 404);
    const category = clean(input.category, 60);
    const description = clean(input.description, 1000);
    if (!category || !description) return fail("Choose a category and describe the issue.");
    const disputeId = id();
    const at = nowIso();
    db.prepare("INSERT INTO disputes(id,assignment_id,reported_by,category,description,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)")
      .run(disputeId, assignment.id, auth.name, category, description, at, at);
    audit(auth.id, "open_dispute", "dispute", disputeId);
    return ok({ ok: true, id: disputeId }, 201);
  }

  if (method === "POST" && path[0] === "assignments" && path[2] === "no-show" && path.length === 3) {
    const auth = requireUser(request, ["hotel_manager"]);
    if (auth instanceof Response) return auth;
    const assignment = ownAssignment(path[1], auth);
    if (!assignment) return fail("Assignment not found.", 404);
    if (assignment.checked_in_at || assignment.status !== "confirmed") return fail("Only an unreported, not-yet-checked-in assignment can be reported as a possible no-show.", 409);
    const shiftStart = shiftStartInstant(assignment.shift_date, assignment.start_time);
    if (Date.now() < shiftStart) return fail("You can report a no-show only after the shift has started.", 409);
    const disputeId = id();
    const at = nowIso();
    const description = clean(input.description, 1000) || "Hotel reports that the worker has not arrived. Worker response is required before a no-show decision.";
    db.prepare("INSERT INTO disputes(id,assignment_id,reported_by,category,description,status,created_at,updated_at) VALUES(?,?,?,'no_show',?,'open',?,?)")
      .run(disputeId, assignment.id, auth.name, description, at, at);
    db.prepare("UPDATE assignments SET status='no_show_review' WHERE id=?").run(assignment.id);
    enqueueWhatsApp(assignment.worker_id, assignment.shift_id, `The hotel reports you have not arrived for your ${assignment.role} shift. Please contact the hotel or Hostshift pilot team to respond. No no-show decision is final yet. Simulated only.`);
    audit(auth.id, "report_possible_no_show", "assignment", assignment.id, "Worker response requested before any no-show decision.");
    return ok({ ok: true, disputeId }, 201);
  }

  if (method === "GET" && path.join("/") === "admin/overview") {
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const accessRequests = db.prepare("SELECT r.*,CASE WHEN u.id IS NULL THEN 0 ELSE 1 END AS manager_password_set FROM access_requests r LEFT JOIN users u ON u.email=r.email AND u.status='pending' AND u.hotel_id IS NULL ORDER BY r.created_at DESC LIMIT 100").all();
    const workers = db.prepare("SELECT * FROM workers ORDER BY verified,created_at DESC LIMIT 200").all() as Row[];
    const shifts = db.prepare("SELECT s.*,h.name AS hotel_name,(SELECT COUNT(*) FROM assignments a WHERE a.shift_id=s.id AND a.status NOT IN ('cancelled','cancelled_late','no_show')) AS assigned_count FROM shifts s JOIN hotels h ON h.id=s.hotel_id ORDER BY s.created_at DESC LIMIT 100").all();
    const disputes = db.prepare("SELECT d.*,w.name AS worker_name,s.role,s.shift_date,h.name AS hotel_name FROM disputes d JOIN assignments a ON a.id=d.assignment_id JOIN workers w ON w.id=a.worker_id JOIN shifts s ON s.id=a.shift_id JOIN hotels h ON h.id=s.hotel_id ORDER BY d.created_at DESC LIMIT 100").all();
    const messages = db.prepare("SELECT m.*,w.name AS worker_name FROM messages m LEFT JOIN workers w ON w.id=m.worker_id ORDER BY m.created_at DESC LIMIT 100").all();
    const payments = db.prepare("SELECT p.*,w.name AS worker_name,s.role,s.shift_date,h.name AS hotel_name FROM payments p JOIN assignments a ON a.id=p.assignment_id JOIN workers w ON w.id=a.worker_id JOIN shifts s ON s.id=p.shift_id JOIN hotels h ON h.id=s.hotel_id ORDER BY p.created_at DESC LIMIT 100").all();
    const invitations = db.prepare("SELECT i.*,w.name AS worker_name,w.area AS worker_area,s.role,s.shift_date,s.start_time,s.end_time,h.name AS hotel_name FROM invitations i JOIN workers w ON w.id=i.worker_id JOIN shifts s ON s.id=i.shift_id JOIN hotels h ON h.id=s.hotel_id ORDER BY i.sent_at DESC LIMIT 200").all();
    const assignments = db.prepare("SELECT a.*,w.name AS worker_name,w.phone AS worker_phone,s.role,s.shift_date,s.start_time,s.end_time,s.pay_amount,h.name AS hotel_name FROM assignments a JOIN workers w ON w.id=a.worker_id JOIN shifts s ON s.id=a.shift_id JOIN hotels h ON h.id=s.hotel_id ORDER BY a.created_at DESC LIMIT 200").all();
    const supportRequests = db.prepare("SELECT r.*,h.name AS hotel_name,u.name AS manager_name FROM support_requests r JOIN hotels h ON h.id=r.hotel_id JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 100").all();
    const auditLogs = db.prepare("SELECT l.*,u.name AS actor_name FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_user_id ORDER BY l.created_at DESC LIMIT 200").all();
    const settings = db.prepare("SELECT key,value FROM settings ORDER BY key").all();
    return ok({ accessRequests, workers: workers.map((worker) => ({ ...worker, roles: parseJson(worker.roles_json, []), skills: parseJson(worker.skills_json, []), availability: parseJson(worker.availability_json, []) })), shifts, disputes, messages, payments, invitations, assignments, supportRequests, auditLogs, settings });
  }

  if (method === "POST" && path[0] === "admin" && path[1] === "access-requests" && path[3] === "approve" && path.length === 4) {
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const requestRow = db.prepare("SELECT * FROM access_requests WHERE id=? AND status='pending'").get(path[2]) as Row | undefined;
    if (!requestRow) return fail("This request is not pending.", 404);
    const existingManager = db.prepare("SELECT * FROM users WHERE email=?").get(requestRow.email) as Row | undefined;
    const managerSetPassword = existingManager?.role === "hotel_manager" && existingManager.status === "pending" && existingManager.hotel_id == null;
    if (existingManager && !managerSetPassword) return fail("A user already has this email. Review that account before approval.", 409);
    const hotelId = id();
    const userId = managerSetPassword ? existingManager!.id : id();
    const at = nowIso();
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    if (String(input.latitude ?? "").trim() === "" || String(input.longitude ?? "").trim() === "" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return fail("Enter valid approximate hotel coordinates before approving.");
    let legacyCredentials: { salt: string; hash: string } | null = null;
    if (!managerSetPassword) legacyCredentials = passwordParts(`Invite-${id().slice(0, 8)}!`);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO hotels(id,name,city,area,address,latitude,longitude,status,manager_name,contact_email,created_at) VALUES(?,?,?,?,?,?,?,'approved',?,?,?)")
        .run(hotelId, requestRow.hotel_name, requestRow.city, requestRow.area, requestRow.address, latitude, longitude, requestRow.manager_name, requestRow.email, at);
      if (managerSetPassword) {
        db.prepare("UPDATE users SET name=?,hotel_id=?,status='active' WHERE id=? AND status='pending'")
          .run(requestRow.manager_name, hotelId, userId);
      } else {
        db.prepare("INSERT INTO users(id,email,name,role,hotel_id,password_hash,password_salt,status,created_at) VALUES(?,?,?,'hotel_manager',?,?,?,'active',?)")
          .run(userId, requestRow.email, requestRow.manager_name, hotelId, legacyCredentials!.hash, legacyCredentials!.salt, at);
      }
      db.prepare("UPDATE access_requests SET status='approved',reviewed_at=?,reviewed_by=? WHERE id=? AND status='pending'").run(at, auth.id, requestRow.id);
      audit(auth.id, "approve_hotel", "hotel", hotelId, `Approved access request ${requestRow.id}.`);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no transaction remained open */ }
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return fail("A hotel or manager account already exists for this request.", 409);
      throw error;
    }
    if (managerSetPassword) return ok({ ok: true, hotelId, message: "Hotel approved. The manager can now sign in with the password they chose." });
    const resetToken = makeResetToken(userId);
    const inviteUrl = `/reset-password?token=${encodeURIComponent(resetToken)}`;
    return ok({ ok: true, hotelId, inviteUrl, message: "Legacy hotel request approved. Share the one-time password setup link with the manager." });
  }

  if (method === "POST" && path[0] === "admin" && path[1] === "access-requests" && path[3] === "reject" && path.length === 4) {
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const reason = clean(input.reason, 500);
    if (!reason) return fail("Add a reason for rejecting this hotel request.");
    const requestRow = db.prepare("SELECT email FROM access_requests WHERE id=? AND status='pending'").get(path[2]) as Row | undefined;
    if (!requestRow) return fail("Pending hotel request not found.", 404);
    const at = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db.prepare("UPDATE access_requests SET status='rejected',reviewed_at=?,reviewed_by=? WHERE id=? AND status='pending'").run(at, auth.id, path[2]);
      if (!result.changes) { db.exec("ROLLBACK"); return fail("Pending hotel request not found.", 404); }
      db.prepare("DELETE FROM users WHERE email=? AND role='hotel_manager' AND status='pending' AND hotel_id IS NULL").run(requestRow.email);
      audit(auth.id, "reject_hotel_request", "access_request", path[2], reason);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no transaction remained open */ }
      throw error;
    }
    return ok({ ok: true });
  }

  if (method === "POST" && path[0] === "admin" && path[1] === "workers" && path.length === 2) {
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const name = clean(input.name, 120);
    const phone = clean(input.phone, 40);
    const area = clean(input.area, 100);
    const city = clean(input.city, 100) || getSetting("pilot_area", "Pilot Area");
    const roles = Array.isArray(input.roles) ? input.roles.map((v: unknown) => clean(v, 80)).filter(Boolean) : clean(input.roles, 300).split(",").map((v) => v.trim()).filter(Boolean);
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    if (!name || !phone || !area || !roles.length || String(input.latitude ?? "").trim() === "" || String(input.longitude ?? "").trim() === "" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return fail("Enter worker name, phone, area, valid approximate coordinates, and one or more roles.");
    const workerId = id();
    try {
      db.prepare("INSERT INTO workers(id,name,phone,city,area,latitude,longitude,radius_km,roles_json,skills_json,availability_json,language,verified,active,opted_in,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(workerId, name, phone, city, area, latitude, longitude, Math.max(1, numeric(input.radiusKm, 10)), JSON.stringify(roles), JSON.stringify(Array.isArray(input.skills) ? input.skills : clean(input.skills, 300).split(",").map((v) => v.trim()).filter(Boolean)), JSON.stringify(Array.isArray(input.availability) ? input.availability : (clean(input.availability, 300).split(",").map((v) => v.trim()).filter(Boolean).length ? clean(input.availability, 300).split(",").map((v) => v.trim()).filter(Boolean) : ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"])), clean(input.language, 40) || "Hindi", input.verified ? 1 : 0, 1, input.optedIn === false ? 0 : 1, nowIso());
    } catch { return fail("That phone number is already registered.", 409); }
    audit(auth.id, "create_worker", "worker", workerId, input.verified ? "Manually verified during pilot." : "Created pending verification.");
    return ok({ worker: db.prepare("SELECT * FROM workers WHERE id=?").get(workerId) }, 201);
  }

  if (method === "PATCH" && path[0] === "admin" && path[1] === "workers" && path.length === 3) {
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const worker = db.prepare("SELECT id FROM workers WHERE id=?").get(path[2]);
    if (!worker) return fail("Worker not found.", 404);
    const updates: string[] = [];
    const values: Array<string | number> = [];
    for (const key of ["verified", "active", "opted_in"] as const) {
      if (input[key] !== undefined) { updates.push(`${key}=?`); values.push(input[key] ? 1 : 0); }
    }
    if (!updates.length) return fail("No worker status changes provided.");
    values.push(path[2]);
    db.prepare(`UPDATE workers SET ${updates.join(",")} WHERE id=?`).run(...values);
    audit(auth.id, "update_worker_status", "worker", path[2], clean(input.reason, 300));
    return ok({ worker: db.prepare("SELECT * FROM workers WHERE id=?").get(path[2]) });
  }

  if (method === "POST" && path[0] === "admin" && path[1] === "disputes" && path[3] === "resolve" && path.length === 4) {
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const decision = clean(input.decision, 60);
    const reason = clean(input.reason, 1000);
    if (!decision || !reason) return fail("Provide a decision and reason.");
    const result = db.prepare("UPDATE disputes SET status='resolved',decision=?,reason=?,updated_at=? WHERE id=? AND status='open'").run(decision, reason, nowIso(), path[2]);
    if (!result.changes) return fail("Open dispute not found.", 404);
    if (decision === "confirmed_no_show" || decision === "worker_attendance_reported") {
      const dispute = db.prepare("SELECT d.assignment_id,d.category,a.shift_id FROM disputes d JOIN assignments a ON a.id=d.assignment_id WHERE d.id=?").get(path[2]) as Row | undefined;
      if (dispute?.category === "no_show") {
        db.prepare("UPDATE assignments SET status=? WHERE id=?").run(decision === "confirmed_no_show" ? "no_show" : "confirmed", dispute.assignment_id);
        if (decision === "confirmed_no_show") db.prepare("UPDATE shifts SET status='awaiting_hotel_selection',updated_at=? WHERE id=? AND status NOT IN ('cancelled','completed')").run(nowIso(), dispute.shift_id);
      }
    }
    audit(auth.id, "resolve_dispute", "dispute", path[2], `${decision}: ${reason}`);
    return ok({ ok: true });
  }

  if (method === "POST" && path[0] === "admin" && path[1] === "support" && path[3] === "resolve" && path.length === 4) {
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const resolution = clean(input.reason, 1000);
    if (!resolution) return fail("Add a short resolution note.");
    const result = db.prepare("UPDATE support_requests SET status='resolved',resolution=?,updated_at=? WHERE id=? AND status='open'").run(resolution, nowIso(), path[2]);
    if (!result.changes) return fail("Open support request not found.", 404);
    audit(auth.id, "resolve_support_request", "support_request", path[2], resolution);
    return ok({ ok: true });
  }

  if (method === "POST" && path.join("/") === "admin/settings") {
    const auth = requireUser(request, ["admin"]);
    if (auth instanceof Response) return auth;
    const allowed = ["pilot_area", "batch_multiplier", "response_window_minutes", "cancellation_window_hours", "late_cancel_compensation_percent", "platform_fee_percent"];
    for (const key of allowed) {
      if (input[key] !== undefined) {
        const value = clean(input[key], 200);
        if (key !== "pilot_area" && (!Number.isFinite(Number(value)) || Number(value) < 0)) return fail(`Invalid value for ${key}.`);
        setSetting(key, value);
      }
    }
    if (input.supported_roles !== undefined && Array.isArray(input.supported_roles)) setSetting("supported_roles", JSON.stringify(input.supported_roles.map((v: unknown) => clean(v, 80)).filter(Boolean)));
    audit(auth.id, "update_pilot_settings", "settings", "pilot");
    return ok({ ok: true });
  }

  return fail("Route not found.", 404);
}

async function route(request: Request): Promise<Response> {
  try { return await handle(request); }
  catch (error) {
    console.error("Hostshift API error", error);
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return fail(message.includes("UNIQUE constraint") ? "That record already exists." : "The request could not be completed.", 500);
  }
}

export const GET = route;
export const POST = route;
export const PATCH = route;
