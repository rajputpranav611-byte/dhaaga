import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type Appointment, type AskDhaagaProposalInput, type AskDhaagaResult, type Dose, type InteractionWarning, type Medication, type Proposal, type Role, type Snapshot, type WeekBraidDay, type WeeklyLetterPreview, type WeeklyLetterSendResult } from "./api";

type View = "Today" | "Medicines" | "Appointments" | "Brief" | "Circle" | "Letters";
const viewFromPath = (path: string): View => path === "/brief" ? "Brief" : path === "/outbox" ? "Letters" : "Today";
const roles: Role[] = ["Elder", "Caretaker", "Family"];
const demoCodes: Record<Role, string> = { Elder: "111111", Caretaker: "222222", Family: "333333" };
const demoEnabled = import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === "true";
type Language = "en" | "hi" | "gu";
const languageCopy: Record<Language, Record<string, string>> = {
  en: { Today: "Today", Medicines: "Medicines", Appointments: "Appointments", Brief: "Doctor brief", Circle: "Circle", Letters: "Letters", greeting: "Good morning", subtitle: "A new day to take things one bead at a time.", health: "YOUR HEALTH, IN A THREAD", rhythm: "Today’s rhythm", next: "Next up", take: "I took it", checkin: "How are you feeling?", coming: "Coming together", elderMode: "Elder mode", exitElder: "Exit elder mode", language: "LANGUAGE" },
  hi: { Today: "आज", Medicines: "दवाइयाँ", Appointments: "डॉक्टर से मिलना", Brief: "डॉक्टर के लिए", Circle: "अपने लोग", Letters: "चिट्ठियाँ", greeting: "सुप्रभात", subtitle: "आज का दिन, एक-एक धागे के मोती के साथ।", health: "आपकी सेहत का धागा", rhythm: "आज की लय", next: "अगली दवा", take: "मैंने ले ली", checkin: "आज आप कैसा महसूस कर रहे हैं?", coming: "आने वाली मुलाक़ात", elderMode: "आसान मोड", exitElder: "आसान मोड बंद करें", language: "भाषा" },
  gu: { Today: "આજ", Medicines: "દવાઓ", Appointments: "ડૉક્ટરની મુલાકાત", Brief: "ડૉક્ટર માટે", Circle: "આપણા લોકો", Letters: "પત્રો", greeting: "સુપ્રભાત", subtitle: "આજનો દિવસ, એકેક મણકા સાથે.", health: "તમારી સંભાળનો દોરો", rhythm: "આજની લય", next: "આગળ", take: "મેં લઈ લીધી", checkin: "આજે તમને કેવું લાગે છે?", coming: "આગામી મુલાકાત", elderMode: "સરળ મોડ", exitElder: "સરળ મોડ બંધ કરો", language: "ભાષા" },
};

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
function greetingName(name: string) { return name.split(/\s+/)[0] || "there"; }

