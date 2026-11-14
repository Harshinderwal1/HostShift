"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";

type User = { id: string; email: string; name: string; role: "admin" | "hotel_manager"; hotel_id: string | null; hotel_name?: string };
type AnyRecord = Record<string, any>;
type View = "overview" | "shifts" | "payments" | "support" | "access" | "workers" | "messages" | "disputes" | "settings" | "audit";

async function api(path: string, method = "GET", body?: unknown): Promise<AnyRecord> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong.");
  return result;
}

const money = (value: unknown) => `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const dateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", weekday: "short" });
const initials = (value: string) => value.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();
const prettyStatus = (value: string) => (value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const paymentQrExpired = (payment: AnyRecord) => !payment.expires_at || new Date(payment.expires_at).getTime() <= Date.now();

export default function HostshiftApp() {
  const [user, setUser] = useState<User | null>(null);
  const [sandboxMode, setSandboxMode] = useState(true);
  const [pilotArea, setPilotArea] = useState("Pilot Demo Area");
  const [supportedRoles, setSupportedRoles] = useState<string[]>(["Banquet Server", "Housekeeping Attendant", "Kitchen Assistant", "Restaurant Service", "Front Desk Assistant"]);
  const [view, setView] = useState<View>("overview");
  const [hotelData, setHotelData] = useState<AnyRecord>({ shifts: [], payments: [], stats: {} });
  const [adminData, setAdminData] = useState<AnyRecord>({ accessRequests: [], workers: [], shifts: [], disputes: [], messages: [], payments: [], settings: [] });
  const [selectedShift, setSelectedShift] = useState<AnyRecord | null>(null);
  const [matchesData, setMatchesData] = useState<AnyRecord | null>(null);
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: "success" | "error" } | null>(null);
  const [modal, setModal] = useState<"shift" | "edit-shift" | "access" | "worker" | "reset" | null>(null);
  const [resetToken, setResetToken] = useState("");
  const [isResetPage, setIsResetPage] = useState(false);
  const [resetLink, setResetLink] = useState("");
  const [loginEmail, setLoginEmail] = useState("manager@hostshift.demo");
  const [loginPassword, setLoginPassword] = useState("HotelDemo!26");
  const [paymentModal, setPaymentModal] = useState<AnyRecord | null>(null);

  const refresh = useCallback(async (currentUser = user) => {
    if (!currentUser) return;
    try {
      if (currentUser.role === "admin") setAdminData(await api("admin/overview"));
      else setHotelData(await api("hotel/overview"));
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "Could not load the dashboard.", kind: "error" });
    }
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    api("session").then((result) => {
      if (cancelled) return;
      setSandboxMode(result.sandbox !== false);
      setPilotArea(result.pilotArea || "Pilot Area");
      setSupportedRoles(Array.isArray(result.supportedRoles) ? result.supportedRoles : []);
      if (result.user) {
        setUser(result.user);
        setLoginEmail(result.user.email);
      }
      const params = new URLSearchParams(window.location.search);
      const token = params.get("token");
      if (window.location.pathname === "/reset-password" && token) {
        setResetToken(token);
        setIsResetPage(true);
        setModal("reset");
      }
    }).catch(() => setNotice({ text: "Could not connect to Hostshift.", kind: "error" }));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (user) void refresh(user); }, [user, refresh]);

  const currentHotelShifts = hotelData.shifts || [];
  const activeShiftCount = useMemo(() => currentHotelShifts.filter((s: AnyRecord) => !["completed", "cancelled"].includes(s.status)).length, [currentHotelShifts]);

  const notify = (text: string, kind: "success" | "error" = "success") => {
    setNotice({ text, kind });
    window.setTimeout(() => setNotice(null), 5200);
  };

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await action();
      if (success) notify(success);
      await refresh(user);
      if (selectedShift && user?.role === "hotel_manager") await openShift(selectedShift.id, false);
      if (selectedShift && user?.role === "admin") await openShift(selectedShift.id, false);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "Action could not be completed.", "error");
      return false;
    } finally { setBusy(false); }
  };

  const openShift = async (shiftId: string, show = true) => {
    try {
      const result = await api(`shifts/${encodeURIComponent(shiftId)}/matches`);
      setSelectedShift(result.shift);
      setMatchesData(result);
      setSelectedWorkers([]);
      if (show) setView("shifts");
    } catch (error) { notify(error instanceof Error ? error.message : "Could not open shift.", "error"); }
  };

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api("auth/login", "POST", { email: loginEmail, password: loginPassword });
      setUser(result.user);
      setView("overview");
      notify(`Welcome, ${result.user.name}.`);
    } catch (error) { notify(error instanceof Error ? error.message : "Could not sign in.", "error"); }
    finally { setBusy(false); }
  };

  const signOut = async () => {
    try { await api("auth/logout", "POST", {}); } catch { /* local state still clears */ }
    setUser(null); setHotelData({ shifts: [], payments: [], stats: {} }); setAdminData({ accessRequests: [], workers: [], shifts: [], disputes: [], messages: [], payments: [], settings: [] });
    notify("Signed out.");
  };

  const inviteWorkers = async (shiftId: string) => {
    await run(async () => {
      const result = await api(`shifts/${encodeURIComponent(shiftId)}/invite`, "POST", {});
      notify(`${result.invited} worker invitation(s) added to the WhatsApp ${sandboxMode ? "simulator" : "provider"}.`);
    });
  };

  const confirmWorkers = async () => {
    if (!selectedShift || !selectedWorkers.length) return;
    await run(async () => {
      const result = await api(`shifts/${encodeURIComponent(selectedShift.id)}/confirm`, "POST", { workerIds: selectedWorkers });
      notify(`${result.confirmed.length} worker(s) confirmed.`);
    });
  };

  if (!user || isResetPage) {
    return <LoginScreen
      busy={busy} email={loginEmail} setEmail={setLoginEmail} password={loginPassword} setPassword={setLoginPassword}
      sandboxMode={sandboxMode} pilotArea={pilotArea} supportedRoles={supportedRoles} notice={notice} modal={modal} setModal={setModal}
      signIn={signIn} resetToken={resetToken} setResetToken={setResetToken} resetLink={resetLink} setResetLink={setResetLink}
      onAccessRequest={async (form: AnyRecord) => run(async () => { await api("access-requests", "POST", form); setModal(null); }, "Request sent. You can sign in with your chosen password after the hotel is approved.")}
      onWorkerRequest={async (form: AnyRecord) => run(async () => { await api("worker-registration-requests", "POST", form); setModal(null); }, "Registration request received. The pilot team will verify your profile and contact you on WhatsApp.")}
      onForgot={async (email: string) => { const r = await api("auth/forgot", "POST", { email }); setResetLink(r.sandboxResetUrl || ""); notify(r.message); }}
      onReset={async (token: string, password: string) => { const r = await api("auth/reset", "POST", { token, password }); try { await api("auth/logout", "POST", {}); } catch { /* reset still completed */ } setUser(null); setIsResetPage(false); setModal(null); window.history.replaceState({}, "", "/"); notify(r.message); }}
    />;
  }

  const admin = user.role === "admin";
  const sections: Array<{ key: View; label: string; icon: string; adminOnly?: boolean }> = admin
    ? [{ key: "overview", label: "Overview", icon: "◫" }, { key: "access", label: "Hotel requests", icon: "⌂" }, { key: "workers", label: "Workers", icon: "♙" }, { key: "messages", label: "WhatsApp sandbox", icon: "◌" }, { key: "payments", label: "Payments", icon: "₹" }, { key: "disputes", label: "Disputes & support", icon: "⚑" }, { key: "settings", label: "Pilot settings", icon: "⚙" }, { key: "audit", label: "Audit history", icon: "◷" }]
    : [{ key: "overview", label: "Overview", icon: "◫" }, { key: "shifts", label: "Shifts", icon: "▦" }, { key: "payments", label: "Payments", icon: "₹" }, { key: "support", label: "Support", icon: "?" }];

  const displayName = admin ? "Pilot admin" : (user.hotel_name || "Hotel manager");
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark">H</div><div><strong>hostshift</strong><span>HOTEL STAFFING</span></div></div>
        <div className="side-caption">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {sections.map((item) => <button key={item.key} className={`nav-item ${view === item.key ? "active" : ""}`} onClick={() => { setView(item.key); setSelectedShift(null); setMatchesData(null); }}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.key === "access" && adminData.accessRequests?.filter((r: AnyRecord) => r.status === "pending").length > 0 && <b className="nav-count">{adminData.accessRequests.filter((r: AnyRecord) => r.status === "pending").length}</b>}</button>)}
        </nav>
        <div className="sidebar-spacer" />
        <div className="pilot-card"><div className="pilot-status-dot"/><div><strong>{pilotArea}</strong><span>{sandboxMode ? "Sandbox pilot" : "Pilot workspace"}</span></div><span className="live-dot"/></div>
        <div className="side-help"><span className="help-icon">?</span><div><strong>Need help?</strong><span>Pilot support desk</span></div></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark small">H</span><strong>hostshift</strong></div>
          <div className="breadcrumb"><span>Hostshift</span><i>/</i><strong>{admin ? "Pilot admin" : "Hotel workspace"}</strong></div>
          <div className="top-actions">
            {sandboxMode && <span className="sandbox-tag"><span/> SANDBOX MODE</span>}
            <div className="user-menu"><div className="avatar">{initials(user.name)}</div><div><strong>{user.name}</strong><span>{admin ? "Hostshift admin" : displayName}</span></div><button className="text-button" onClick={signOut}>Sign out</button></div>
          </div>
        </header>

        <div className="content-wrap">
          {notice && <div className={`toast ${notice.kind}`} role="status">{notice.kind === "success" ? "✓" : "!"} {notice.text}<button onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}
          {admin ? <AdminView view={view} data={adminData} busy={busy} sandboxMode={sandboxMode} onRun={run} onRefresh={() => refresh(user)} /> : <HotelView
            view={view} user={user} data={hotelData} busy={busy} sandboxMode={sandboxMode} selectedShift={selectedShift}
            matchesData={matchesData} selectedWorkers={selectedWorkers} setSelectedWorkers={setSelectedWorkers}
            onNewShift={() => setModal("shift")} onEditShift={() => setModal("edit-shift")} onOpenShift={(shiftId: string) => void openShift(shiftId)} onBack={() => { setSelectedShift(null); setMatchesData(null); }} onSetView={setView} onInvite={inviteWorkers}
            onConfirm={confirmWorkers} onRun={run} onPayment={setPaymentModal} onRefresh={() => refresh(user)} onAccess={() => setModal("access")}
          />}
        </div>
      </main>

      {(modal === "shift" || modal === "edit-shift") && !admin && <ShiftModal key={modal === "edit-shift" ? selectedShift?.id || "edit" : "new"} busy={busy} hotel={hotelData.hotel} supportedRoles={hotelData.supportedRoles} initialShift={modal === "edit-shift" ? selectedShift : null} onClose={() => setModal(null)} onSubmit={(form: AnyRecord) => run(async () => {
        const editing = modal === "edit-shift" && selectedShift;
        const result = await api(editing ? `hotel/shifts/${selectedShift.id}` : "hotel/shifts", editing ? "PATCH" : "POST", form);
        setModal(null);
        await refresh(user);
        await openShift(result.shift.id);
        notify(editing ? "Shift updated." : "Shift posted. Review nearby workers and send the first invitation batch.");
      })} />}
      {modal === "access" && <AccessModal busy={busy} onClose={() => setModal(null)} onSubmit={async (form: AnyRecord) => run(async () => { await api("access-requests", "POST", form); setModal(null); }, "Hotel access request sent for manual review.")} />}
      {paymentModal && <PaymentModal payment={paymentModal} sandboxMode={sandboxMode} onClose={() => setPaymentModal(null)} onSimulate={() => run(async () => {
        await api(`payments/${paymentModal.id}/sandbox-success`, "POST", {});
        setPaymentModal(null);
        notify("Sandbox payment and payout marked complete. No real money moved.");
      })} />}
    </div>
  );
}

function LoginScreen(props: AnyRecord) {
  const [email, setEmail] = useState(props.email);
  const [password, setPassword] = useState(props.password);
  const [accessForm, setAccessForm] = useState({ hotelName: "", managerName: "", email: "", phone: "", city: "", area: "", address: "", password: "" });
  const [confirmAccessPassword, setConfirmAccessPassword] = useState("");
  const [accessError, setAccessError] = useState("");
  const [workerForm, setWorkerForm] = useState({ name: "", phone: "", city: props.pilotArea || "", area: "", latitude: "", longitude: "", radiusKm: "10", roles: [] as string[], skills: "", availability: [] as string[], language: "Hindi", optedIn: false });
  const [workerError, setWorkerError] = useState("");
  const [locationStatus, setLocationStatus] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const workerRoleOptions = Array.isArray(props.supportedRoles) && props.supportedRoles.length ? props.supportedRoles : ["Banquet Server", "Housekeeping Attendant", "Kitchen Assistant", "Restaurant Service", "Front Desk Assistant"];
  const submitAccess = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.busy) return;
    if (accessForm.password !== confirmAccessPassword) { setAccessError("The passwords do not match."); return; }
    setAccessError("");
    const submitted = await props.onAccessRequest(accessForm);
    if (submitted) {
      setAccessForm({ hotelName: "", managerName: "", email: "", phone: "", city: "", area: "", address: "", password: "" });
      setConfirmAccessPassword("");
    }
  };
  const submitWorker = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.busy) return;
    if (!workerForm.roles.length || !workerForm.availability.length || !workerForm.optedIn) {
      setWorkerError("Choose at least one role and available day, then agree to receive WhatsApp shift alerts.");
      return;
    }
    setWorkerError("");
    const submitted = await props.onWorkerRequest(workerForm);
    if (submitted) {
      setWorkerForm({ name: "", phone: "", city: props.pilotArea || "", area: "", latitude: "", longitude: "", radiusKm: "10", roles: [], skills: "", availability: [], language: "Hindi", optedIn: false });
      setLocationStatus("");
    }
  };
  const toggleWorkerChoice = (key: "roles" | "availability", value: string) => {
    const selected = workerForm[key];
    setWorkerForm({ ...workerForm, [key]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value] });
    setWorkerError("");
  };
  const useApproximateLocation = () => {
    setLocationStatus("Getting your location…");
    if (!navigator.geolocation) { setLocationStatus("Location is unavailable in this browser. Enter a nearby landmark pin manually."); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setWorkerForm((current) => ({ ...current, latitude: coords.latitude.toFixed(3), longitude: coords.longitude.toFixed(3) }));
        setLocationStatus("Approximate location added. Check that it points near a public landmark.");
      },
      () => setLocationStatus("We could not get your location. Allow location access or enter a nearby landmark pin manually."),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };
  const submitReset = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); await props.onReset(props.resetToken, resetPassword); };
  return <div className="auth-page">
    <div className="auth-visual">
      <div className="auth-brand"><div className="brand-mark">H</div><strong>hostshift</strong></div>
      <div className="auth-copy"><span className="eyebrow light">TEMP STAFFING, MADE CLEAR</span><h1>Good shifts.<br/><em>Right people.</em><br/>Less last-minute stress.</h1><p>Connect independent hotels with verified nearby hospitality workers for temporary shifts.</p></div>
      <div className="auth-visual-bottom"><span>HOSPITALITY OPERATIONS</span><span>01 — 03</span></div>
      <div className="orb orb-one"/><div className="orb orb-two"/>
    </div>
    <div className="auth-panel">
      <div className="auth-panel-top"><span className="small-label">{props.modal === "worker" ? "WORKER REGISTRATION" : "HOTEL PARTNER PORTAL"}</span><span className="secure-label">◈ Secure sign in</span></div>
      {props.modal === "access" ? <form className="auth-form" onSubmit={submitAccess}>
        <button type="button" className="back-link" onClick={() => props.setModal(null)}>← Back to sign in</button>
        <h2>Request hotel access</h2><p>Our pilot team will verify your hotel. After approval, sign in with the password you choose here.</p>
        <Field label="Hotel name"><input required value={accessForm.hotelName} onChange={(e) => setAccessForm({ ...accessForm, hotelName: e.target.value })} placeholder="e.g. The Olive Hotel"/></Field>
        <div className="form-grid two"><Field label="Manager name"><input required value={accessForm.managerName} onChange={(e) => setAccessForm({ ...accessForm, managerName: e.target.value })}/></Field><Field label="Phone"><input required value={accessForm.phone} onChange={(e) => setAccessForm({ ...accessForm, phone: e.target.value })}/></Field></div>
        <Field label="Business email"><input required type="email" value={accessForm.email} onChange={(e) => setAccessForm({ ...accessForm, email: e.target.value })}/></Field>
        <div className="form-grid two"><Field label="City"><input required value={accessForm.city} onChange={(e) => setAccessForm({ ...accessForm, city: e.target.value })}/></Field><Field label="Area"><input required value={accessForm.area} onChange={(e) => setAccessForm({ ...accessForm, area: e.target.value })}/></Field></div>
        <Field label="Hotel address"><input value={accessForm.address} onChange={(e) => setAccessForm({ ...accessForm, address: e.target.value })}/></Field>
        <Field label="Create password" hint="Use at least 10 characters. This stays inactive until your hotel is approved."><input required type="password" autoComplete="new-password" minLength={10} value={accessForm.password} onChange={(e) => { setAccessForm({ ...accessForm, password: e.target.value }); setAccessError(""); }}/></Field>
        <Field label="Confirm password"><input required type="password" autoComplete="new-password" minLength={10} value={confirmAccessPassword} onChange={(e) => { setConfirmAccessPassword(e.target.value); setAccessError(""); }}/></Field>
        {accessError && <p className="form-validation-error" role="alert">{accessError}</p>}
        <button className="primary-button full" disabled={props.busy}>Send access request <span>→</span></button>
      </form> : props.modal === "worker" ? <form className="auth-form worker-request-form" onSubmit={submitWorker}>
        <button type="button" className="back-link" onClick={() => props.setModal(null)}>← Back to sign in</button>
        <h2>Register as a worker</h2><p>Send a one-time profile request. The pilot team verifies workers before they receive nearby shift invitations.</p>
        <Field label="Full name"><input required autoComplete="name" value={workerForm.name} onChange={(e) => setWorkerForm({ ...workerForm, name: e.target.value })}/></Field>
        <Field label="WhatsApp number" hint="Include your country code, for example +91 98765 43210."><input required type="tel" inputMode="tel" autoComplete="tel" placeholder="+91 98765 43210" value={workerForm.phone} onChange={(e) => setWorkerForm({ ...workerForm, phone: e.target.value })}/></Field>
        <div className="form-grid two"><Field label="City / town"><input required value={workerForm.city} onChange={(e) => setWorkerForm({ ...workerForm, city: e.target.value })}/></Field><Field label="Area / nearby landmark"><input required value={workerForm.area} onChange={(e) => setWorkerForm({ ...workerForm, area: e.target.value })} placeholder="A public landmark near you"/></Field></div>
        <button type="button" className="secondary-button full" onClick={useApproximateLocation}>◎ Use approximate current location</button>
        <div className="form-grid two"><Field label="Approx. latitude"><input required type="number" step="any" inputMode="decimal" placeholder="28.6139" value={workerForm.latitude} onChange={(e) => { setWorkerForm({ ...workerForm, latitude: e.target.value }); setLocationStatus(""); }}/></Field><Field label="Approx. longitude"><input required type="number" step="any" inputMode="decimal" placeholder="77.2090" value={workerForm.longitude} onChange={(e) => { setWorkerForm({ ...workerForm, longitude: e.target.value }); setLocationStatus(""); }}/></Field></div>
        <small className="muted location-status" aria-live="polite">{locationStatus || "Use an approximate public landmark pin, not your home address. Coordinates are rounded before saving."}</small>
        <Field label="How far can you travel? (km)"><input required type="number" min="1" max="100" value={workerForm.radiusKm} onChange={(e) => setWorkerForm({ ...workerForm, radiusKm: e.target.value })}/></Field>
        <fieldset className="choice-field"><legend>Roles you can work</legend><div className="choice-grid">{workerRoleOptions.map((role: string) => <label className="choice-option" key={role}><input type="checkbox" checked={workerForm.roles.includes(role)} onChange={() => toggleWorkerChoice("roles", role)}/><span>{role}</span></label>)}</div></fieldset>
        <Field label="Skills or experience" hint="Optional; separate multiple skills with commas."><input value={workerForm.skills} onChange={(e) => setWorkerForm({ ...workerForm, skills: e.target.value })} placeholder="Guest service, banquet setup"/></Field>
        <fieldset className="choice-field"><legend>Days you are available</legend><div className="choice-grid availability-grid">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "All days"].map((day) => <label className="choice-option" key={day}><input type="checkbox" checked={workerForm.availability.includes(day)} onChange={() => toggleWorkerChoice("availability", day)}/><span>{day}</span></label>)}</div></fieldset>
        <Field label="Preferred language"><input value={workerForm.language} onChange={(e) => setWorkerForm({ ...workerForm, language: e.target.value })}/></Field>
        <label className="consent-row worker-consent"><input type="checkbox" checked={workerForm.optedIn} onChange={(e) => { setWorkerForm({ ...workerForm, optedIn: e.target.checked }); setWorkerError(""); }}/> I agree to receive shift invitations and updates from Hostshift on WhatsApp. I can ask the pilot team to stop messages at any time.</label>
        {workerError && <p className="form-validation-error" role="alert">{workerError}</p>}
        <button className="primary-button full" disabled={props.busy}>Send registration request <span>→</span></button>
        <small className="muted">No worker password or bank details are collected here. Payment onboarding happens after verification.</small>
      </form> : props.modal === "reset" ? <form className="auth-form" onSubmit={submitReset}>
        <h2>Set a new password</h2><p>Choose a secure password with at least 10 characters.</p>
        <Field label="New password"><input autoFocus required minLength={10} type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)}/></Field>
        <button className="primary-button full">Update password <span>→</span></button>
      </form> : <form className="auth-form" onSubmit={props.signIn}>
        <span className="eyebrow">WELCOME BACK</span><h2>Sign in to Hostshift</h2><p>Manage shifts and staffing for your hotel.</p>
        <Field label="Business email"><input required type="email" autoComplete="username" value={email} onChange={(e) => { setEmail(e.target.value); props.setEmail(e.target.value); }} /></Field>
        <Field label="Password"><input required type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); props.setPassword(e.target.value); }}/></Field>
        <div className="auth-inline"><button type="button" className="link-button" onClick={() => props.onForgot(email)}>Forgot password?</button></div>
        {props.resetLink && <div className="sandbox-reset">Sandbox reset link: <a href={props.resetLink}>Set a new password →</a></div>}
        <button className="primary-button full" disabled={props.busy}>{props.busy ? "Signing in…" : "Sign in"}<span>→</span></button>
        <div className="auth-divider"><span>NEW TO HOSTSHIFT?</span></div>
        <button type="button" className="secondary-button full" onClick={() => props.setModal("access")}>Request hotel access</button>
        <button type="button" className="secondary-button full" onClick={() => props.setModal("worker")}>Register as a worker</button>
        {props.sandboxMode && <div className="demo-credentials"><div className="demo-icon">✳</div><div><strong>Demo credentials</strong><span>manager@hostshift.demo / HotelDemo!26</span><span>admin@hostshift.demo / HostshiftDemo!26</span></div><button type="button" title="Sign in as admin" onClick={() => { setEmail("admin@hostshift.demo"); setPassword("HostshiftDemo!26"); props.setEmail("admin@hostshift.demo"); props.setPassword("HostshiftDemo!26"); }}>↗</button></div>}
      </form>}
      <div className="auth-footer"><span>© {new Date().getFullYear()} Hostshift</span><span>Privacy · Terms</span></div>
    </div>
    {props.notice && <div className={`auth-toast toast ${props.notice.kind}`}>{props.notice.text}</div>}
  </div>;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function HotelView(props: AnyRecord) {
  const { view, user, data, busy, sandboxMode, selectedShift, matchesData, selectedWorkers, setSelectedWorkers } = props;
  const [issue, setIssue] = useState("");
  const [issueCategory, setIssueCategory] = useState("Shift or worker");
  const shifts: AnyRecord[] = data.shifts || [];
  const payments: AnyRecord[] = data.payments || [];
  const initialsName = user.hotel_name || "Hotel";
  const activeShiftCount = shifts.filter((shift) => !["completed", "cancelled"].includes(shift.status)).length;
  return <>
    <div className="page-heading"><div><div className="eyebrow">HOTEL WORKSPACE <span className="heading-dot"/> {data.hotel?.city || "Pilot area"}</div><h1>{view === "overview" ? `Welcome back, ${user.name.split(" ")[0]}` : view === "shifts" ? "Your shifts" : view === "payments" ? "Payments" : "Support"}</h1><p>{view === "overview" ? `${initialsName} · Manage temporary staffing and upcoming shift coverage.` : view === "shifts" ? "Post a shift, review nearby workers, and confirm your team." : view === "payments" ? "Track hotel collections and worker payouts for your shifts." : "Contact the pilot team about a shift, worker, or payment."}</p></div>
      <div className="heading-actions">{view !== "support" && <button className="secondary-button" onClick={() => props.onRefresh()}>↻ Refresh</button>}<button className="primary-button" onClick={props.onNewShift}>＋ Post a shift</button></div></div>
    {view === "overview" && <>
      <div className="metric-grid">
        <Metric icon="▦" title="Active shifts" value={String(props.data.shifts?.filter((s: AnyRecord) => !["completed", "cancelled"].includes(s.status)).length ?? 0)} foot="Across your hotel" accent="mint"/>
        <Metric icon="♙" title="Workers confirmed" value={String((props.data.shifts || []).reduce((n: number, s: AnyRecord) => n + Number(s.assigned_count || 0), 0))} foot="On upcoming shifts" accent="blue"/>
        <Metric icon="◌" title="Worker responses" value={String((props.data.shifts || []).reduce((n: number, s: AnyRecord) => n + Number(s.interested_count || 0), 0))} foot="Awaiting your review" accent="amber"/>
        <Metric icon="₹" title="Payments pending" value={String((props.data.payments || []).filter((p: AnyRecord) => p.collection_status !== "received" || p.payout_status !== "paid").length)} foot="Collection or payout action" accent="purple"/>
      </div>
      <div className="section-row"><div><h2>Shift overview</h2><p>Keep the right people on every shift.</p></div><button className="text-link" onClick={() => props.onSetView("shifts")}>View shifts <span>→</span></button></div>
      <div className="overview-grid">
        <div className="panel shift-panel" id="shifts-section"><div className="panel-head"><div><h3>Upcoming shifts</h3><span className="muted">{shifts.filter((s) => !["completed", "cancelled"].includes(s.status)).length} active</span></div><button className="small-add" onClick={props.onNewShift}>＋ New shift</button></div>
          {shifts.length ? <div className="shift-list">{shifts.slice(0, 5).map((shift) => <ShiftRow key={shift.id} shift={shift} onClick={() => props.onOpenShift(shift.id)}/>)}</div> : <EmptyState icon="▦" title="No shifts posted yet" text="Post your first shift to see matched workers." action="Post a shift" onAction={props.onNewShift}/>}</div>
        <div className="panel coverage-panel"><div className="panel-head"><div><h3>Staffing snapshot</h3><span className="muted">Across active shifts</span></div><span className="panel-icon">✳</span></div>
          <div className="coverage-number">{String((props.data.shifts || []).reduce((n: number, s: AnyRecord) => n + Number(s.assigned_count || 0), 0))}<span> / {(props.data.shifts || []).reduce((n: number, s: AnyRecord) => n + Number(s.headcount || 0), 0)}</span></div><div className="coverage-label">Workers confirmed</div>
          <div className="progress-track"><div style={{ width: `${Math.min(100, Math.round(((props.data.shifts || []).reduce((n: number, s: AnyRecord) => n + Number(s.assigned_count || 0), 0) / Math.max(1, (props.data.shifts || []).reduce((n: number, s: AnyRecord) => n + Number(s.headcount || 0), 0))) * 100))}%` }}/></div>
          <div className="coverage-foot"><span>Open positions</span><strong>{Math.max(0, (props.data.shifts || []).reduce((n: number, s: AnyRecord) => n + Number(s.headcount || 0), 0) - (props.data.shifts || []).reduce((n: number, s: AnyRecord) => n + Number(s.assigned_count || 0), 0))}</strong></div>
          <div className="coverage-note">Your private hotel staffing data is only visible to your team.</div></div>
      </div>
      <div className="section-row payments-head"><div><h2>Recent payment activity</h2><p>Track each hotel payment and worker payout separately.</p></div><button className="text-link" onClick={() => props.onSetView("payments")}>All payments <span>→</span></button></div>
      <PaymentTable payments={payments.slice(0, 4)} onOpen={props.onPayment}/>
    </>}

    {view === "shifts" && <div className="shift-workspace">
      {selectedShift ? <div className="panel shift-detail">
        <div className="detail-head"><button className="back-link" onClick={props.onBack}>← All shifts</button><div className="detail-actions"><StatusPill status={selectedShift.status}/>{selectedShift.status === "open" && !matchesData?.invitations?.length && <button className="secondary-button" disabled={busy} onClick={props.onEditShift}>Edit shift</button>}<button className="secondary-button" disabled={busy || ["cancelled","completed"].includes(selectedShift.status)} onClick={() => props.onRun(async () => { await api(`shifts/${selectedShift.id}/cancel`, "POST", {}); }, "Shift cancelled and workers notified.")}>Cancel shift</button></div></div>
        <div className="detail-title"><div className="role-icon">{selectedShift.role?.slice(0, 1) || "S"}</div><div><h2>{selectedShift.role}</h2><p>{selectedShift.hotel_name} · {selectedShift.area}, {selectedShift.city}</p></div></div>
        <div className="detail-facts"><div><span>DATE</span><strong>{dateLabel(selectedShift.shift_date)}</strong></div><div><span>TIME</span><strong>{selectedShift.start_time}–{selectedShift.end_time}</strong></div><div><span>PAY / WORKER</span><strong>{money(selectedShift.pay_amount)}</strong></div><div><span>OPENINGS</span><strong>{selectedShift.headcount}</strong></div></div>
        <div className="detail-body"><p>{selectedShift.duties || "Temporary hospitality shift."}</p><div className="detail-tags">{parseList(selectedShift.skills_json).map((skill: string) => <span key={skill}>{skill}</span>)}<span>{prettyStatus(selectedShift.status)}</span></div></div>
        <div className="section-row inner-row"><div><h3>Nearby worker matches</h3><p>Filtered by role, skills, availability, shift conflicts, and each worker’s chosen radius.</p></div><button className="primary-button" disabled={busy || ["filled","cancelled","completed"].includes(selectedShift.status)} onClick={() => props.onInvite(selectedShift.id)}>◌ Find & invite workers</button></div>
        {matchesData && <>
          <div className="match-summary"><span><b>{matchesData.matches?.length || 0}</b> new eligible matches</span><span><b>{matchesData.invitations?.length || 0}</b> invitations sent</span><span><b>{matchesData.assignments?.length || 0}</b> confirmed</span>{sandboxMode && <em>Worker replies can be simulated in Admin → WhatsApp sandbox.</em>}</div>
          {matchesData.matches?.length > 0 && <div className="worker-grid">{matchesData.matches.slice(0, 6).map((worker: AnyRecord) => <div className="worker-card" key={worker.id}><div className="avatar worker-avatar">{initials(worker.name)}</div><div className="worker-card-main"><strong>{worker.name}</strong><span>{worker.area} · {worker.distance_km == null ? "area match" : `${Number(worker.distance_km).toFixed(1)} km approx.`}</span><div className="detail-tags">{worker.roles.slice(0, 2).map((role: string) => <small key={role}>{role}</small>)}</div></div><span className="verified-tag">✓ Verified</span></div>)}</div>}
          {matchesData.matches?.length === 0 && <EmptyState icon="⌕" title="No new matches" text="Try the next invitation batch or review the pilot area, role, and worker availability with your admin."/>}
          {matchesData.invitations?.length > 0 && <div className="table-wrap"><table><thead><tr><th>WORKER</th><th>BATCH</th><th>RESPONSE</th><th>REPLIED</th></tr></thead><tbody>{matchesData.invitations.map((invite: AnyRecord) => <tr key={invite.id}><td><strong>{invite.worker_name}</strong><small>{invite.worker_area}</small></td><td>Batch {invite.batch_no}</td><td><StatusPill status={invite.status}/></td><td>{invite.responded_at ? new Date(invite.responded_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</td></tr>)}</tbody></table></div>}
          {matchesData.invitations?.some((invite: AnyRecord) => invite.status === "interested") && <div className="confirm-bar"><span>Select interested workers to confirm. They are not booked until you confirm.</span><div className="confirm-actions"><button className="secondary-button" onClick={() => setSelectedWorkers(matchesData.invitations.filter((i: AnyRecord) => i.status === "interested").slice(0, Math.max(0, Number(selectedShift.headcount) - Number(matchesData.assignments?.length || 0))).map((i: AnyRecord) => i.worker_id))}>Select available slots</button><button className="primary-button" disabled={!selectedWorkers.length || busy} onClick={props.onConfirm}>Confirm {selectedWorkers.length || "workers"}</button></div></div>}
          {matchesData.assignments?.length > 0 && <><div className="section-row inner-row"><div><h3>Confirmed workers</h3><p>Attendance codes are unique to each assigned worker and shift.</p></div></div><div className="assignment-list">{matchesData.assignments.map((assignment: AnyRecord) => <div className="assignment-card" key={assignment.id}><div><div className="assignment-name"><span className="avatar worker-avatar">{initials(assignment.worker_name)}</span><div><strong>{assignment.worker_name}</strong><span>{assignment.hours ? `${assignment.hours} hours · ` : ""}{prettyStatus(assignment.status)}</span></div></div></div><div className="codes"><span>START <b>{assignment.start_code}</b></span><span>END <b>{assignment.end_code}</b></span></div><div className="attendance-state"><span>{assignment.checked_in_at ? "Checked in" : "Awaiting check-in"}</span><span>{assignment.checked_out_at ? "Checked out" : "Awaiting check-out"}</span></div>{Number(assignment.overtime_hours || 0) > 0 && <span className="hint-pill">{assignment.overtime_hours}h overtime · {money(assignment.overtime_pay)} extra</span>}{assignment.status === "confirmed" && !assignment.checked_in_at && new Date(`${selectedShift.shift_date}T${selectedShift.start_time}:00`).getTime() < Date.now() && <button className="small-button" disabled={busy} onClick={() => props.onRun(async () => { await api(`assignments/${assignment.id}/no-show`, "POST", {}); }, "Possible no-show sent for worker response and admin review.")}>Report possible no-show</button>}{assignment.checked_out_at && <button className="small-button" disabled={busy} onClick={() => props.onRun(async () => { await api(`assignments/${assignment.id}/approve-hours`, "POST", { hours: assignment.hours, finalPay: assignment.final_pay ?? (Number(selectedShift.pay_amount) + Number(assignment.overtime_pay || 0)) }); }, "Hours approved. Worker confirmation is next.")}>Approve {assignment.hours || "recorded"}h · {money(assignment.final_pay ?? (Number(selectedShift.pay_amount) + Number(assignment.overtime_pay || 0)))}</button>}{assignment.hours_approved && !assignment.worker_hours_confirmed && <span className="hint-pill">Awaiting worker confirmation</span>}{assignment.worker_hours_confirmed && assignment.status !== "completed" && <button className="small-button green" disabled={busy} onClick={() => props.onRun(async () => { const r = await api(`assignments/${assignment.id}/payment`, "POST", {}); props.onPayment(r.payment); }, "Payment QR created.")}>Create payment QR</button>}{assignment.status === "completed" && <span className="status-pill completed">Paid</span>}</div>)}</div></>}
        </>}
      </div> : <>
        <div className="shift-toolbar"><div className="filter-chip active">All shifts <span>{shifts.length}</span></div><span className="toolbar-label">{activeShiftCount} active in {initialsName}</span><button className="primary-button" onClick={props.onNewShift}>＋ Post a shift</button></div>
        {shifts.length ? <div className="panel"><div className="table-wrap"><table><thead><tr><th>ROLE & HOTEL</th><th>DATE & TIME</th><th>PAY / PERSON</th><th>TEAM</th><th>STATUS</th><th/></tr></thead><tbody>{shifts.map((shift: AnyRecord) => <tr key={shift.id} className="clickable-row" onClick={() => props.onOpenShift(shift.id)}><td><strong>{shift.role}</strong><small>{shift.hotel_name} · {shift.area}</small></td><td>{dateLabel(shift.shift_date)}<small>{shift.start_time}–{shift.end_time}</small></td><td>{money(shift.pay_amount)}<small>Per worker / shift</small></td><td>{shift.assigned_count || 0} / {shift.headcount}<small>{shift.interested_count || 0} interested</small></td><td><StatusPill status={shift.status}/></td><td><button className="row-arrow" aria-label="Open shift">→</button></td></tr>)}</tbody></table></div></div> : <EmptyState icon="▦" title="No shifts posted yet" text="Post a role, shift time, worker pay, and headcount to see eligible nearby workers." action="Post a shift" onAction={props.onNewShift}/>}</>}
    </div>}

    {view === "payments" && <><div className="callout info"><span>ⓘ</span><div><strong>Post-shift QR payments</strong><p>Hotel collections are marked received only after provider confirmation. Worker payout status is tracked separately. Sandbox payments move no real money.</p></div></div><PaymentTable payments={payments} onOpen={props.onPayment}/></>}
    {view === "support" && <div className="support-grid"><div className="panel support-card"><div className="support-icon">?</div><h3>Contact pilot support</h3><p>For shift changes, attendance issues, or payment questions, send a request to the Hostshift pilot team.</p><Field label="Issue type"><select value={issueCategory} onChange={(e) => setIssueCategory(e.target.value)}><option>Shift or worker</option><option>Attendance</option><option>Payment</option><option>Other</option></select></Field><Field label="Describe the issue"><textarea rows={4} value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="Include the shift date and what happened."/></Field><button className="primary-button" disabled={!issue.trim() || busy} onClick={() => props.onRun(async () => { await api("hotel/support", "POST", { category: issueCategory, description: issue }); setIssue(""); }, "Support request sent to the pilot team.")}>Send to pilot team</button><small className="muted block">For the pilot, requests are added to the admin review queue.</small></div><div className="panel contact-card"><span className="eyebrow">PILOT OPERATIONS</span><h3>What happens next?</h3><ul><li>Your request is saved with a timestamp.</li><li>The pilot admin reviews the case.</li><li>Any payment or attendance decision is recorded.</li></ul><div className="contact-meta"><span>Typical review</span><strong>During pilot hours</strong></div>{data.supportRequests?.length > 0 && <div className="own-support-list"><h4>Your recent requests</h4>{data.supportRequests.slice(0, 6).map((request: AnyRecord) => <div key={request.id}><span>{request.category} · {new Date(request.created_at).toLocaleDateString()}</span><StatusPill status={request.status}/><p>{request.description}</p>{request.resolution && <small>{request.resolution}</small>}</div>)}</div>}</div></div>}
  </>;
}

function AdminView(props: AnyRecord) {
  const { view, data, busy, sandboxMode } = props;
  const initialWorkerForm = { name: "", phone: "", city: "", area: "", latitude: "", longitude: "", radiusKm: "10", roles: "Banquet Server", skills: "Guest service", availability: "Mon,Tue,Wed,Thu,Fri,Sat,Sun", language: "Hindi", consent: false };
  const [workerForm, setWorkerForm] = useState(initialWorkerForm);
  const [hotelPins, setHotelPins] = useState<Record<string, { latitude: string; longitude: string }>>({});
  const [hotelRejectReasons, setHotelRejectReasons] = useState<Record<string, string>>({});
  const [workerReply, setWorkerReply] = useState<Record<string, string>>({});
  const [settingForm, setSettingForm] = useState<Record<string, string>>({});
  const [supportedRolesText, setSupportedRolesText] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [disputeReason, setDisputeReason] = useState<Record<string, string>>({});
  const [disputeDecision, setDisputeDecision] = useState<Record<string, string>>({});
  const [supportReason, setSupportReason] = useState<Record<string, string>>({});
  useEffect(() => { const next: Record<string, string> = {}; for (const setting of data.settings || []) next[setting.key] = setting.value; setSettingForm(next); try { setSupportedRolesText(JSON.parse(next.supported_roles || "[]").join(", ")); } catch { setSupportedRolesText(""); } }, [data.settings]);
  const pendingRequests = (data.accessRequests || []).filter((request: AnyRecord) => request.status === "pending");
  const pendingWorkers = (data.workers || []).filter((worker: AnyRecord) => !worker.verified);
  const pendingPayments = (data.payments || []).filter((payment: AnyRecord) => payment.collection_status !== "received" || payment.payout_status !== "paid");
  const toggleWorkerAlerts = (worker: AnyRecord) => {
    if (!worker.opted_in && !window.confirm("Confirm that this worker has asked to resume WhatsApp shift alerts.")) return;
    return props.onRun(async () => { await api(`admin/workers/${worker.id}`, "PATCH", { opted_in: !worker.opted_in, reason: worker.opted_in ? "Paused alerts at worker request." : "Resumed alerts after worker consent was confirmed by pilot admin." }); }, worker.opted_in ? "Worker alerts paused." : "Worker alerts resumed.");
  };
  return <>
    <div className="page-heading"><div><div className="eyebrow">HOSTSHIFT PILOT OPERATIONS <span className="heading-dot"/> {sandboxMode ? "SANDBOX" : "LIVE"}</div><h1>{adminTitle(view)}</h1><p>{adminSubtitle(view)}</p></div><div className="heading-actions"><button className="secondary-button" onClick={props.onRefresh}>↻ Refresh</button></div></div>
    {view === "overview" && <>
      <div className="metric-grid"><Metric icon="⌂" title="Hotel requests" value={String(pendingRequests.length)} foot="Awaiting manual review" accent="mint"/><Metric icon="♙" title="Workers to verify" value={String(pendingWorkers.length)} foot="Pilot verification queue" accent="blue"/><Metric icon="▦" title="Active shifts" value={String((data.shifts || []).filter((s: AnyRecord) => !["cancelled","completed"].includes(s.status)).length)} foot="Across pilot hotels" accent="amber"/><Metric icon="₹" title="Payment action" value={String(pendingPayments.length)} foot="Collection or payout pending" accent="purple"/></div>
      <div className="overview-grid admin-overview-grid"><div className="panel"><div className="panel-head"><div><h3>Latest shifts</h3><span className="muted">Pilot area activity</span></div></div><ShiftAdminTable shifts={(data.shifts || []).slice(0, 6)}/></div><div className="panel"><div className="panel-head"><div><h3>Open support cases</h3><span className="muted">Attendance, payment, and hotel requests</span></div></div>{(data.disputes || []).filter((d: AnyRecord) => d.status === "open").slice(0, 3).map((dispute: AnyRecord) => <DisputeMini key={dispute.id} dispute={dispute}/>)}{(data.supportRequests || []).filter((r: AnyRecord) => r.status === "open").slice(0, 3).map((request: AnyRecord) => <div className="mini-dispute" key={request.id}><div className="mini-dispute-icon">?</div><div><strong>{request.category} · {request.hotel_name}</strong><span>{request.manager_name}</span><small>{request.description}</small></div><StatusPill status={request.status}/></div>)}{!(data.disputes || []).some((d: AnyRecord) => d.status === "open") && !(data.supportRequests || []).some((r: AnyRecord) => r.status === "open") && <EmptyState title="No open cases" text="New disputes and support requests will appear here."/>}</div></div>
    </>}
    {view === "access" && <div className="panel"><div className="panel-head"><div><h3>Hotel access requests</h3><span className="muted">Review hotel details and set an approximate map pin. New managers already chose a password.</span></div><span className="count-pill">{pendingRequests.length} pending</span></div>{pendingRequests.length ? <div className="request-grid">{pendingRequests.map((request: AnyRecord) => <div className="request-card" key={request.id}><div className="request-symbol">⌂</div><div className="request-info"><strong>{request.hotel_name}</strong><span>{request.city} · {request.area}</span><span>{request.manager_name} · {request.phone}</span><span>{request.email}</span><small>Requested {new Date(request.created_at).toLocaleDateString()}</small><div className="form-grid two"><Field label="Approx. latitude"><input required inputMode="decimal" placeholder="28.6139" value={hotelPins[request.id]?.latitude || ""} onChange={(e) => setHotelPins({ ...hotelPins, [request.id]: { latitude: e.target.value, longitude: hotelPins[request.id]?.longitude || "" } })}/></Field><Field label="Approx. longitude"><input required inputMode="decimal" placeholder="77.2090" value={hotelPins[request.id]?.longitude || ""} onChange={(e) => setHotelPins({ ...hotelPins, [request.id]: { latitude: hotelPins[request.id]?.latitude || "", longitude: e.target.value } })}/></Field></div><Field label="Rejection reason (if needed)"><input value={hotelRejectReasons[request.id] || ""} onChange={(e) => setHotelRejectReasons({ ...hotelRejectReasons, [request.id]: e.target.value })} placeholder="e.g. Outside pilot area"/></Field><div className="request-actions"><button className="primary-button small" disabled={busy || !hotelPins[request.id]?.latitude || !hotelPins[request.id]?.longitude} onClick={() => props.onRun(async () => { const result = await api(`admin/access-requests/${request.id}/approve`, "POST", hotelPins[request.id]); if (result.inviteUrl) setInviteLink(result.inviteUrl); }, request.manager_password_set ? "Hotel approved. The manager can sign in with the password they chose." : "Hotel approved. Share the setup link with its manager.")}>{request.manager_password_set ? "Approve access" : "Approve & invite"}</button><button className="secondary-button small" disabled={busy || !hotelRejectReasons[request.id]?.trim()} onClick={() => props.onRun(async () => { await api(`admin/access-requests/${request.id}/reject`, "POST", { reason: hotelRejectReasons[request.id] }); }, "Hotel request rejected with a recorded reason.")}>Reject</button></div></div></div>)}</div> : <EmptyState icon="✓" title="All caught up" text="New hotel access requests will appear here."/>}{inviteLink && <div className="sandbox-reset"><strong>One-time manager setup link:</strong> <a href={inviteLink}>{inviteLink}</a><button className="text-button" onClick={() => navigator.clipboard?.writeText(new URL(inviteLink, window.location.origin).toString())}>Copy</button></div>}</div>}
    {view === "workers" && <div className="admin-columns">
      <div className="panel"><div className="panel-head"><div><h3>Worker verification</h3><span className="muted">Approve only after checking registration details.</span></div><span className="count-pill">{pendingWorkers.length} pending</span></div><WorkerTable workers={data.workers || []} busy={busy} onVerify={(id: string) => props.onRun(async () => { await api(`admin/workers/${id}`, "PATCH", { verified: true, reason: "Manually verified during pilot." }); }, "Worker verified.")} onToggleAlerts={toggleWorkerAlerts}/></div>
      <div className="panel add-worker-panel"><div className="panel-head"><div><h3>Add worker</h3><span className="muted">WhatsApp registration simulator</span></div><span className="sandbox-tag"><span/> SANDBOX</span></div><form onSubmit={async (event) => { event.preventDefault(); await props.onRun(async () => { await api("sandbox/workers", "POST", { ...workerForm, roles: workerForm.roles, skills: workerForm.skills }); setWorkerForm(initialWorkerForm); }, "Worker profile created. Verify it before matching."); }}>
        <Field label="Worker name"><input required value={workerForm.name} onChange={(e) => setWorkerForm({ ...workerForm, name: e.target.value })}/></Field><Field label="WhatsApp number"><input required value={workerForm.phone} onChange={(e) => setWorkerForm({ ...workerForm, phone: e.target.value })} placeholder="+91…"/></Field>
        <div className="form-grid two"><Field label="City / pilot area"><input value={workerForm.city} onChange={(e) => setWorkerForm({ ...workerForm, city: e.target.value })} placeholder="Use pilot area"/></Field><Field label="Work area or landmark"><input required value={workerForm.area} onChange={(e) => setWorkerForm({ ...workerForm, area: e.target.value })}/></Field></div>
        <div className="form-grid two"><Field label="Approx. latitude"><input required inputMode="decimal" placeholder="28.6139" value={workerForm.latitude} onChange={(e) => setWorkerForm({ ...workerForm, latitude: e.target.value })}/></Field><Field label="Approx. longitude"><input required inputMode="decimal" placeholder="77.2090" value={workerForm.longitude} onChange={(e) => setWorkerForm({ ...workerForm, longitude: e.target.value })}/></Field></div>
        <Field label="Roles (comma separated)"><input required value={workerForm.roles} onChange={(e) => setWorkerForm({ ...workerForm, roles: e.target.value })}/></Field>
        <div className="form-grid two"><Field label="Skills / experience"><input value={workerForm.skills} onChange={(e) => setWorkerForm({ ...workerForm, skills: e.target.value })}/></Field><Field label="Available weekdays"><input value={workerForm.availability} onChange={(e) => setWorkerForm({ ...workerForm, availability: e.target.value })} placeholder="Mon,Tue,Sat"/></Field></div>
        <div className="form-grid two"><Field label="Preferred language"><input value={workerForm.language} onChange={(e) => setWorkerForm({ ...workerForm, language: e.target.value })}/></Field><Field label="Travel radius (km)"><input type="number" min="1" max="100" value={workerForm.radiusKm} onChange={(e) => setWorkerForm({ ...workerForm, radiusKm: e.target.value })}/></Field></div>
        <label className="consent-row"><input type="checkbox" checked={workerForm.consent} onChange={(e) => setWorkerForm({ ...workerForm, consent: e.target.checked })}/> Worker agreed to receive shift alerts on WhatsApp</label>
        <button className="primary-button full" disabled={busy || !workerForm.consent}>Add pending profile</button><small className="muted">Use an approximate landmark pin; do not enter a home address. Worker alerts stay paused until consent is recorded.</small>
      </form></div>
    </div>}
    {view === "messages" && <div className="admin-columns"><div className="panel"><div className="panel-head"><div><h3>Invitation inbox</h3><span className="muted">Simulate worker replies to test the flow.</span></div><span className="sandbox-tag"><span/> SANDBOX</span></div>{(data.invitations || []).length ? <div className="table-wrap"><table><thead><tr><th>WORKER / SHIFT</th><th>STATUS</th><th>REPLY SIMULATOR</th></tr></thead><tbody>{data.invitations.map((invite: AnyRecord) => <tr key={invite.id}><td><strong>{invite.worker_name}</strong><small>{invite.role} · {invite.hotel_name} · {dateLabel(invite.shift_date)}</small></td><td><StatusPill status={invite.status}/></td><td>{invite.status === "invited" ? <div className="table-actions"><button className="mini-button green" disabled={busy} onClick={() => props.onRun(async () => { await api(`sandbox/invitations/${invite.id}/reply`, "POST", { status: "interested" }); }, "Worker marked interested.")}>Interested</button><button className="mini-button" disabled={busy} onClick={() => props.onRun(async () => { await api(`sandbox/invitations/${invite.id}/reply`, "POST", { status: "unavailable" }); }, "Worker marked unavailable.")}>Unavailable</button></div> : "—"}</td></tr>)}</tbody></table></div> : <EmptyState title="No invitations yet" text="Post a shift as a hotel manager and send the first worker batch to see messages here."/>}</div><div className="panel"><div className="panel-head"><div><h3>Recent message log</h3><span className="muted">Sandbox messages are never sent externally.</span></div></div><div className="message-log">{(data.messages || []).slice(0, 12).map((message: AnyRecord) => <div className="message-item" key={message.id}><div className={`message-direction ${message.direction}`}>{message.direction === "outbound" ? "↗" : "↙"}</div><div><strong>{message.worker_name || "Hostshift"}</strong><p>{message.body}</p><small>{new Date(message.created_at).toLocaleString()} · {prettyStatus(message.status)}</small></div></div>)}{!(data.messages || []).length && <EmptyState title="No messages yet" text="Simulated WhatsApp messages will be logged here."/>}</div></div><div className="panel"><div className="panel-head"><div><h3>Attendance simulator</h3><span className="muted">Use codes shown to the hotel manager; record exceptions with a reason.</span></div></div>{(data.assignments || []).filter((a: AnyRecord) => a.status !== "completed").slice(0, 8).map((assignment: AnyRecord) => <div className="sim-assignment" key={assignment.id}><div><strong>{assignment.worker_name}</strong><span>{assignment.role} · {dateLabel(assignment.shift_date)}</span></div><div className="sim-codes"><small>Start {assignment.start_code} · End {assignment.end_code}</small>{!assignment.checked_in_at && sandboxMode && <button className="mini-button" disabled={busy} onClick={() => props.onRun(async () => { await api(`sandbox/assignments/${assignment.id}/attendance`, "POST", { action: "check_in", code: assignment.start_code }); }, "Worker check-in simulated.")}>Check in</button>}{assignment.checked_in_at && !assignment.checked_out_at && sandboxMode && <button className="mini-button" disabled={busy} onClick={() => props.onRun(async () => { await api(`sandbox/assignments/${assignment.id}/attendance`, "POST", { action: "check_out", code: assignment.end_code }); }, "Worker check-out simulated.")}>Check out</button>}{assignment.hours_approved && !assignment.worker_hours_confirmed && sandboxMode && <button className="mini-button green" disabled={busy} onClick={() => props.onRun(async () => { await api(`sandbox/assignments/${assignment.id}/confirm-hours`, "POST", {}); }, "Worker confirmed hours.")}>Confirm hours</button>}{assignment.status === "no_show_review" && sandboxMode && <><button className="mini-button green" disabled={busy} onClick={() => props.onRun(async () => { await api(`sandbox/assignments/${assignment.id}/no-show-response`, "POST", { response: "attended" }); }, "Simulated worker reports attendance.")}>Worker says attended</button><button className="mini-button" disabled={busy} onClick={() => props.onRun(async () => { await api(`sandbox/assignments/${assignment.id}/no-show-response`, "POST", { response: "confirms_absence" }); }, "Worker response recorded.")}>Worker confirms absence</button></>}</div>{!assignment.checked_out_at && <ManualAttendanceControl assignment={assignment} busy={busy} onRun={props.onRun}/>}</div>)}{!(data.assignments || []).length && <EmptyState title="No confirmed shifts" text="Confirmed worker assignments will appear here."/>}</div></div>}
    {view === "payments" && <><div className="callout info"><span>ⓘ</span><div><strong>Collection and payout are separate records</strong><p>Sandbox completion marks both steps as simulated. No real funds move until a payment provider is configured.</p></div></div><div className="panel"><PaymentTable payments={data.payments || []} adminView busy={busy} onSimulate={(id: string) => props.onRun(async () => { await api(`payments/${id}/sandbox-success`, "POST", {}); }, "Sandbox collection and payout simulated.")}/></div></>}
    {view === "disputes" && <div className="admin-columns"><div className="panel"><div className="panel-head"><div><h3>Attendance and payment disputes</h3><span className="muted">Wait for worker response on no-show reports; record a decision and reason.</span></div></div>{(data.disputes || []).length ? <div className="dispute-list">{data.disputes.map((dispute: AnyRecord) => <div className="dispute-card" key={dispute.id}><div className="dispute-top"><div><strong>{dispute.category} · {dispute.hotel_name}</strong><span>{dispute.worker_name} · {dispute.role} · {dateLabel(dispute.shift_date)}</span></div><StatusPill status={dispute.status}/></div><p>{dispute.description}</p>{dispute.status === "open" ? <div className="resolve-row">{dispute.category === "no_show" && <select aria-label="No-show outcome" value={disputeDecision[dispute.id] || "confirmed_no_show"} onChange={(e) => setDisputeDecision({ ...disputeDecision, [dispute.id]: e.target.value })}><option value="confirmed_no_show">No-show confirmed after response window</option><option value="worker_attendance_reported">Worker says they attended; review attendance</option></select>}<input placeholder="Resolution reason" value={disputeReason[dispute.id] || ""} onChange={(e) => setDisputeReason({ ...disputeReason, [dispute.id]: e.target.value })}/><button className="primary-button small" disabled={!disputeReason[dispute.id]?.trim() || busy} onClick={() => props.onRun(async () => { await api(`admin/disputes/${dispute.id}/resolve`, "POST", { decision: disputeDecision[dispute.id] || "reviewed", reason: disputeReason[dispute.id] }); }, "Dispute resolved.")}>Resolve</button></div> : <small className="muted">{dispute.decision}: {dispute.reason}</small>}</div>)}</div> : <EmptyState title="No disputes recorded" text="Attendance or payment disputes will appear here."/>}</div>
      <div className="panel"><div className="panel-head"><div><h3>Hotel support queue</h3><span className="muted">Requests are tied to the hotel manager account.</span></div></div>{(data.supportRequests || []).length ? <div className="dispute-list">{data.supportRequests.map((request: AnyRecord) => <div className="dispute-card" key={request.id}><div className="dispute-top"><div><strong>{request.category} · {request.hotel_name}</strong><span>{request.manager_name} · {new Date(request.created_at).toLocaleString()}</span></div><StatusPill status={request.status}/></div><p>{request.description}</p>{request.status === "open" ? <div className="resolve-row"><input placeholder="Resolution note" value={supportReason[request.id] || ""} onChange={(e) => setSupportReason({ ...supportReason, [request.id]: e.target.value })}/><button className="primary-button small" disabled={!supportReason[request.id]?.trim() || busy} onClick={() => props.onRun(async () => { await api(`admin/support/${request.id}/resolve`, "POST", { reason: supportReason[request.id] }); }, "Support request resolved.")}>Resolve</button></div> : <small className="muted">{request.resolution}</small>}</div>)}</div> : <EmptyState title="No support requests" text="Hotel manager requests will appear here."/>}</div></div>}
    {view === "settings" && <div className="panel settings-panel"><div className="panel-head"><div><h3>Pilot settings</h3><span className="muted">Tune the pilot area, supported roles, batch size, and fees.</span></div></div>
      <form className="settings-grid" onSubmit={(event) => { event.preventDefault(); props.onRun(async () => { await api("admin/settings", "POST", { ...settingForm, supported_roles: supportedRolesText.split(",").map((role) => role.trim()).filter(Boolean) }); }, "Pilot settings saved."); }}>
        <Field label="Pilot area"><input value={settingForm.pilot_area || ""} onChange={(e) => setSettingForm({ ...settingForm, pilot_area: e.target.value })}/></Field>
        <Field label="Supported job roles"><input value={supportedRolesText} onChange={(e) => setSupportedRolesText(e.target.value)} placeholder="Banquet Server, Kitchen Assistant"/><small>Comma-separated. These become the hotel's available roles.</small></Field>
        <Field label="Invitation batch multiplier"><input type="number" min="1" max="5" step="1" value={settingForm.batch_multiplier || "2"} onChange={(e) => setSettingForm({ ...settingForm, batch_multiplier: e.target.value })}/><small>Invites per opening in each batch.</small></Field>
        <Field label="Response window (minutes)"><input type="number" min="5" max="1440" value={settingForm.response_window_minutes || "45"} onChange={(e) => setSettingForm({ ...settingForm, response_window_minutes: e.target.value })}/></Field>
        <Field label="Hotel cancellation cutoff (hours)"><input type="number" min="0" max="168" value={settingForm.cancellation_window_hours || "24"} onChange={(e) => setSettingForm({ ...settingForm, cancellation_window_hours: e.target.value })}/></Field>
        <Field label="Late cancellation compensation (%)"><input type="number" min="0" max="100" value={settingForm.late_cancel_compensation_percent || "50"} onChange={(e) => setSettingForm({ ...settingForm, late_cancel_compensation_percent: e.target.value })}/></Field>
        <Field label="Hostshift fee (%)"><input type="number" min="0" max="50" step="0.5" value={settingForm.platform_fee_percent || "8"} onChange={(e) => setSettingForm({ ...settingForm, platform_fee_percent: e.target.value })}/></Field>
        <div className="settings-submit"><button className="primary-button" disabled={busy}>Save settings</button></div>
      </form>
      <div className="callout warning"><span>!</span><div><strong>Location setup</strong><p>Hotel and worker coordinates are managed manually by the pilot team. Distances are straight-line estimates, not travel-time estimates.</p></div></div>
    </div>}
    {view === "audit" && <div className="panel"><div className="panel-head"><div><h3>Admin activity history</h3><span className="muted">Manual decisions, actor, timestamp, and reason.</span></div><span className="count-pill">{data.auditLogs?.length || 0} recent</span></div>{data.auditLogs?.length ? <div className="audit-list">{data.auditLogs.map((log: AnyRecord) => <div className="audit-row" key={log.id}><div className="audit-mark">◷</div><div><strong>{prettyStatus(log.action)}</strong><span>{log.actor_name || "System"} · {log.entity_type} · {log.entity_id}</span>{log.reason && <p>{log.reason}</p>}</div><time>{new Date(log.created_at).toLocaleString()}</time></div>)}</div> : <EmptyState title="No activity yet" text="Admin decisions and account actions will be recorded here."/>}</div>}
  </>;
}

function Metric({ icon, title, value, foot, accent }: { icon: string; title: string; value: string; foot: string; accent: string }) {
  return <div className="metric-card"><div className={`metric-icon ${accent}`}>{icon}</div><div className="metric-content"><span>{title}</span><strong>{value}</strong><small>{foot}</small></div><span className="metric-arrow">↗</span></div>;
}

function ShiftRow({ shift, onClick }: { shift: AnyRecord; onClick: () => void }) {
  return <button className="shift-row" onClick={onClick}><div className="date-tile"><strong>{new Date(`${shift.shift_date}T12:00:00`).getDate()}</strong><span>{new Date(`${shift.shift_date}T12:00:00`).toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</span></div><div className="shift-row-info"><strong>{shift.role}</strong><span>{shift.area} · {shift.start_time}–{shift.end_time}</span></div><div className="shift-row-stats"><strong>{shift.assigned_count || 0}<span> / {shift.headcount}</span></strong><span>workers</span></div><StatusPill status={shift.status}/><span className="row-arrow">→</span></button>;
}

function StatusPill({ status }: { status: string }) {
  const normalized = String(status || "pending").toLowerCase();
  return <span className={`status-pill ${normalized.replaceAll("_", "-")}`}><i/>{prettyStatus(normalized)}</span>;
}

function EmptyState({ icon = "◌", title, text, action, onAction }: { icon?: string; title: string; text: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><p>{text}</p>{action && onAction && <button className="text-link" onClick={onAction}>{action} →</button>}</div>;
}

function PaymentTable({ payments, adminView, busy, onOpen, onSimulate }: { payments: AnyRecord[]; adminView?: boolean; busy?: boolean; onOpen?: (payment: AnyRecord) => void; onSimulate?: (id: string) => void }) {
  return payments.length ? <div className="panel payment-panel"><div className="table-wrap"><table><thead><tr><th>SHIFT / WORKER</th>{adminView && <th>HOTEL</th>}<th>WORKER PAY</th><th>HOTEL FEE</th><th>COLLECTION</th><th>PAYOUT</th>{(adminView || onOpen) && <th/>}</tr></thead><tbody>{payments.map((payment) => <tr key={payment.id}><td><strong>{payment.role || "Shift"}</strong><small>{payment.worker_name || "Worker"} · {payment.shift_date || ""}</small></td>{adminView && <td>{payment.hotel_name}</td>}<td>{money(payment.worker_pay)}</td><td>{money(payment.platform_fee)}</td><td><StatusPill status={payment.collection_status}/></td><td><StatusPill status={payment.payout_status}/></td>{adminView && <td>{payment.collection_status !== "received" && (paymentQrExpired(payment) ? <span className="hint-pill">QR expired</span> : <button className="mini-button green" disabled={busy} onClick={() => onSimulate?.(payment.id)}>Simulate success</button>)}</td>}{onOpen && !adminView && <td><button className="row-arrow" onClick={() => onOpen(payment)}>QR / details →</button></td>}</tr>)}</tbody></table></div></div> : <EmptyState icon="₹" title="No payments yet" text="After a shift is completed and hours are approved, its payment request will appear here."/>;
}

function ShiftAdminTable({ shifts }: { shifts: AnyRecord[] }) {
  return shifts.length ? <div className="table-wrap compact"><table><thead><tr><th>ROLE</th><th>HOTEL</th><th>DATE</th><th>TEAM</th><th>STATUS</th></tr></thead><tbody>{shifts.map((shift) => <tr key={shift.id}><td><strong>{shift.role}</strong></td><td>{shift.hotel_name}</td><td>{dateLabel(shift.shift_date)}</td><td>{shift.assigned_count}/{shift.headcount}</td><td><StatusPill status={shift.status}/></td></tr>)}</tbody></table></div> : <EmptyState title="No shifts yet" text="Hotel shifts will appear here."/>;
}

function WorkerTable({ workers, busy, onVerify, onToggleAlerts }: { workers: AnyRecord[]; busy: boolean; onVerify: (id: string) => void; onToggleAlerts: (worker: AnyRecord) => void }) {
  return workers.length ? <div className="table-wrap"><table><thead><tr><th>WORKER</th><th>ROLES / SKILLS</th><th>AREA / RADIUS</th><th>AVAILABILITY</th><th>ALERTS</th><th>VERIFICATION</th></tr></thead><tbody>{workers.map((worker) => <tr key={worker.id}><td><strong>{worker.name}</strong><small>{worker.phone}</small></td><td>{parseList(worker.roles_json).join(", ")}<small>{parseList(worker.skills_json).join(", ") || "No extra skills listed"}</small></td><td>{worker.area}<small>{worker.city} · {worker.radius_km} km · {worker.latitude == null ? "no map pin" : "approx. pin set"}</small></td><td>{parseList(worker.availability_json).join(", ") || "Not set"}<small>{worker.language || "Language not set"}</small></td><td><button className={`mini-button ${worker.opted_in ? "" : "green"}`} disabled={busy} onClick={() => onToggleAlerts(worker)}>{worker.opted_in ? "Pause alerts" : "Resume alerts"}</button></td><td>{worker.verified ? <StatusPill status="verified"/> : <button className="mini-button green" disabled={busy} onClick={() => onVerify(worker.id)}>Verify</button>}</td></tr>)}</tbody></table></div> : <EmptyState title="No worker profiles" text="Add or register workers to start the pilot."/>;
}

function DisputeMini({ dispute }: { dispute: AnyRecord }) {
  return <div className="mini-dispute"><div className="mini-dispute-icon">!</div><div><strong>{dispute.category} · {dispute.worker_name}</strong><span>{dispute.hotel_name} · {dispute.role}</span><small>{dispute.description}</small></div><StatusPill status={dispute.status}/></div>;
}

function ManualAttendanceControl({ assignment, busy, onRun }: { assignment: AnyRecord; busy: boolean; onRun: (action: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const action = assignment.checked_in_at ? "check_out" : "check_in";
  return <details className="manual-attendance"><summary>Record attendance manually</summary><div><input aria-label="Reason for manual attendance" placeholder="Phone issue, offline, etc." value={reason} onChange={(e) => setReason(e.target.value)}/><button className="mini-button" disabled={busy || !reason.trim()} onClick={() => onRun(async () => { await api(`admin/assignments/${assignment.id}/manual-attendance`, "POST", { action, reason }); setReason(""); }, action === "check_in" ? "Manual check-in recorded." : "Manual check-out recorded.")}>{action === "check_in" ? "Record check-in" : "Record check-out"}</button></div></details>;
}

function ShiftModal({ busy, hotel, supportedRoles, initialShift, onClose, onSubmit }: AnyRecord) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const roles: string[] = supportedRoles?.length ? supportedRoles : ["Banquet Server", "Housekeeping Attendant", "Kitchen Assistant", "Restaurant Service", "Front Desk Assistant"];
  const [form, setForm] = useState(() => initialShift ? { role: initialShift.role, skills: parseList(initialShift.skills_json).join(", "), headcount: String(initialShift.headcount), date: initialShift.shift_date, startTime: initialShift.start_time, endTime: initialShift.end_time, payAmount: String(initialShift.pay_amount), duties: initialShift.duties || "", cancellationTerms: initialShift.cancellation_terms || "" } : { role: "Banquet Server", skills: "Guest service", headcount: "3", date: tomorrow, startTime: "17:00", endTime: "23:00", payAmount: "1200", duties: "Support event setup and guest service.", cancellationTerms: "Late hotel cancellations are reviewed for agreed compensation." });
  const editing = Boolean(initialShift);
  return <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><form className="modal-card shift-modal" onSubmit={(event) => { event.preventDefault(); void onSubmit({ ...form, headcount: Number(form.headcount), payAmount: Number(form.payAmount), skills: form.skills.split(",").map((v) => v.trim()).filter(Boolean) }); }}><div className="modal-heading"><div><span className="eyebrow">{editing ? "EDIT TEMPORARY SHIFT" : "NEW TEMPORARY SHIFT"}</span><h2>{editing ? "Edit shift" : "Post a shift"}</h2><p>{hotel?.name || "Your hotel"} · {hotel?.area || "Hotel location"}, {hotel?.city || "Pilot area"}</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div><div className="form-grid two"><Field label="Role"><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roles.map((role) => <option key={role}>{role}</option>)}</select></Field><Field label="Workers needed"><input type="number" min="1" max="100" required value={form.headcount} onChange={(e) => setForm({ ...form, headcount: e.target.value })}/></Field></div><Field label="Required skills (comma separated)"><input value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })}/></Field><div className="form-grid three"><Field label="Date"><input type="date" min={editing ? undefined : tomorrow} required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}/></Field><Field label="Start"><input type="time" required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })}/></Field><Field label="End"><input type="time" required value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })}/></Field></div><Field label="Worker pay per shift (₹)"><input type="number" min="1" step="1" required value={form.payAmount} onChange={(e) => setForm({ ...form, payAmount: e.target.value })}/><small>Hostshift’s service fee is shown separately during payment.</small></Field><Field label="Duties"><textarea rows={3} value={form.duties} onChange={(e) => setForm({ ...form, duties: e.target.value })}/></Field><Field label="Cancellation terms shown to workers"><textarea rows={2} value={form.cancellationTerms} onChange={(e) => setForm({ ...form, cancellationTerms: e.target.value })}/></Field><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? (editing ? "Saving…" : "Posting…") : (editing ? "Save changes" : "Post shift")} <span>→</span></button></div></form></div>;
}

function AccessModal({ busy, onClose, onSubmit }: AnyRecord) {
  const [form, setForm] = useState({ hotelName: "", managerName: "", email: "", phone: "", city: "", area: "", address: "", password: "" });
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.password !== confirmPassword) { setError("The passwords do not match."); return; }
    setError("");
    void onSubmit(form);
  };
  return <div className="modal-scrim"><form className="modal-card" onSubmit={submit}><div className="modal-heading"><div><span className="eyebrow">HOTEL ACCESS</span><h2>Request hotel access</h2><p>A pilot admin will verify your hotel. Sign in with your chosen password after approval.</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div><Field label="Hotel name"><input required value={form.hotelName} onChange={(e) => setForm({ ...form, hotelName: e.target.value })}/></Field><div className="form-grid two"><Field label="Manager name"><input required value={form.managerName} onChange={(e) => setForm({ ...form, managerName: e.target.value })}/></Field><Field label="Phone"><input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}/></Field></div><Field label="Business email"><input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}/></Field><div className="form-grid two"><Field label="City"><input required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}/></Field><Field label="Area"><input required value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })}/></Field></div><Field label="Address"><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })}/></Field><Field label="Create password" hint="At least 10 characters; active after hotel approval."><input required type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={(e) => { setForm({ ...form, password: e.target.value }); setError(""); }}/></Field><Field label="Confirm password"><input required type="password" autoComplete="new-password" minLength={10} value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setError(""); }}/></Field>{error && <p className="form-validation-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>Submit request →</button></div></form></div>;
}

function PaymentModal({ payment, sandboxMode, onClose, onSimulate }: AnyRecord) {
  const overtimePay = Number(payment.overtime_pay || 0);
  const expiryTime = payment.expires_at ? new Date(payment.expires_at).getTime() : Number.NaN;
  const qrExpired = !Number.isFinite(expiryTime) || expiryTime <= Date.now();
  return <div className="modal-scrim"><div className="modal-card payment-modal"><div className="modal-heading"><div><span className="eyebrow">SHIFT PAYMENT</span><h2>Hotel collection QR</h2><p>This QR records the sandbox collection flow. It is not a payable UPI QR.</p></div><button type="button" className="close-button" onClick={onClose}>×</button></div><div className="qr-panel"><QRCodeSVG value={payment.qr_payload} size={192} level="M" bgColor="#ffffff" fgColor="#102c30"/><span className="sandbox-tag"><span/> SANDBOX · NO REAL PAYMENT</span><small>QR is linked to one Hostshift shift record and expires {Number.isFinite(expiryTime) ? new Date(expiryTime).toLocaleString() : "when replaced"}.</small></div>{qrExpired && payment.collection_status !== "received" && <div className="callout warning"><span>!</span><div><strong>This QR has expired</strong><p>Close this window and create a refreshed QR from the shift details.</p></div></div>}<div className="payment-breakdown"><div><span>Base shift pay</span><strong>{money(Number(payment.worker_pay) - overtimePay)}</strong></div>{overtimePay > 0 && <div><span>Agreed overtime pay</span><strong>{money(overtimePay)}</strong></div>}<div><span>Total worker pay</span><strong>{money(payment.worker_pay)}</strong></div><div><span>Hostshift fee</span><strong>{money(payment.platform_fee)}</strong></div><div className="total"><span>Total hotel payment</span><strong>{money(payment.total_amount)}</strong></div></div><div className="status-grid"><div><span>Hotel collection</span><StatusPill status={payment.collection_status}/></div><div><span>Worker payout</span><StatusPill status={payment.payout_status}/></div></div><div className="modal-actions"><button className="secondary-button" onClick={onClose}>Close</button>{sandboxMode && payment.collection_status !== "received" && !qrExpired && <button className="primary-button" onClick={onSimulate}>Simulate successful payment</button>}</div>{!sandboxMode && <small className="muted block">No live payment provider is configured.</small>}</div></div>;
}

function parseList(value: string): string[] { try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function adminTitle(view: View) { const titles: Record<string, string> = { overview: "Pilot overview", access: "Hotel requests", workers: "Worker verification", messages: "WhatsApp sandbox", payments: "Payment reconciliation", disputes: "Disputes and support", settings: "Pilot settings", audit: "Audit history" }; return titles[view] || "Pilot overview"; }
function adminSubtitle(view: View) { const subtitles: Record<string, string> = { overview: "Review the pilot activity and anything needing attention.", access: "Manually verify hotel partners before issuing manager invitations.", workers: "Review worker profiles before including them in shift matching.", messages: "Test registration, invitations, and replies without sending real WhatsApp messages.", payments: "Review payment collection and worker payout statuses.", disputes: "Resolve attendance, cancellation, and payment cases with a recorded reason.", settings: "Set the pilot area, response window, cancellation policy, and platform fee.", audit: "Review who changed what, when, and why." }; return subtitles[view] || "Hostshift pilot operations."; }
