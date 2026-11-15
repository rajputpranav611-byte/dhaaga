# Dhaaga prompts and product rules

## Product rules

- Product name: **Dhaaga (धागा, “thread”)** — Hold the thread together.
- The elder remains at the centre of decisions. Caretaker and family changes are suggestions unless the elder has deliberately enabled direct caretaker medicine edits.
- Keep the UI warm, legible, mobile-first, keyboard operable, and grounded in paper and ink: paper `#F3ECDD`, ink `#1C1B18`, terracotta `#D4552F`, sage `#2E4A3B`, and thread gold `#C9962B`.
- The day-thread uses beads for dose events: gathered/taken in gold, upcoming outlined, missed/skipped terracotta with a frayed end. Slack responds to adherence.
- Reminders are human and gentle. Never label an email “ALERT”. Do not log passcodes, health details, or member emails.
- Validate API inputs, enforce roles on the server, require approval before applying proposals, and deduplicate scheduled email output.
- Prescription photos are temporary, limited to 4 MB, and must never be stored. Interaction guidance is a non-exhaustive starter list and ends by directing the person to a doctor or pharmacist.
- Hindi and Gujarati text is initial product copy and requires native-language review.

## Master prompt

Build Dhaaga as a shared healthcare-management web app for an older adult, trusted caretakers, and family. Manage medicines, schedules, dose adherence, appointments, proposals, check-ins, audit history, and gentle reminders in one circle. Use React/Vite/TypeScript, Express/TypeScript, SQLite, Zod, Luxon, Vitest, scrypt sessions, a 30-second scheduler, optional Resend and Gemini integrations, and a deterministic no-key demo. Maintain the paper-and-ink visual system, accessible elder mode, consent-first collaboration, and honest status documentation. Do not present the app as medical advice or a certified medical device.

## Notable follow-up prompts

- “Add a medication edit path that uses the existing role matrix and keeps caretaker changes behind elder approval.”
- “Make the scheduler deterministic under an injected clock and verify both escalation thresholds and email deduplication.”
- “Add a responsive elder-mode language selector for English, Hindi, and Gujarati, and flag all untranslated or unreviewed strings.”
- “Before claiming a feature is complete, trace it from UI through API and persistence, add a focused regression test, and update the status table.”

## Completion prompt: Doctor Brief, Sunday Letter, Ask Dhaaga, and hardening

> **Process:** Start in planning mode, then proceed without waiting for approval. Complete steps in order, commit after each numbered step, and verify each step in the browser before moving on.
>
> **Step 0 — Gap audit:** Check the P1 list: thread timeline, elder consent, escalation ladder, prescription photo to schedule with mock fallback, offline interaction rules with optional Gemini wording, daily check-in, Elder Mode with read-aloud and EN/HI/GU, Time Machine, `/outbox`, and demo one-click logins. Print a Done/Missing table and implement missing items before continuing.
>
> **Step 1 — Doctor Brief (`/brief`):** Create a printable one-page profile with current medicines and schedules, 7/30-day adherence, dated missed/late doses, check-in mood trend, upcoming appointments, and editable doctor questions. Use database data only and state plainly when data is absent. All roles may read; only Elder and Caretaker may edit questions. Add an A4, black-on-white print stylesheet that hides navigation and an accessible “Print / Save as PDF” action.
>
> **Step 2 — Sunday Letter:** Send a short warm weekly email to Family members using real data: adherence this week vs last, mood trend, missed doses, upcoming appointments, and one gentle suggestion. Use deterministic templates by default. If Gemini is configured, it may polish wording but must not add facts: validate that every number in the output appears in the input data and otherwise fall back to the template. Schedule Sundays at 18:00 in the circle timezone and deduplicate by circle and ISO week. Add an Elder/Caretaker “Send this week’s letter now” action, show the result in `/outbox`, and provide a preview page.
>
> **Step 3 — Ask Dhaaga command bar:** Add a dashboard command bar, e.g. “add Papa’s evening BP tablet at 8pm”. Parse medicine or appointment requests using Gemini with a JSON schema when configured, otherwise use a small rule-based parser for names, doses, times (morning/evening/night/8pm), and “every day”. Validate with Zod. Every completed result must become a proposal marked “Needs Elder’s approval”; never apply it directly. If parsing is uncertain, provide an editable draft instead of guessing. Run the interaction check on proposed medicines.
>
> **Step 4 — Tests and hardening:** Expand `npm test` to at least 25 passing tests covering passcode verification/lockout; the role matrix on mutating routes; dose transitions; escalation at 20 and 45 minutes under a fake clock; email dedupe; interaction rules; proposal approval/decline; prescription and Ask Dhaaga Zod outputs; Sunday Letter fact-validation fallback; and upload size/MIME rejection. Run `npm audit` and the production build.
>
> **Step 5 — Week braid (only if time remains):** Add a seven-strand dashboard braid in pure SVG, one strand per day, tighter for high adherence and looser/tangled for low adherence. Use no libraries, respect `prefers-reduced-motion`, and provide a screen-reader text alternative.
>
> **Step 6 — Docs and repository:** Update the README feature-status table, marking Done only what was verified. Add screenshots for the Doctor Brief, Sunday Letter in outbox, and Ask Dhaaga proposal. Update `PROMPTS.md`; keep `ARCHITECTURE.md` and `SECURITY.md` accurate. Confirm `.env` is ignored and `.env.example` contains `EMAIL_FROM="Dhaaga <onboarding@resend.dev>"`. Run a fresh-clone check, `npm test`, build, `npm audit`, `git branch -a` (only `main`), and ensure tracked files total under 10 MB. Report a pass/fail list.
