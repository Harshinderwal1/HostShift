# Hostshift pilot MVP

Hostshift is a local full-stack pilot app for independent hotels to post temporary shifts and invite nearby, manually verified hospitality workers. Hotel managers use the website. The worker website is intentionally omitted; worker sign-up, replies, attendance, and payment notifications are represented by the admin WhatsApp simulator until a WhatsApp provider is configured.

## Run locally

Requirements: Node.js 24 or newer and npm.

1. Open a terminal in this `hostshift` folder.
2. Copy `.env.example` to `.env.local`.
3. Run `npm install`.
4. Run `npm run dev` and open `http://localhost:3000`.

The app stores records in `data/hostshift.sqlite` by default. The database is created and seeded on first start. Back it up before deleting or replacing it. Change `HOSTSHIFT_DB_PATH` to use another local file.

### Demo accounts

- Hotel manager: `manager@hostshift.demo` / `HotelDemo!26`
- Pilot admin: `admin@hostshift.demo` / `HostshiftDemo!26`

The `.env.example` passwords match these accounts. The UI labels simulated behavior, and seed hotel names, worker names, and the sample shift are marked as demo data. The seed locations are synthetic approximate map pins used only to exercise distance matching.

## End-to-end pilot walkthrough

1. Sign in as the hotel manager. Post a shift with role, required skills, headcount, date, hours, pay, duties, and cancellation terms.
2. Open the shift and select **Find & invite workers**. Matching checks role, required skills, weekly availability, alert consent, verification, overlapping assignments, and the worker's own radius. Distances use approximate straight-line coordinates.
3. Sign in as the admin in another browser profile. In **WhatsApp sandbox**, simulate each invited worker replying **Interested** or **Unavailable**.
4. Return to the hotel account, refresh the shift, and confirm interested workers up to the available headcount. They are not booked until confirmed.
5. In the admin simulator, record check-in and check-out with the one-time codes displayed to the hotel manager. The app records actual hours and overtime separately. An admin can record a manual exception only with a reason; that action is audited.
6. As the hotel manager, approve recorded hours and the overtime amount. The worker must also confirm the total hours and pay in the simulator. Then open that assignment's payment QR.
7. The shift-specific sandbox QR expires after 30 minutes. Simulate payment success before expiry; this marks collection and payout as simulated and moves no money. Review payment, support, dispute, and audit screens.

For a new hotel, submit **Request hotel access**. An admin reviews the request, enters an approximate hotel pin, approves it, and shares the one-time setup link with the manager. Worker profiles can be added through the admin registration simulator, including a consent flag and an approximate area pin; then manually verify the profile before matching. If a worker has not checked in after the shift starts, the hotel can report a possible no-show. The worker response is simulated in the admin inbox; resolve the case only after reviewing that response or allowing the pilot response window to pass.

## Environment settings

| Variable | Purpose |
| --- | --- |
| `HOSTSHIFT_SANDBOX` | `true` enables local demo records and simulator actions; set to `false` to disable them. Sandbox actions are disabled automatically in production. |
| `HOSTSHIFT_DB_PATH` | SQLite file path, relative to the app folder or absolute. |
| `HOSTSHIFT_PILOT_AREA` | Label for the single pilot area. |
| `HOSTSHIFT_ADMIN_EMAIL` / `HOSTSHIFT_ADMIN_PASSWORD` | Initial admin account created when the database has no users. |
| `HOSTSHIFT_DEMO_MANAGER_EMAIL` / `HOSTSHIFT_DEMO_MANAGER_PASSWORD` | Local demo hotel manager account. |
| `HOSTSHIFT_WHATSAPP_MODE` | Only `sandbox` is implemented. No WhatsApp messages are sent externally. |
| `HOSTSHIFT_PAYMENT_MODE` | Only `sandbox` is implemented. QR payloads are app-specific simulator data, not UPI payment requests. |

Changing credentials after the database is initialized does not update existing user passwords. Use the password reset flow or reset the local database only if you are comfortable losing its records.

## Pilot boundaries

- WhatsApp is a provider adapter plus a stored-message/reply simulator. A real WhatsApp Business provider, inbound webhook, registration conversation, delivery receipts, and opt-out commands need provider credentials and integration work.
- The QR code is deliberately non-payable sandbox data. A real payment provider, verified webhook, payout onboarding, receipts, refunds, and reconciliation are not configured. Do not use the sandbox completion button to represent a real transfer.
- Worker profiles use approximate manual map pins. Matching reports straight-line distance, not road distance or travel time.
- Overtime is calculated as hours above the scheduled shift length, paid at the shift's base hourly equivalent (fixed shift pay divided by scheduled hours). The hotel and worker must both confirm the recorded total before payment.
- SQLite is appropriate for this single-process local pilot. Use a managed database and deployment-specific session/rate-limit storage before serving multiple production instances.
- The seed is created only for a new non-production database with sandbox enabled. For a real pilot, set the actual pilot area, configure a provider, replace demo credentials, and review compensation, tax, privacy, and employment terms with qualified advisors before launch.
- Password reset links are shown in the sandbox UI; no email or SMS delivery provider is configured.

## Project layout

- `src/app/api/[...route]/route.ts` — authenticated API and validation
- `src/lib/db.ts` — SQLite schema, seed data, and audit logging
- `src/lib/matching.ts` — distance and eligibility filtering
- `src/lib/providers.ts` — WhatsApp and payment sandbox adapters
- `src/components/hostshift-app.tsx` — hotel and admin workflows
