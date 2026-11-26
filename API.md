# API reference

## Auth

- `POST /auth/register` `{ name, email, password, role }`
- `POST /auth/login` `{ email, password }`
- `GET /auth/me`

## Classes

- `POST /classes` teacher only
- `GET /classes/teacher` teacher only
- `GET /classes/student` student only
- `POST /classes/join` student only `{ classId, joinCode? }`
- `GET /classes/:classId` authenticated class member/owner
- `GET /classes/:classId/requests` teacher owner only
- `PATCH /classes/:classId/members/:membershipId` teacher owner only `{ status }`

## Attendance

- `POST /attendance/sessions/start` teacher only `{ classId }`
- `POST /attendance/sessions/:sessionId/end` teacher owner only
- `GET /attendance/classes/:classId/current` teacher owner only
- `POST /attendance/mark` student only `{ classId, sessionId, acousticToken, bleToken? }`
- `GET /attendance/student/history` student only

The teacher dashboard is available by default. Set `ATTENDIFY_TEACHER_DASHBOARD=0` to disable these routes:

- `GET /teacher/attendance` opens the browser dashboard.
- `GET /teacher/attendance/session` returns the signed-in teacher's active session and accepted student roster.
- `POST /teacher/attendance/mark` records one enrolled student as present with `{ sessionId, studentId }`. Only the owning teacher can use this route. An existing row is kept intact.


## chirp-v1 acoustic verification extension

Deploy the matching mobile branch and backend together. No database schema migration is required. `/health` now includes `acousticProtocol: "chirp-v1"`. A signing secret of at least 32 characters is required at startup: `ACOUSTIC_TOKEN_SECRET`, or `JWT_SECRET` when the acoustic variable is unset.

Authenticated teacher start/current-session responses include `acoustic: { protocol, token, validUntil }`. Only the class owner can obtain these broadcast values. Student `/attendance/classes/:classId/active` responses intentionally never include an acoustic value.

Every `POST /attendance/mark` requires `acousticToken` (16 hex characters). Send `classId`, `sessionId`, and optionally a real `bleToken`. A session ID is allowed for the agreed BLE-failure fallback but never substitutes for the acoustic proof. A supplied BLE token must match the selected session. The old `ultrasoundVerified` boolean alone is rejected.

The value is HMAC-bound to class/session/current 20-second epoch. Current/previous epochs are accepted to accommodate in-flight audio; future or older values are rejected. Membership, teacher ownership, session end/expiry and idempotent unique attendance remain enforced. Responses identify `BLE_ACOUSTIC` versus `ACOUSTIC_FALLBACK` accurately. Expected proof values are never returned in student errors.

This establishes knowledge of a fresh broadcast challenge, not an attestation of microphone use or resistance to live relays/phone lending. The server cannot prove the Bluetooth adapter was enabled from a client flag.

### Validation

`npm test` runs the challenge unit tests and skips real-database integration unless explicitly configured. To run the HTTP/PostgreSQL suite, create a disposable **loopback** database named `attendify_test`, apply the existing Prisma migrations with `DIRECT_URL`, then run:

```sh
ATTENDIFY_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/attendify_test npm test
```

The integration guard rejects non-loopback or differently named database targets. The test API uses synthetic users and its own signing keys; it does not call the production deployment.