function Thread({ doses, elderMode, language, onTake }: { doses: Dose[]; elderMode: boolean; language: Language; onTake: (dose: Dose, status: "taken" | "skipped") => void }) {
  const sorted = [...doses].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  const complete = sorted.filter((dose) => dose.status === "taken" || dose.status === "late").length;
  const upcoming = sorted.filter((dose) => dose.status === "pending");
  const adherence = sorted.length ? complete / sorted.length : 1;
  const summary = `${complete} of ${sorted.length} doses taken today, ${upcoming.length} upcoming${upcoming.length ? ` at ${timeLabel(upcoming[0].scheduled_at)}` : ""}`;
  const points = sorted.map((dose, index) => {
    const x = sorted.length < 2 ? 80 : 42 + (index * 440) / (sorted.length - 1);
    const hour = new Date(dose.scheduled_at).getHours();
    const y = 52 + Math.sin((hour / 24) * Math.PI * 2) * (22 * (1 - adherence));
    return { dose, x, y };
  });
  return (
    <div className="thread-wrap">
      <div className="thread-topline"><span>YOUR DAY, HELD TOGETHER</span><span>{complete}/{sorted.length} beads gathered</span></div>
      <svg className="day-thread" viewBox="0 0 520 130" role="img" aria-label={summary}>
        <path className="thread-path" d={points.length > 1 ? `M ${points.map((point) => `${point.x} ${point.y}`).join(" L ")}` : "M 42 52 L 478 52"} />
        {points.map(({ dose, x, y }) => {
          const taken = dose.status === "taken" || dose.status === "late";
          const missed = dose.status === "missed" || dose.status === "skipped";
          return (
            <g key={dose.id} className={missed ? "bead bead-missed" : taken ? "bead bead-taken" : "bead bead-upcoming"}>
              {missed && <path d={`M ${x - 13} ${y - 11} l 5 7 -6 3 6 5 -4 8 M ${x + 13} ${y - 12} l -5 7 6 3 -6 5 4 8`} className="fray" />}
              <circle cx={x} cy={y} r={elderMode ? 11 : 9} />
              <text x={x} y="105" textAnchor="middle">{timeLabel(dose.scheduled_at)}</text>
            </g>
          );
        })}
      </svg>
      <div className="thread-dose-list">
        {sorted.map((dose) => (
          <div className={`dose-row ${dose.status}`} key={dose.id}>
            <span className="dose-time">{timeLabel(dose.scheduled_at)}</span>
            <span className="dose-bead" aria-hidden="true" />
            <span className="dose-name"><strong>{dose.medication}</strong><small>{dose.dose}</small></span>
            <span className="dose-state">{dose.status === "taken" ? "Taken" : dose.status === "late" ? "Taken late" : dose.status === "missed" ? "Missed" : dose.status === "skipped" ? "Skipped" : "Up next"}</span>
            {dose.status === "pending" && <div className="dose-actions"><button className={elderMode ? "button button-take elder-take" : "button button-take"} onClick={() => onTake(dose, "taken")} type="button">{elderMode ? languageCopy[language].take : "Mark taken"}</button><button className="skip-dose" onClick={() => onTake(dose, "skipped")} type="button">Skip</button></div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function WeekBraid({ days }: { days: WeekBraidDay[] }) {
  const colors = ["braid-sage", "braid-gold", "braid-terracotta", "braid-ink", "braid-moss", "braid-ochre", "braid-clay"];
  const description = days.map((day) => `${day.label}: ${day.percentage === null ? "no scheduled doses" : `${day.percentage}% adherence, ${day.completed} of ${day.total} doses`}`).join("; ");
  const strands = days.map((day, index) => {
    const adherence = day.percentage === null ? 0.5 : day.percentage / 100;
    const amplitude = 3 + (1 - adherence) * 24;
    const baseline = 28 + index * 19;
    const points = Array.from({ length: 33 }, (_, step) => {
      const x = 12 + step * 16.75;
      const phase = step * (Math.PI / 4) + index * (Math.PI * 2 / 7);
      const y = baseline + Math.sin(phase) * amplitude;
      return `${step === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    return { day, color: colors[index], points };
  });
  return <section className="panel week-braid">
    <div className="panel-heading"><div><span className="eyebrow">SEVEN DAYS, HELD TOGETHER</span><h2>The week braid</h2></div><span className="status-chip circle-chip">ONE STRAND PER DAY</span></div>
    <figure className="week-braid-figure" aria-label={`Seven-day medication adherence braid. ${description}`}>
      <svg viewBox="0 0 560 190" aria-hidden="true" focusable="false">
        {strands.map(({ day, color, points }) => <path key={day.date} className={`week-braid-strand ${color}`} d={points} />)}
      </svg>
      <figcaption className="sr-only">{description}</figcaption>
    </figure>
    <div className="week-braid-days">{days.map((day, index) => <div className={`week-braid-day ${day.percentage !== null && day.percentage < 60 ? "braid-day-low" : ""}`} key={day.date}>
      <span className={`week-braid-dot ${colors[index]}`} aria-hidden="true" />
      <strong>{day.label}</strong>
      <b>{day.percentage === null ? "—" : `${day.percentage}%`}</b>
      <small>{day.total ? `${day.completed}/${day.total} doses` : "No doses"}</small>
    </div>)}</div>
    <p className="week-braid-note">More missed or pending beads loosen a strand. A day without scheduled doses is shown as “No doses.”</p>
  </section>;
}

function Login({ onLogin, demo }: { onLogin: (circle: string, role: Role, code: string, name: string, email: string) => void; demo: boolean }) {
  const [circle, setCircle] = useState("TULSI-4821");
  const [role, setRole] = useState<Role>("Elder");
  const [passcode, setPasscode] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (value: string) => {
    setError(""); setBusy(true);
    try { await onLogin(circle, role, value, name, email); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open this circle."); } finally { setBusy(false); }
  };
  return (
    <main className="landing">
      <a className="skip-link" href="#open-circle">Skip to sign in</a>
      <header className="landing-nav"><a className="wordmark" href="/"><span className="brand-mark">ध</span> dhaaga</a><span className="nav-note">CARE, HELD IN COMMON</span><a className="text-link" href="#how">How it works <span>↘</span></a></header>
      <section className="landing-hero">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-mark">✳</span> A shared care circle</p>
          <h1>Mum shouldn’t have to<br /><em>remember alone.</em></h1>
          <p className="hero-lede">A little thread through the day. Medicines, appointments, and the people who care — all held together.</p>
          <div className="hero-actions"><a className="button button-dark" href="#open-circle">Open a Circle <span>↗</span></a><span className="action-note">For elders, family &amp; trusted caretakers</span></div>
          <div className="landing-proof"><span className="proof-star">✳</span><span>Made for real life, together.</span><span className="proof-rule" /><span>Private by design</span></div>
        </div>
        <section className="hero-product" aria-label="Dhaaga daily health dashboard preview">
          <div className="product-top"><div className="window-dots"><i /><i /><i /></div><span className="product-caption">TULSI CIRCLE / TODAY</span><span className="privacy-lock">⌑ PRIVATE</span></div>
          <div className="product-body">
            <aside className="product-sidebar"><div className="mini-logo">ध.</div><span className="sidebar-selected">Today</span><span>Medicines</span><span>Appointments</span><span>Circle</span><span>Letters</span><div className="sidebar-elder"><span className="avatar">A</span><span>Amma<br /><small>your circle</small></span></div></aside>
            <div className="product-main"><div className="product-greeting"><span>{new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long" }).format(new Date()).toUpperCase()}</span><b>Good morning, Amma <span>✳</span></b><small>Your day is coming together.</small></div>
              <div className="preview-thread"><div><span>YOUR DAY, HELD TOGETHER</span><span>2 of 3 beads gathered</span></div><svg viewBox="0 0 430 100" aria-label="Preview of the day thread"><path d="M28 52 C 105 50, 133 50, 195 52 S 311 52, 400 52" /><circle className="gold-dot" cx="28" cy="52" r="8" /><circle className="gold-dot" cx="195" cy="52" r="8" /><circle className="hollow-dot" cx="400" cy="52" r="8" /><text x="28" y="83">8:00</text><text x="195" y="83">1:30</text><text x="400" y="83">8:00</text></svg><p><span className="tiny-check">✓</span> Morning tablet taken · by Amma</p></div>
              <div className="preview-bottom"><div><span className="preview-label">NEXT UP</span><b>Vitamin D</b><small>Tonight · 8:00 pm</small></div><span className="preview-outline">A gentle nudge ↗</span></div>
            </div>
          </div>
          <div className="product-footer"><span>✳</span> YOUR CARE CIRCLE, IN STEP <span className="footer-status">ALL TOGETHER <i /></span></div>
        </section>
      </section>
      <section className="trust-strip"><span>✳ <b>One shared picture</b> of the day</span><span>◷ <b>Gentle reminders</b>, never noise</span><span>♡ <b>Her care, her choices</b></span></section>
      <section className="pillbox-section" id="how"><div><p className="eyebrow">A WEEK, AT A GLANCE</p><h2>Small moments.<br /><em>Seen together.</em></h2></div><div className="week-tile" role="img" aria-label="Seven day medication adherence preview">{["M", "T", "W", "T", "F", "S", "S"].map((day, i) => <div key={`${day}-${i}`}><span>{day}</span><i className={i === 3 ? "tile-missed" : i > 4 ? "tile-future" : ""}>{i === 3 ? "–" : i > 4 ? "·" : "✓"}</i></div>)}</div></section>
      <section className="how-cards"><article><span>01 — REMEMBER</span><h3>The day, one bead at a time.</h3><p>Clear dose schedules, a living day-thread, and a soft nudge when it’s time.</p></article><article><span>02 — REASSURE</span><h3>Nothing changes behind her back.</h3><p>Family can help. Caretakers can suggest. She decides what becomes part of her care.</p></article><article><span>03 — REPORT</span><h3>Wellbeing is more than a tick.</h3><p>Check in with one tap, share the useful details, and keep everyone gently in the loop.</p></article></section>
      <section className="landing-cta" id="open-circle"><span className="cta-thread">✳ ───────── ✳</span><h2>Care is a thread.<br /><em>Let’s hold it together.</em></h2><p>Start with your circle ID and a private passcode.</p></section>
      <section className="login-card"><div className="login-intro"><span className="eyebrow">YOUR CIRCLE, YOUR PEOPLE</span><h2>Come on in.</h2><p>Enter your circle ID and the passcode you were given.</p></div>
        <div className="login-form"><label>Circle ID<input value={circle} onChange={(event) => setCircle(event.target.value.toUpperCase())} /></label><fieldset className="role-picker"><legend className="sr-only">Your role</legend>{roles.map((item) => <button type="button" key={item} aria-pressed={item === role} className={item === role ? "role-active" : ""} onClick={() => setRole(item)}>{item}</button>)}</fieldset>
          <label>Six-digit passcode<input inputMode="numeric" maxLength={6} value={passcode} onChange={(event) => setPasscode(event.target.value.replace(/\D/g, ""))} placeholder="· · · · · ·" /></label>
          <div className="join-fields"><label>Your name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="How should we call you?" /></label><label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="For gentle reminders" /></label></div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-dark login-submit" disabled={busy || passcode.length !== 6 || !name.trim() || !email.trim()} onClick={() => void submit(passcode)} type="button">{busy ? "Opening your circle…" : "Enter your circle"} <span>↗</span></button>
          {demo && <div className="demo-entries"><span>OR STEP INTO THE DEMO</span><div>{roles.map((item) => <button key={item} onClick={() => { setCircle("TULSI-4821"); setRole(item); void onLogin("TULSI-4821", item, demoCodes[item], item === "Elder" ? "Amma" : item === "Caretaker" ? "Maya" : "Ravi", ""); }} type="button">{item} <small>↗</small></button>)}</div><small>Demo passcodes: Elder 111111 · Caretaker 222222 · Family 333333</small></div>}
        </div>
      </section>
      <footer className="landing-footer"><a className="wordmark" href="/"><span className="brand-mark">ध</span> dhaaga</a><span>KEEP THE THREAD. KEEP EACH OTHER.</span><span>Made with care, in India · 2026</span></footer>
    </main>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname));
  const [notice, setNotice] = useState("");
  const [elderMode, setElderMode] = useState(false);
  const [language, setLanguage] = useState<Language>("en");
  const [mood, setMood] = useState(0);
  const [moodNote, setMoodNote] = useState("");
  const [medModal, setMedModal] = useState<Medication | "new" | null>(null);
  const [appointmentModal, setAppointmentModal] = useState<Appointment | "new" | null>(null);
  const [prescriptionDraft, setPrescriptionDraft] = useState<Omit<Medication, "id"> | null>(null);
  const [timeShift, setTimeShift] = useState(0);
  const [caretakerEscalation, setCaretakerEscalation] = useState(20);
  const [familyEscalation, setFamilyEscalation] = useState(45);
  const [briefData, setBriefData] = useState<Awaited<ReturnType<typeof api.doctorBrief>> | null>(null);
  const [briefQuestions, setBriefQuestions] = useState("");
  const [briefLoading, setBriefLoading] = useState(false);
  const [letterPreview, setLetterPreview] = useState<WeeklyLetterPreview | null>(null);
  const [letterBusy, setLetterBusy] = useState(false);

  const refresh = useCallback(async () => { const data = await api.bootstrap(); setSnapshot(data); }, []);
  const navigate = useCallback((next: View) => {
    setView(next);
    const path = next === "Letters" ? "/outbox" : next === "Brief" ? "/brief" : "/";
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  }, []);
  useEffect(() => { void api.session().then((authenticated) => authenticated ? refresh() : undefined).catch(() => undefined); }, [refresh]);
  useEffect(() => {
    const onPopState = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    if (view !== "Brief" || !snapshot) return;
    let active = true;
    setBriefLoading(true);
    api.doctorBrief().then((data) => {
      if (!active) return;
      setBriefData(data);
      setBriefQuestions(data.questions.join("\n"));
    }).catch((error: unknown) => {
      if (active) setNotice(error instanceof Error ? error.message : "The doctor brief could not be loaded.");
    }).finally(() => { if (active) setBriefLoading(false); });
    return () => { active = false; };
  }, [view, snapshot]);
  useEffect(() => {
    if (view !== "Letters" || !snapshot) return;
    let active = true;
    api.weeklyLetterPreview().then((preview) => { if (active) setLetterPreview(preview); })
      .catch((error: unknown) => { if (active) setNotice(error instanceof Error ? error.message : "The letter preview could not be loaded."); });
    return () => { active = false; };
  }, [view]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 3800); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!snapshot?.checkin) return;
    setMood(snapshot.checkin.mood);
    setMoodNote(snapshot.checkin.note);
  }, [snapshot?.checkin?.mood, snapshot?.checkin?.note]);
  useEffect(() => {
    if (!snapshot) return;
    setCaretakerEscalation(snapshot.circle.escalation_caretaker_minutes);
    setFamilyEscalation(snapshot.circle.escalation_family_minutes);
  }, [snapshot?.circle.escalation_caretaker_minutes, snapshot?.circle.escalation_family_minutes]);
  useEffect(() => { document.documentElement.lang = language === "hi" ? "hi" : language === "gu" ? "gu" : "en"; }, [language]);

  const handleLogin = async (circle: string, role: Role, passcode: string, name: string, email: string) => {
    await api.login({ circle, passcode, role, name: name || role, email });
    setView(viewFromPath(window.location.pathname));
    await refresh();
  };
  const act = async (task: () => Promise<unknown>, message: string) => {
    try { await task(); await refresh(); setNotice(message); } catch (error) { setNotice(error instanceof Error ? error.message : "Please try again."); }
  };
  const sendWeeklyLetterNow = async () => {
    setLetterBusy(true);
    try {
      const result: WeeklyLetterSendResult = await api.sendWeeklyLetterNow();
      await refresh();
      setLetterPreview(result);
      setNotice(result.recipientCount === 0
        ? "No Family member has an email address yet."
        : result.created
          ? result.sentAt ? "The weekly letter was sent and saved in the circle outbox." : `The weekly letter is saved in the outbox for ${result.recipientCount} Family member${result.recipientCount === 1 ? "" : "s"}.`
          : "This week’s letter was already sent or queued; it remains in the outbox.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The weekly letter could not be prepared.";
      if (message.includes("saved in the outbox")) {
        try { await refresh(); } catch { setNotice(`${message} The outbox could not refresh; revisit Letters to check it.`); return; }
      }
      setNotice(message);
    } finally { setLetterBusy(false); }
  };
  const advanceClock = (minutes: number, message: string) => {
    setTimeShift((current) => current + minutes);
    void act(() => api.advanceClock(minutes), message);
  };
  const readPrescription = async (file?: File) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { setNotice("That photo is over 4 MB. Please choose a smaller image."); return; }
    try {
      const result = await api.readPrescription(file);
      setPrescriptionDraft({ ...result.draft, days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] });
      setMedModal("new");
      setNotice("A draft is ready. Please check every detail before saving.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The prescription could not be read.");
    }
  };
  const nextDose = useMemo(() => snapshot?.doses.find((dose) => dose.status === "pending"), [snapshot]);

  if (!snapshot) return <Login onLogin={handleLogin} demo={demoEnabled} />;
  const role = snapshot.member.role;
  const pending = snapshot.proposals.filter((proposal) => proposal.status === "pending");
  const upcoming = snapshot.appointments.filter((appointment) => new Date(appointment.starts_at) >= new Date()).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const takenCount = snapshot.doses.filter((dose) => dose.status === "taken" || dose.status === "late").length;
  const adherence = snapshot.adherence.today;
  const canManage = role === "Elder" || role === "Caretaker";
  const nav: View[] = ["Today", "Medicines", "Appointments", "Brief", "Circle", "Letters"];
  const t = (key: string) => languageCopy[language][key] ?? key;

  return (
    <div className={elderMode ? "app-shell elder-mode" : "app-shell"}>
      <aside className="app-sidebar"><a className="wordmark" href="/"><span className="brand-mark">ध</span> dhaaga</a><div className="circle-badge"><span>CIRCLE / PRIVATE</span><strong>{snapshot.circle.name}</strong><small>{snapshot.circle.elder_name}’s care circle</small></div>
        <nav aria-label="Main navigation">{nav.map((item, index) => <button key={item} className={view === item ? "nav-active" : ""} onClick={() => navigate(item)} type="button"><span className="nav-icon">{["◷", "◉", "▤", "▧", "♧", "✉"][index]}</span>{t(item)}{item === "Circle" && pending.length > 0 && <i className="nav-count">{pending.length}</i>}</button>)}</nav>
        <button className="sidebar-mode" onClick={() => setElderMode(!elderMode)} type="button"><span>◉</span> {elderMode ? t("exitElder") : t("elderMode")} <kbd>↗</kbd></button>
        <div className="sidebar-member"><div className="avatar">{greetingName(snapshot.member.name).slice(0, 1)}</div><span><b>{snapshot.member.name}</b><small>{role} · <button onClick={() => void api.logout().then(() => { setSnapshot(null); navigate("Today"); setElderMode(false); })} type="button">Sign out</button></small></span></div>
      </aside>
      <main className="dashboard" id="dashboard-content" tabIndex={-1}>
        <a className="skip-link" href="#dashboard-content">Skip to main content</a>
        <header className="dashboard-top"><span className="breadcrumb">{t(view).toUpperCase()} <i>/</i> TULSI CIRCLE</span>{elderMode && <label className="language-picker"><span>{t("language")}</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)} aria-label="Choose language"><option value="en">English</option><option value="hi">हिन्दी</option><option value="gu">ગુજરાતી</option></select></label>}<button className="circle-presence" type="button"><i /> Circle is in step <span>↗</span></button></header>
        <AskDhaagaPanel role={role} onProposed={refresh} />
        {view === "Today" && <div className="page-content">
          <div className="dashboard-intro"><div><p className="eyebrow">{new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long" }).format(new Date()).toUpperCase()} <span>✳</span></p><h1>{t("greeting")}, {greetingName(snapshot.circle.elder_name)}.</h1><p className="intro-note">{t("subtitle")}</p></div><div className="day-stamp"><span>{t("Today").toUpperCase()}</span><b>{new Intl.DateTimeFormat("en-IN", { day: "2-digit" }).format(new Date())}</b><small>{new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date())}</small></div></div>
          {pending.length > 0 && role === "Elder" && <section className="approval-card"><div className="approval-icon">✳</div><div><span className="eyebrow">ELDER TASK · YOUR CHOICE</span><h2>{pending.length === 1 ? "A small change to consider." : `${pending.length} changes are waiting for you.`}</h2><p>{pending[0].proposed_by} suggested {pending[0].action === "create" ? `a new ${pending[0].entity}` : `an update to ${pending[0].entity}`}. Nothing changes until you say so.</p></div><button className="button button-dark" onClick={() => navigate("Circle")} type="button">Take a look <span>↗</span></button></section>}
          <div className="today-grid"><section className="panel thread-panel"><div className="panel-heading"><div><span className="eyebrow">{t("health")}</span><h2>{t("rhythm")}</h2></div><span className="status-chip circle-chip"><i /> CIRCLE TASK</span></div><Thread doses={snapshot.doses} elderMode={elderMode} language={language} onTake={(dose, status) => void act(() => api.setDose(dose.id, status), status === "taken" ? `${dose.medication} marked as taken.` : `${dose.medication} marked as skipped.`)} /><div className="thread-legend"><span><i className="legend-taken" /> Gathered</span><span><i className="legend-next" /> Coming up</span><span><i className="legend-missed" /> Missed / skipped</span><button onClick={() => { const speech = new SpeechSynthesisUtterance(`Today, ${takenCount} of ${snapshot.doses.length} medicines taken. ${nextDose ? `${nextDose.medication} is next at ${timeLabel(nextDose.scheduled_at)}.` : "You are all caught up."}`); speech.lang = language === "hi" ? "hi-IN" : language === "gu" ? "gu-IN" : "en-IN"; window.speechSynthesis?.speak(speech); }} type="button">▤ Read aloud</button></div></section>
            <div className="right-rail"><section className="panel next-panel"><div className="panel-heading"><div><span className="eyebrow">ON THE HORIZON</span><h2>{t("next")}</h2></div><span className="sun-icon">☼</span></div>{nextDose ? <div className="next-card"><span className="next-time">{timeLabel(nextDose.scheduled_at)}</span><b>{nextDose.medication}</b><small>{nextDose.dose}</small><button onClick={() => void act(() => api.setDose(nextDose.id, "taken"), "Dose marked as taken.")} className="button button-outline" type="button">{elderMode ? t("take") : "Mark as taken"} <span>↗</span></button></div> : <p className="empty-note">All of today’s doses are accounted for. Take a breath.</p>}</section>
              <section className="panel adherence-panel"><div><span className="eyebrow">ADHERENCE · TODAY</span><strong>{adherence}<small>%</small></strong><p>{takenCount} of {snapshot.doses.length} beads gathered</p><div className="adherence-periods"><span>7 days <b>{snapshot.adherence.week}%</b></span><span>30 days <b>{snapshot.adherence.month}%</b></span></div></div><svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="34" /><circle className="progress-ring" cx="42" cy="42" r="34" style={{ strokeDasharray: `${(adherence / 100) * 214} 214` }} /></svg></section></div></div>
          <WeekBraid days={snapshot.weekBraid} />
          <div className="lower-grid">          <section className="panel appointments-mini"><div className="panel-heading"><div><span className="eyebrow">A LITTLE PREPARATION</span><h2>Coming together</h2></div><button className="plain-link" onClick={() => navigate("Appointments")} type="button">All appointments ↗</button></div>{upcoming.length ? upcoming.slice(0, 2).map((appointment) => <AppointmentRow key={appointment.id} appointment={appointment} />) : <p className="empty-note">No appointments on the calendar just yet.</p>}</section>
            <section className="panel checkin-panel"><div className="panel-heading"><div><span className="eyebrow">A MOMENT FOR YOU</span><h2>{t("checkin")}</h2></div><span>♡</span></div><fieldset className="mood-faces"><legend className="sr-only">{t("checkin")}</legend>{["low", "okay", "fine", "good", "bright"].map((label, index) => <button key={label} aria-label={`${index + 1} ${label}`} aria-pressed={mood === index + 1} className={mood === index + 1 ? "mood-selected" : ""} onClick={() => setMood(index + 1)} type="button"><MoodFace mood={index + 1} /><span>{label}</span></button>)}</fieldset>{mood > 0 && <div className="checkin-note"><input aria-label="Optional check-in note" value={moodNote} onChange={(event) => setMoodNote(event.target.value)} placeholder="Anything you’d like us to know? (optional)" /><button onClick={() => void act(() => api.checkin(mood, moodNote), "Check-in shared with your circle.")} type="button">Share ↗</button></div>}</section></div>
          <div className="dashboard-footer-note"><span>✳</span> Care is not a checklist. It’s people, showing up for each other.</div>
          {demoEnabled && role === "Elder" && <section className="time-machine"><span>TIME MACHINE · DEMO</span><div><button onClick={() => advanceClock(10, "Demo clock advanced by 10 minutes.")} type="button">+10 min</button><button onClick={() => advanceClock(20, "Demo clock advanced by 20 minutes.")} type="button">+20 min</button><button onClick={() => advanceClock(45, "Demo clock advanced by 45 minutes.")} type="button">+45 min</button><button onClick={() => { const futureDose = snapshot.doses.find((dose) => dose.status === "pending" && Date.parse(dose.scheduled_at) > Date.now()); const minutes = futureDose ? Math.max(1, Math.ceil((Date.parse(futureDose.scheduled_at) - Date.now()) / 60_000)) : 45; advanceClock(minutes, "Demo clock moved to the next dose."); }} type="button">Next dose</button></div><small>Clock advanced {timeShift} minutes · the scheduler checks the new time right away</small></section>}
        </div>}
        {view === "Medicines" && <div className="page-content"><PageTitle eyebrow="THE DAILY THREAD" title="Medicines" note="A clear schedule, held together by your circle." action={canManage ? "Add a medicine" : undefined} onAction={() => { setPrescriptionDraft(null); setMedModal("new"); }} />{canManage && <label className="upload-button">✳ Build a draft from a prescription<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { void readPrescription(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>}<section className="panel content-panel"><div className="medication-grid">{snapshot.medications.map((medication) => <MedicationCard key={medication.id} medication={medication} doses={snapshot.doses.filter((dose) => dose.medication_id === medication.id)} canManage={canManage} onEdit={() => setMedModal(medication)} onRemove={() => { if (window.confirm(`Remove ${medication.name} from the circle?`)) void act(() => api.removeMedication(medication.id), role === "Caretaker" ? "Removal suggestion sent for approval." : "Medicine removed from the thread."); }} />)}</div>{snapshot.medications.length === 0 && <p className="empty-note">No medicines added yet.</p>}</section></div>}
        {view === "Appointments" && <div className="page-content"><PageTitle eyebrow="MAKE ROOM FOR CARE" title="Appointments" note="The next visits, and the details that make them easier." action={role !== "Family" ? "Add appointment" : "Suggest an appointment"} onAction={() => setAppointmentModal("new")} /><section className="panel content-panel">{upcoming.length ? upcoming.map((appointment) => <AppointmentRow key={appointment.id} appointment={appointment} canManage={role !== "Family"} onEdit={() => setAppointmentModal(appointment)} onRemove={() => { if (window.confirm(`Remove the visit with ${appointment.doctor}?`)) void act(() => api.removeAppointment(appointment.id), role === "Elder" ? "Appointment removed from the circle." : "Removal suggestion sent for approval."); }} />) : <p className="empty-note">No upcoming appointments. Add one when you’re ready.</p>}</section></div>}
        {view === "Brief" && <div className="page-content brief-page">
          <div className="brief-header"><PageTitle eyebrow="A CLEAR PICTURE FOR YOUR VISIT" title="Doctor brief" note="A one-page summary from your circle’s records." /><button className="button button-dark brief-print" onClick={() => window.print()} type="button">Print / Save as PDF</button></div>
          {briefLoading || !briefData ? <p className="empty-note">Preparing the brief from your circle’s records…</p> : <>
            <p className="brief-meta">Prepared for {briefData.elderName} · {new Date(briefData.generatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: snapshot.circle.timezone })}</p>
            <div className="brief-grid">
              <section className="panel brief-section"><h2>Current medicines</h2>{briefData.medications.length ? briefData.medications.map((medication) => <div className="brief-row" key={medication.id}><strong>{medication.name}</strong><span>{medication.dose}</span><span>{medication.schedule.join(", ")} · {medication.days.join(", ")}</span>{medication.instructions && <small>{medication.instructions}</small>}</div>) : <p>No current medicines are listed in this circle.</p>}</section>
              <section className="panel brief-section"><h2>Medicine adherence</h2><div className="brief-metrics">{([{ label: "Last 7 days", value: briefData.adherence.sevenDays }, { label: "Last 30 days", value: briefData.adherence.thirtyDays }]).map(({ label, value }) => <div key={label}><strong>{label}</strong><span>{value.percentage === null ? "No doses scheduled in this period." : `${value.percentage}% · ${value.completed} of ${value.total} doses`}</span></div>)}</div></section>
              <section className="panel brief-section"><h2>Missed or late doses · last 30 days</h2>{briefData.missedOrLate.length ? <ul>{briefData.missedOrLate.map((dose) => <li key={dose.id}><strong>{dose.medication}</strong> ({dose.dose}) · {dose.status} · {new Date(dose.scheduled_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: snapshot.circle.timezone })}</li>)}</ul> : <p>No missed or late doses are recorded in the last 30 days.</p>}</section>
              <section className="panel brief-section"><h2>Recent mood check-ins</h2>{briefData.moodTrend.length ? <ul>{briefData.moodTrend.map((entry) => <li key={entry.date}>{entry.date} · average mood {entry.average_mood}/5 · {entry.entries} {entry.entries === 1 ? "check-in" : "check-ins"}</li>)}</ul> : <p>No mood check-ins are recorded in the last 7 days.</p>}</section>
              <section className="panel brief-section"><h2>Upcoming appointments</h2>{briefData.appointments.length ? <ul>{briefData.appointments.map((appointment) => <li key={appointment.id}><strong>{appointment.doctor}</strong>{appointment.specialty && ` · ${appointment.specialty}`} · {new Date(appointment.starts_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: snapshot.circle.timezone })}{appointment.place && ` · ${appointment.place}`}</li>)}</ul> : <p>No upcoming appointments are listed in this circle.</p>}</section>
              <section className="panel brief-section brief-questions"><h2>Questions to ask the doctor</h2>{canManage ? <><label htmlFor="brief-questions">One question per line (up to 10).</label><textarea id="brief-questions" rows={4} maxLength={2010} value={briefQuestions} onChange={(event) => setBriefQuestions(event.target.value)} placeholder="Write questions you would like to discuss." /><button className="button button-outline" disabled={briefQuestions.split(/\r?\n/).filter((line) => line.trim()).length > 10} onClick={() => {
                const questions = briefQuestions.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
                void act(async () => { const result = await api.saveBriefQuestions(questions); setBriefQuestions(result.questions.join("\n")); return result; }, "Doctor questions saved.");
              }} type="button">Save questions</button></> : briefData.questions.length ? <ul>{briefData.questions.map((question, index) => <li key={`${index}-${question}`}>{question}</li>)}</ul> : <p>No questions have been added for the visit yet.</p>}</section>
            </div>
          </>}
        </div>}
        {view === "Circle" && <div className="page-content"><PageTitle eyebrow="PEOPLE WHO SHOW UP" title="Your circle" note="Everyone can help. Your care stays yours." /><section className="panel circle-panel"><div className="circle-member-row"><div className="avatar elder-avatar">{snapshot.circle.elder_name.slice(0, 1)}</div><div><strong>{snapshot.circle.elder_name}</strong><span>At the centre of this circle</span></div><span className="status-chip elder-chip">ELDER</span></div><div className="circle-member-row"><div className="avatar">C</div><div><strong>Trusted caretakers &amp; family</strong><span>Share the daily details and gentle reminders.</span></div><span className="status-chip circle-chip">CIRCLE TASK</span></div><div className="consent-setting"><div><strong>Direct edits by caretakers</strong><p>When off, changes wait for the elder’s approval.</p></div><span className={`toggle ${snapshot.circle.caretaker_direct_edit ? "toggle-on" : ""} ${role === "Elder" ? "" : "toggle-disabled"}`} role="switch" aria-label="Allow caretakers to make direct medicine changes" aria-checked={Boolean(snapshot.circle.caretaker_direct_edit)} aria-disabled={role !== "Elder"} tabIndex={0} onClick={() => role === "Elder" ? void act(() => api.updateCircle({ caretaker_direct_edit: !snapshot.circle.caretaker_direct_edit }), "Circle permissions updated.") : setNotice("Only the elder can change this circle setting.")} onKeyDown={(event) => { if (event.key === "Enter" && role === "Elder") void act(() => api.updateCircle({ caretaker_direct_edit: !snapshot.circle.caretaker_direct_edit }), "Circle permissions updated."); }} /></div><div className="escalation-setting"><div><strong>When the circle checks in</strong><p>A gentle caretaker note, then a family note if the dose is still unconfirmed.</p></div><label>Caretaker after<select disabled={role !== "Elder"} value={caretakerEscalation} onChange={(event) => setCaretakerEscalation(Number(event.target.value))}>{[10, 15, 20, 30, 45, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}</select></label><label>Family after<select disabled={role !== "Elder"} value={familyEscalation} onChange={(event) => setFamilyEscalation(Number(event.target.value))}>{[30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}</select></label>{role === "Elder" && <button className="button button-outline" onClick={() => void act(() => api.updateCircle({ escalation_caretaker_minutes: caretakerEscalation, escalation_family_minutes: familyEscalation }), "Circle reminders updated.")} type="button">Save reminder timing</button>}</div></section><section className="panel content-panel"><div className="panel-heading"><div><span className="eyebrow">ELDER CONSENT</span><h2>Changes, in the open</h2></div><span className="status-chip elder-chip">ELDER TASK</span></div>{pending.length ? pending.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} canDecide={role === "Elder"} onDecision={(decision) => void act(() => api.decide(proposal.id, decision), decision === "approved" ? "Your circle has been updated." : "Suggestion set aside.")} />) : <p className="empty-note">No suggestions waiting. This is your care, and your call.</p>}</section><section className="panel content-panel"><div className="panel-heading"><div><span className="eyebrow">THE LITTLE THINGS THAT CHANGED</span><h2>Circle notes</h2></div></div>{snapshot.audit.map((entry) => <div className="audit-row" key={entry.id}><span className="audit-dot" /><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><time>{new Date(entry.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</time></div>)}</section></div>}
        {view === "Letters" && <div className="page-content"><PageTitle eyebrow="A NOTE TO YOUR PEOPLE" title="Letters" note="A gentle weekly picture of how the week has been." /><section className="panel letter-panel"><div className="letter-stamp">✳</div><span className="eyebrow">SUNDAY LETTER · PREVIEW · {letterPreview?.weekKey ?? "LOADING"}</span><h2>{letterPreview?.subject ?? "A small note from your week"}</h2>{letterPreview ? <p className="letter-preview-copy">{letterPreview.body}</p> : <p>Your weekly letter preview is being prepared from the circle’s records.</p>}<div className="letter-signoff">A deterministic preview · {letterPreview?.recipientCount ?? 0} Family recipients</div>{role !== "Family" && <button className="button button-dark letter-send" disabled={letterBusy || !letterPreview} onClick={() => void sendWeeklyLetterNow()} type="button">{letterBusy ? "Preparing the letter…" : "Send this week’s letter now"} <span>↗</span></button>}</section>{role !== "Family" && <section className="panel content-panel outbox-panel"><div className="panel-heading"><div><span className="eyebrow">EMAILS, AS THEY WOULD ARRIVE</span><h2>Circle outbox</h2></div><span className="status-chip circle-chip">{snapshot.outbox.length} MESSAGES</span></div>{snapshot.outbox.length ? snapshot.outbox.map((mail) => <article className="outbox-message" key={mail.id}><div><span className="eyebrow">{mail.kind.replace(/-/g, " ").toUpperCase()} · {mail.to_email}</span><strong>{mail.subject}</strong><time>{mail.sent_at ? `Sent ${new Date(mail.sent_at).toLocaleString("en-IN")}` : "Saved in outbox"}</time></div><p>{mail.body}</p></article>) : <p className="empty-note">No messages just yet. Gentle reminders will appear here when the scheduler has something to share.</p>}</section>}</div>}
      </main>
      {notice && <div className="toast" role="status" aria-live="polite">{notice}<button onClick={() => setNotice("")} type="button">×</button></div>}
      {medModal && <MedicineModal initial={medModal === "new" ? undefined : medModal} suggested={prescriptionDraft ?? undefined} onClose={() => { setMedModal(null); setPrescriptionDraft(null); }} onSubmit={(value) => void act(() => medModal === "new" ? api.addMedication(value) : api.updateMedication(medModal.id, value), role === "Caretaker" ? "Suggestion sent to the elder." : medModal === "new" ? "Medicine added to the thread." : "Medicine updated.")} />}
      {appointmentModal && <AppointmentModal initial={appointmentModal === "new" ? undefined : appointmentModal} onClose={() => setAppointmentModal(null)} onSubmit={(value) => void act(() => appointmentModal === "new" ? api.addAppointment(value) : api.updateAppointment(appointmentModal.id, value), role === "Family" || role === "Caretaker" ? "Appointment suggestion sent for approval." : appointmentModal === "new" ? "Appointment added to the circle." : "Appointment updated.")} />}
    </div>
  );
}

function AskDhaagaPanel({ role, onProposed }: { role: Role; onProposed: () => Promise<void> }) {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AskDhaagaResult | null>(null);
  const [draftEntity, setDraftEntity] = useState<"medicine" | "appointment" | "unknown">("unknown");
  const [medicine, setMedicine] = useState<Omit<Medication, "id">>({ name: "", dose: "", instructions: "", schedule: [], days: [] });
  const [appointment, setAppointment] = useState<Omit<Appointment, "id">>({ doctor: "", specialty: "", place: "", notes: "", starts_at: "" });

  const parseCommand = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const parsed = await api.askDhaaga(command);
      setResult(parsed);
      if (parsed.status === "needs-details") {
        setDraftEntity(parsed.intent);
        setMedicine(parsed.medicine);
        setAppointment(parsed.appointment);
      } else {
        setCommand("");
        await onProposed();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The command could not be understood.");
    } finally { setBusy(false); }
  };

  const saveDraftAsProposal = async (event: FormEvent) => {
    event.preventDefault();
    if (draftEntity === "unknown") {
      setError("Choose whether this is a medicine or an appointment suggestion.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const input: AskDhaagaProposalInput = draftEntity === "medicine"
        ? { entity: "medicine", payload: medicine }
        : { entity: "appointment", payload: appointment };
      setResult(await api.submitAskDhaagaProposal(input));
      setCommand("");
      await onProposed();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The suggestion could not be saved.");
    } finally { setBusy(false); }
  };

  const warnings: InteractionWarning[] = result?.warnings ?? [];
  return <section className="ask-dhaaga" aria-label="Ask Dhaaga">
    <form className="ask-command" onSubmit={(event) => void parseCommand(event)}>
      <label htmlFor="ask-dhaaga-command"><span className="eyebrow">ASK DHAAGA · A SUGGESTION, NEVER A CHANGE</span><input id="ask-dhaaga-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Ask Dhaaga: add Papa’s evening BP tablet at 8pm" maxLength={500} /></label>
      <button className="button button-dark" disabled={busy || command.trim().length < 3} type="submit">{busy ? "Listening…" : "Ask Dhaaga"} <span>↗</span></button>
    </form>
    {result?.status === "proposal" && <div className="ask-result" role="status" aria-live="polite">
      <span className="status-chip approval-chip">NEEDS ELDER’S APPROVAL</span>
      <strong>{result.entity === "medicine" ? `Medicine suggestion: ${result.payload.name}` : `Appointment suggestion: ${result.payload.doctor}`}</strong>
      <p>{result.entity === "medicine" ? `${result.payload.dose} · ${result.payload.schedule.join(", ")} · ${result.payload.days.join(", ")}` : `${result.payload.starts_at ? new Date(result.payload.starts_at).toLocaleString() : "Date and time to be confirmed"}${result.payload.place ? ` · ${result.payload.place}` : ""}`}</p>
      {warnings.length > 0 && <InteractionNotes warnings={warnings} />}
      <small>Nothing is added to the care plan until the Elder approves it in Circle.</small>
    </div>}
    {result?.status === "needs-details" && <form className="ask-draft" onSubmit={(event) => void saveDraftAsProposal(event)}>
      <div className="ask-draft-heading"><span className="eyebrow">CHECK THE DETAILS BEFORE SUGGESTING</span><span className="status-chip elder-chip">DRAFT · NOT YET PROPOSED</span></div>
      {draftEntity === "unknown" && <label>What kind of suggestion?<select value="" onChange={(event) => setDraftEntity(event.target.value as "medicine" | "appointment")}><option value="">Choose one</option><option value="medicine" disabled={role === "Family"}>Medicine</option><option value="appointment">Appointment</option></select></label>}
      {draftEntity === "medicine" && <div className="ask-draft-grid">
        <label>Medicine name<input value={medicine.name} onChange={(event) => setMedicine({ ...medicine, name: event.target.value })} /></label>
        <label>Dose<input value={medicine.dose} onChange={(event) => setMedicine({ ...medicine, dose: event.target.value })} placeholder="e.g. 1 tablet or 5 mg" /></label>
        <label>Daily time(s), 12-hour format<input value={medicine.schedule.join(", ")} onChange={(event) => setMedicine({ ...medicine, schedule: event.target.value.split(",").map((time) => time.trim()).filter(Boolean) })} placeholder="e.g. 8:00 PM" /></label>
        <label>Notes (optional)<input value={medicine.instructions} onChange={(event) => setMedicine({ ...medicine, instructions: event.target.value })} /></label>
        <fieldset className="day-picker ask-days"><legend>Days</legend>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <label key={day}><input type="checkbox" checked={medicine.days.includes(day)} onChange={(event) => setMedicine({ ...medicine, days: event.target.checked ? [...medicine.days, day] : medicine.days.filter((item) => item !== day) })} />{day}</label>)}</fieldset>
      </div>}
      {draftEntity === "appointment" && <div className="ask-draft-grid">
        <label>Doctor<input value={appointment.doctor} onChange={(event) => setAppointment({ ...appointment, doctor: event.target.value })} placeholder="e.g. Dr. Shah" /></label>
        <label>Date and time<input type="datetime-local" value={dateTimeLocalValue(appointment.starts_at)} onChange={(event) => setAppointment({ ...appointment, starts_at: event.target.value ? new Date(event.target.value).toISOString() : "" })} /></label>
        <label>Specialty<input value={appointment.specialty} onChange={(event) => setAppointment({ ...appointment, specialty: event.target.value })} /></label>
        <label>Place<input value={appointment.place} onChange={(event) => setAppointment({ ...appointment, place: event.target.value })} /></label>
        <label className="ask-notes">Notes (optional)<input value={appointment.notes} onChange={(event) => setAppointment({ ...appointment, notes: event.target.value })} /></label>
      </div>}
      {warnings.length > 0 && <InteractionNotes warnings={warnings} />}
      <button className="button button-outline" disabled={busy || draftEntity === "unknown"} type="submit">{busy ? "Saving suggestion…" : "Send as a proposal"} <span>↗</span></button>
    </form>}
    {error && <p className="ask-error" role="alert">{error}</p>}
  </section>;
}

function InteractionNotes({ warnings }: { warnings: InteractionWarning[] }) {
  return <div className="ask-warnings"><span className="interaction-label">STARTER LIST · NOT EXHAUSTIVE</span>{warnings.map((warning) => <div className="interaction-warning" key={warning.title}><strong>{warning.title}</strong><span>{warning.note}</span></div>)}</div>;
}

function dateTimeLocalValue(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function PageTitle({ eyebrow, title, note, action, onAction }: { eyebrow: string; title: string; note: string; action?: string; onAction?: () => void }) {
  return <div className="page-title"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{note}</p></div>{action && <button className="button button-dark" onClick={onAction} type="button">{action} <span>↗</span></button>}</div>;
}
function AppointmentRow({ appointment, canManage = false, onEdit, onRemove }: { appointment: Appointment; canManage?: boolean; onEdit?: () => void; onRemove?: () => void }) {
  return <div className="appointment-row"><div className="appointment-date"><b>{new Intl.DateTimeFormat("en-IN", { day: "2-digit" }).format(new Date(appointment.starts_at))}</b><span>{new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date(appointment.starts_at))}</span></div><div className="appointment-info"><strong>{appointment.doctor}</strong><span>{appointment.specialty} · {timeLabel(appointment.starts_at)}</span><small>{appointment.place}{appointment.notes ? ` · ${appointment.notes}` : ""}</small></div>{canManage ? <div className="row-actions"><button onClick={onEdit} aria-label={`Edit visit with ${appointment.doctor}`} type="button">Edit</button><button onClick={onRemove} aria-label={`Remove visit with ${appointment.doctor}`} type="button">Remove</button></div> : <span className="appointment-arrow">↗</span>}</div>;
}
function MedicationCard({ medication, doses, canManage, onEdit, onRemove }: { medication: Medication; doses: Dose[]; canManage: boolean; onEdit: () => void; onRemove: () => void }) {
  return <article className="med-card"><div className="med-card-top"><span className="med-icon">✳</span><span className="status-chip circle-chip">CIRCLE TASK</span></div><h2>{medication.name}</h2><p>{medication.dose}</p><div className="med-instructions">{medication.instructions || "No extra instructions."}</div><div className="med-times">{medication.schedule.map((time) => <span key={time}>◷ {time}</span>)}</div><small>{doses.filter((dose) => dose.status === "taken").length} doses taken today</small>{canManage && <div className="row-actions"><button onClick={onEdit} type="button">Edit details</button><button onClick={onRemove} type="button">Remove</button></div>}</article>;
}
function ProposalCard({ proposal, canDecide, onDecision }: { proposal: Proposal; canDecide: boolean; onDecision: (decision: "approved" | "declined") => void }) {
  const payload = JSON.parse(proposal.payload) as Record<string, string>;
  return <div className="proposal-card"><span className="proposal-mark">↗</span><div className="proposal-copy"><span className="eyebrow">SUGGESTED BY {proposal.proposed_by.toUpperCase()}</span><strong>{proposal.action === "delete" ? `Remove ${payload.name || payload.doctor || proposal.entity}` : proposal.action === "create" ? `Add ${payload.name || payload.doctor || proposal.entity}` : `Update ${payload.name || payload.doctor || proposal.entity}`}</strong><p>{payload.dose ? `${payload.dose}${Array.isArray(payload.schedule) ? ` · ${payload.schedule.join(", ")}` : ""}` : payload.starts_at ? `${payload.doctor} · ${payload.place || ""}` : "A change to the care circle."}</p><small>{new Date(proposal.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</small></div>{canDecide ? <div className="proposal-actions"><button onClick={() => onDecision("approved")} className="button button-dark" type="button">Approve</button><button onClick={() => onDecision("declined")} className="button button-quiet" type="button">Not now</button></div> : <span className="status-chip approval-chip">NEEDS ELDER’S APPROVAL</span>}</div>;
}
function MoodFace({ mood }: { mood: number }) {
  const mouths = ["M 12 21 Q 24 11 36 21", "M 12 18 Q 24 22 36 18", "M 12 20 Q 24 20 36 20", "M 12 22 Q 24 14 36 22", "M 12 23 Q 24 11 36 23"];
  return <svg viewBox="0 0 48 48" aria-hidden="true"><path className="face-outline" d="M24 4 C12 3 4 12 4 24s8 20 20 20 20-8 20-20S36 4 24 4Z" /><circle cx="17" cy="18" r="1.8" /><circle cx="31" cy="18" r="1.8" /><path d={mouths[mood - 1]} /></svg>;
}
function MedicineModal({ initial, suggested, onClose, onSubmit }: { initial?: Medication; suggested?: Omit<Medication, "id">; onClose: () => void; onSubmit: (value: Omit<Medication, "id">) => void }) {
  const [name, setName] = useState(initial?.name ?? suggested?.name ?? ""); const [dose, setDose] = useState(initial?.dose ?? suggested?.dose ?? ""); const [schedule, setSchedule] = useState(initial?.schedule.join(", ") ?? suggested?.schedule.join(", ") ?? "8:00 AM"); const [instructions, setInstructions] = useState(initial?.instructions ?? suggested?.instructions ?? "");
  const [days, setDays] = useState(initial?.days ?? suggested?.days ?? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  const [warnings, setWarnings] = useState<{ title: string; note: string }[]>([]);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    if (!checked) {
      setChecking(true);
      try {
        const result = await api.checkInteractions(name);
        setWarnings(result.findings);
        setChecked(true);
        if (result.findings.length) return;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not check the starter list.");
        return;
      } finally { setChecking(false); }
    } else if (warnings.length) {
      setWarnings([]);
    }
    onSubmit({ name, dose, schedule: schedule.split(",").map((part) => part.trim()), days, instructions });
    onClose();
  };
  return <Modal title={initial ? "Edit a medicine" : "Add a medicine"} onClose={onClose}><label>Medicine name<input value={name} onChange={(e) => { setName(e.target.value); setChecked(false); setWarnings([]); }} placeholder="e.g. Vitamin D" /></label><label>Dose<input value={dose} onChange={(e) => setDose(e.target.value)} placeholder="e.g. 1 tablet" /></label><label>Daily time<input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="e.g. 8:00 AM" /></label><fieldset className="day-picker"><legend>Days of the week</legend>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <label key={day}><input type="checkbox" checked={days.includes(day)} onChange={(event) => setDays((current) => event.target.checked ? [...current, day] : current.filter((item) => item !== day))} />{day}</label>)}</fieldset><label>Notes (optional)<input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="With food, after breakfast…" /></label><p className="interaction-label">Starter interaction list · not exhaustive</p>{warnings.map((warning) => <div className="interaction-warning" key={warning.title}><strong>{warning.title}</strong><span>{warning.note}</span></div>)}{warnings.length > 0 && <p className="interaction-consent">Please discuss this with your doctor or pharmacist before adding it.</p>}{error && <p className="form-error">{error}</p>}<button className="button button-dark modal-submit" disabled={!name || !dose || !days.length || checking} onClick={() => void save()} type="button">{checking ? "Checking the starter list…" : warnings.length ? "I’ve checked with my care team" : "Save with care ↗"}</button></Modal>;
}
function AppointmentModal({ initial, onClose, onSubmit }: { initial?: Appointment; onClose: () => void; onSubmit: (value: Omit<Appointment, "id">) => void }) {
  const [doctor, setDoctor] = useState(initial?.doctor ?? ""); const [specialty, setSpecialty] = useState(initial?.specialty ?? ""); const [place, setPlace] = useState(initial?.place ?? ""); const [notes, setNotes] = useState(initial?.notes ?? ""); const [startsAt, setStartsAt] = useState(initial ? toLocalDateTime(initial.starts_at) : "");
  return <Modal title={initial ? "Edit an appointment" : "Add an appointment"} onClose={onClose}><label>Doctor’s name<input value={doctor} onChange={(e) => setDoctor(e.target.value)} placeholder="Dr. Meera Shah" /></label><label>Specialty<input value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="Cardiology" /></label><label>Place<input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Clinic or hospital" /></label><label>Date &amp; time<input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></label><label>Notes<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Bring last test results…" /></label><button className="button button-dark modal-submit" disabled={!doctor || !startsAt} onClick={() => { onSubmit({ doctor, specialty, place, notes, starts_at: new Date(startsAt).toISOString() }); onClose(); }} type="button">Save with care ↗</button></Modal>;
}
function toLocalDateTime(value: string) { const date = new Date(value); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); }
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, [onClose]);
  useEffect(() => { dialogRef.current?.focus(); }, []);
  return <div className="modal-backdrop" role="presentation"><section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-heading" tabIndex={-1}><button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button><span className="eyebrow">A LITTLE CARE, IN THE DETAILS</span><h2 id="modal-heading">{title}</h2><div className="modal-fields">{children}</div></section></div>;
}

export default App;
