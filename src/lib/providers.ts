import { db, id, nowIso } from "@/lib/db";

export function enqueueWhatsApp(workerId: string, shiftId: string | null, body: string): string {
  const mode = process.env.HOSTSHIFT_WHATSAPP_MODE || "sandbox";
  if (mode !== "sandbox") throw new Error("Live WhatsApp provider is not configured. Set HOSTSHIFT_WHATSAPP_MODE=sandbox for the pilot simulator.");
  const messageId = id();
  db.prepare("INSERT INTO messages(id,worker_id,shift_id,channel,direction,status,body,created_at) VALUES(?,?,?,'whatsapp_sandbox','outbound','simulated',?,?)")
    .run(messageId, workerId, shiftId, body, nowIso());
  return messageId;
}

export function logWorkerReply(workerId: string, shiftId: string | null, body: string): void {
  db.prepare("INSERT INTO messages(id,worker_id,shift_id,channel,direction,status,body,created_at) VALUES(?,?,?,'whatsapp_sandbox','inbound','simulated',?,?)")
    .run(id(), workerId, shiftId, body, nowIso());
}

export function makeSandboxPaymentPayload(paymentId: string, amount: number, expiresAt: string): string {
  const mode = process.env.HOSTSHIFT_PAYMENT_MODE || "sandbox";
  if (mode !== "sandbox") throw new Error("Live payment provider is not configured. Set HOSTSHIFT_PAYMENT_MODE=sandbox for the pilot simulator.");
  return `hostshift://sandbox/pay/${paymentId}?amount=${amount.toFixed(2)}&expires=${encodeURIComponent(expiresAt)}`;
}
