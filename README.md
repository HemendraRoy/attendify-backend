# Attendify API — BLE and acoustic attendance

Express/TypeScript API with PostgreSQL and Prisma. This branch implements the `chirp-v1` acoustic contract for the companion `HemendraRoy/Attendify` mobile application. Update and deploy the app and backend together; legacy boolean-only acoustic submissions are rejected.

## Attendance behaviour

- Teachers create short-lived attendance sessions for their own classes; the BLE token is stored hashed.
- Start/current-session responses give only the owning teacher a fresh acoustic broadcast value and expiry.
- Accepted students can discover active session metadata without learning the acoustic value.
- Every mark requires `classId`, `sessionId`, and a decoded `acousticToken` (16 hex characters). A real `bleToken` is optional for the agreed acoustic/session fallback.
- A supplied BLE token must belong to the selected session. Acoustic values are independently HMAC-bound to class, session, and a 20-second epoch. Current/previous epochs are accepted; older and future values are rejected.
- Class membership, teacher ownership, session end/expiry, roles and duplicate protection remain enforced. Repeated/concurrent valid submissions use the existing unique attendance constraint and idempotent upsert.
- Responses identify `BLE_ACOUSTIC` or `ACOUSTIC_FALLBACK`. A server-session lookup never counts as BLE verification.

The API validates knowledge of a fresh classroom broadcast. It cannot attest microphone use or Bluetooth adapter state, prevent live forwarding, prove the student rather than a lent phone is present, or guarantee sound stays inside a room.

## Setup

Use Node >=20.19 and PostgreSQL. Copy `.env.example` to `.env` and supply real database URLs. `DATABASE_URL` is the runtime connection; `DIRECT_URL` is used for migrations/generation. Keep secrets out of Git.

`JWT_SECRET` must be a long random secret. Optionally set an independent `ACOUSTIC_TOKEN_SECRET`; whichever acoustic key is used must contain at least 32 characters. Configuration fails at startup if the acoustic key is missing or too short. `SESSION_TTL_SECONDS` defaults to 120 seconds.

```sh
npm ci
npm run db:generate
npm run db:migrate
npm run dev
```

For a deployment, `npm run build` generates Prisma and compiles TypeScript. `npm start` applies pending migrations and starts the built server. `/health` returns `acousticProtocol: "chirp-v1"` for client compatibility checking.

## Routes

See [API.md](API.md). Existing authentication, classes/join approvals, attendance history and teacher rosters remain available. Both authentication and accepted membership are required; the acoustic fallback is not an unauthenticated attendance path.

### Teacher attendance dashboard

Set `ATTENDIFY_TEACHER_DASHBOARD=1` in the existing Render service's **Environment** settings. Deploy this branch through the service's normal deploy flow. The start command applies the new attendance migration and the dashboard uses the service's existing database connection.

Open `/teacher/attendance`, sign in with the teacher's Attendify account, and select a student from the active class roster. **X · Mark present** saves one attendance record per student and session. The backend stores the teacher's ID and the existing attendance timestamp for the browser entry. The existing attendance screens display the resulting record.

## Tests

```sh
npm test
```

This runs acoustic challenge tests. Real HTTP/database integration runs only when explicitly pointed at a disposable loopback PostgreSQL database named `attendify_test`; otherwise that suite is reported skipped.

```sh
DIRECT_URL=postgresql://USER@127.0.0.1:PORT/attendify_test npx prisma migrate deploy
ATTENDIFY_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/attendify_test npm test
```

Integration tests use synthetic users and test signing keys, exercise the actual API, and clean up their rows. Never point a test suite at production. Classroom/microphone/BLE hardware tests belong to the mobile project's physical qualification checklist.
