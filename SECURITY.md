# Security notes

## Threat model

Dhaaga protects one care circle’s health details from casual cross-circle access and from unauthorized roles within a circle. It treats medicine names, schedules, dose history, check-ins, appointment details, member email addresses, and outbox messages as sensitive.

Controls implemented:

- Per-role passcodes are stored as scrypt hashes with per-code salts and compared with `timingSafeEqual`.
- Login failures are tracked by IP and normalized circle ID. Five failures in ten minutes start a fifteen-minute lock.
- Successful login creates an opaque server-side session. The browser receives a signed, HTTP-only, SameSite=Lax cookie with a fourteen-day expiry.
- A custom `X-Dhaaga-Action` header is required for state-changing API requests. CORS allows only configured origins (localhost defaults are for development).
- Helmet headers, strict JSON body limits, Zod request validation, role middleware, circle-scoped queries, and in-memory upload limits are enabled.
- Prescription images are MIME- and signature-checked, limited to 4 MB, processed from memory, and never persisted. Email HTML bodies are escaped.
- Application logs avoid member content, email addresses, passcodes, and request payloads.

## Known limits

- A six-digit role-shared passcode depends on rate limiting; it is not equivalent to individual multi-factor authentication. There is no passcode recovery flow or role-code rotation UI.
- SQLite is not encrypted at rest by the app. Protect the host, database file, backups, and outbox as sensitive data.
- Configure a strong `SESSION_SECRET`, HTTPS termination, production CORS origins, database backups, and access controls before deployment. The default local session secret is development-only.
- If Gemini is enabled, the selected prescription image is sent to Google for parsing, and interaction-finding text (which can include medicine names) may be sent for plain-language rewriting. Review provider terms and obtain appropriate consent before using real health information.
- Reminder delivery depends on scheduler uptime and the configured email provider. Outbox deduplication prevents repeated sends, but this is not a guaranteed delivery system.
- The interaction list is a small starter list, not a complete drug-interaction database. It cannot replace a doctor or pharmacist.
- Dhaaga is not a certified medical device and does not provide diagnosis, treatment, or medication instructions. Users should follow their care team’s instructions.

## Production checks

1. Set a high-entropy `SESSION_SECRET`, `NODE_ENV=production`, `DEMO_MODE=false`, and `VITE_DEMO_MODE=false`.
2. Use HTTPS, explicitly configure `ALLOWED_ORIGINS`, and confirm cookies are Secure through the deployment’s trusted proxy.
3. Keep `.env`, the database, backups, logs, and the email outbox out of public/static paths.
4. Review Hindi and Gujarati with native speakers and conduct a privacy, accessibility, and clinical-safety review before real-world use.
