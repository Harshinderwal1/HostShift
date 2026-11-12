import { db, parseJson } from "@/lib/db";

type Row = Record<string, any>;

export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6371;
  const rad = (v: number) => (v * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function timeValue(date: string, time: string): number {
  return new Date(`${date}T${time}:00`).getTime();
}

function overlapsExisting(workerId: string, shift: Row): boolean {
  const existing = db.prepare(`
    SELECT s.shift_date,s.start_time,s.end_time
    FROM assignments a JOIN shifts s ON s.id=a.shift_id
    WHERE a.worker_id=? AND a.status NOT IN ('cancelled','cancelled_late','no_show')
  `).all(workerId) as Row[];
  let start = timeValue(shift.shift_date, shift.start_time);
  let end = timeValue(shift.shift_date, shift.end_time);
  if (end <= start) end += 24 * 60 * 60 * 1000;
  return existing.some((item) => {
    const otherStart = timeValue(item.shift_date, item.start_time);
    let otherEnd = timeValue(item.shift_date, item.end_time);
    if (otherEnd <= otherStart) otherEnd += 24 * 60 * 60 * 1000;
    return start < otherEnd && otherStart < end;
  });
}

export function eligibleWorkers(shift: Row): Row[] {
  const workers = db.prepare("SELECT * FROM workers WHERE verified=1 AND active=1 AND opted_in=1").all() as Row[];
  const requiredSkills = parseJson<string[]>(shift.skills_json, []).map((skill) => skill.toLowerCase());
  const date = new Date(`${shift.shift_date}T12:00:00`);
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  const result: Row[] = [];

  for (const worker of workers) {
    const roles = parseJson<string[]>(worker.roles_json, []);
    if (!roles.some((role) => role.toLowerCase() === shift.role.toLowerCase() || role.toLowerCase() === "all roles")) continue;
    const availability = parseJson<string[]>(worker.availability_json, []);
    if (availability.length > 0 && !availability.includes(day) && !availability.includes("All days")) continue;
    const skills = parseJson<string[]>(worker.skills_json, []).map((skill) => skill.toLowerCase());
    if (requiredSkills.length > 0 && !requiredSkills.every((skill) => skills.some((item) => item.includes(skill) || skill.includes(item)))) continue;
    const sameCity = String(worker.city).trim().toLowerCase() === String(shift.city).trim().toLowerCase();
    let distance: number | null = null;
    if (worker.latitude != null && worker.longitude != null && shift.latitude != null && shift.longitude != null) {
      distance = distanceKm(Number(worker.latitude), Number(worker.longitude), Number(shift.latitude), Number(shift.longitude));
      if (distance > Number(worker.radius_km)) continue;
    } else if (!sameCity) {
      continue;
    }
    if (overlapsExisting(worker.id, shift)) continue;
    result.push({
      id: worker.id,
      name: worker.name,
      area: worker.area,
      city: worker.city,
      distance_km: distance,
      radius_km: worker.radius_km,
      roles,
      skills: parseJson<string[]>(worker.skills_json, []),
      completed_shifts: worker.completed_shifts,
      language: worker.language,
    });
  }
  return result.sort((a, b) => {
    const byDistance = (a.distance_km ?? 0) - (b.distance_km ?? 0);
    if (Math.abs(byDistance) > 0.15) return byDistance;
    return Number(b.completed_shifts) - Number(a.completed_shifts);
  });
}
