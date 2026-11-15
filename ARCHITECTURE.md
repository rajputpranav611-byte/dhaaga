# Architecture

```mermaid
flowchart LR
  person["Elder / Caretaker / Family"] --> browser["React + Vite\nresponsive web app"]
  browser -->|"same-site cookie + X-Dhaaga-Action on writes"| api["Express + TypeScript API"]
  api --> auth["Passcode verifier\nscrypt + rate-limit + session"]
  api --> roles["Role checks + Zod validation"]
  roles --> sqlite[("SQLite\ncircle, members, medicines,\nschedules, doses, appointments,\nproposals, check-ins, brief questions,\naudit, sessions, outbox")]
  scheduler["30-second scheduler\nLuxon circle timezone"] --> sqlite
  scheduler -->|"Sunday 18:00 letter\nISO-week dedupe"| letters["Weekly family letter"]
  letters --> sqlite
  scheduler -->|optional| resend["Resend API"]
  browser -->|in-memory photo upload| api
  api -->|"optional parsing, wording,\nletter polish"| gemini["Gemini API"]
  api -->|"timezone-aware 7-day summary"| sqlite
```

## Request and consent flow

1. A member enters a circle ID and the role’s six-digit passcode. The passcode is checked against a per-code salt and scrypt hash; successful sign-in creates a random server-side session with a signed, HTTP-only, SameSite=Lax cookie.
2. The API resolves the session to a member and circle. Role middleware protects each write. Requests that mutate state must also include `X-Dhaaga-Action`.
3. Medication and appointment changes are validated before applying. Caretaker medicine changes are proposals unless the elder enabled direct edits; appointment suggestions from caretakers/family remain proposals. Ask Dhaaga validates command output and always creates a proposal; incomplete parses are returned for editing. Only an elder can approve or decline.
4. The scheduler evaluates dose and appointment windows in the circle timezone. It inserts emails with unique dedupe keys. Sunday letters are generated at 18:00 local circle time, keyed by ISO week; an Elder or Caretaker can also queue the current week manually. With no Resend key, messages remain visible in the outbox; with a key, pending messages are delivered.
5. Uploaded prescription images are validated in memory, used to create an editable draft, and discarded. They are never written to SQLite or disk.
6. The Doctor Brief reads medicines, adherence, dose events, check-ins, appointments, and saved questions from SQLite. The week braid summarizes the last seven local calendar days; its SVG paths have a textual alternative and reduced-motion styling.

## Storage

SQLite is the source of truth. `npm run seed` inserts the fictional Tulsi Circle and demo passcodes idempotently. `DHAAGA_DB` can point at another SQLite file; `:memory:` is supported for tests. The Sunday Letter and outbox share the same source data and persistence layer.
