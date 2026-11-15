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
