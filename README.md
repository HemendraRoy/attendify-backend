# Attendify Backend

The backend is the server-side layer for the BLE attendance system. It handles authentication, class membership, attendance sessions, and server-side validation before a student is marked present.

## What this backend does

- registers teachers and students with email + password auth
- issues JWT tokens for authenticated access
- enforces teacher/student role-based routes
- creates classes and generates unique class join codes
- supports student class join requests and teacher approval workflows
- starts short-lived attendance sessions for a class
- verifies BLE-provided tokens against active sessions
- prevents duplicate attendance entries in the same session
- exposes teacher and student attendance data through API routes

## Tech stack

- Node.js
- Express
- TypeScript
- Prisma ORM
- PostgreSQL
- JWT
- Zod validation

## Project structure

```text
backend/
├── .env.example
├── API.md
├── package.json
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── render.yaml
├── src/
│   ├── generated/
│   ├── middleware/
│   ├── routes/
│   ├── utils/
│   └── server.ts
├── tsconfig.json
└── prisma.config.ts
```

## Core data model

The Prisma schema includes the following primary models:

- User — staff or student account, either TEACHER or STUDENT
- Class — a classroom owned by a teacher
- ClassMembership — membership request with status: PENDING, ACCEPTED, or REJECTED
- AttendanceSession — active or expired class attendance event
- Attendance — student attendance record for a session

### Important rules

- Each class has a unique join code.
- A teacher can have many classes.
- A student can request membership in a class and then be approved by the teacher.
- An attendance session is limited by expiry time.
- A student cannot be counted twice in the same session.

## Environment variables

Create a .env file from .env.example:

```env
DATABASE_URL="postgresql://USER:PASSWORD@host:5432/dbname?sslmode=require&pgbouncer=true"
DIRECT_URL="postgresql://USER:PASSWORD@host:5432/dbname?sslmode=require"
JWT_SECRET="replace-with-a-long-random-secret"
SESSION_TTL_SECONDS="120"
PORT="10000"
CORS_ORIGIN="*"
```

### Variables explained

- DATABASE_URL: pooled connection string used at runtime
- DIRECT_URL: direct connection used by Prisma migrations
- JWT_SECRET: secret used to sign and verify access tokens
- SESSION_TTL_SECONDS: TTL for BLE attendance sessions
- PORT: port for the API server
- CORS_ORIGIN: allowed frontend origin or wildcard

## Installation

```bash
cd backend
npm install
```

## Database setup

Generate Prisma client and apply migrations:

```bash
npx prisma generate
npx prisma migrate dev --name init
```

## Run locally

Start the API in development mode:

```bash
npm run dev
```

The server listens on port 10000 by default and exposes the health endpoint:

```bash
curl http://localhost:10000/health
```

## Production start

The project includes a production start script:

```bash
npm run build
npm run start
```

The start script runs Prisma migrations and launches the compiled server.

## API overview

See [API.md](API.md) for the complete API contract. The main routes are:

### Authentication

- POST /auth/register
- POST /auth/login
- GET /auth/me

### Classes

- POST /classes
- GET /classes/teacher
- GET /classes/student
- POST /classes/join
- GET /classes/:classId
- GET /classes/:classId/requests
- PATCH /classes/:classId/members/:membershipId

### Attendance

- POST /attendance/sessions/start — `{ classId: string }` (teacher only)
- POST /attendance/sessions/:sessionId/end — (teacher only)
- GET /attendance/classes/:classId/current — (teacher only)
- POST /attendance/mark — `{ classId: string, bleToken: string, ultrasoundVerified?: boolean }` (student only)
- GET /attendance/student/history — (student only)

## BLE validation flow

The backend validates the attendance token in a server-controlled way:

1. The teacher starts a session and receives a raw BLE token.
2. The API stores a SHA-256 hashed version of that token with an expiration timestamp (`SESSION_TTL_SECONDS`).
3. A student reads the token over BLE from the teacher device.
4. The student sends `{ classId, bleToken, ultrasoundVerified }` to `POST /attendance/mark`.
5. The backend hashes the provided token and queries for the matching active session.
6. The server validates:
   - Session is still active (`endedAt` is null)
   - Student's class membership exists and status is `ACCEPTED`
   - Token hash strictly matches the session's `tokenHash`
   - Current time is before `expiresAt`
   - Student has not already marked attendance in this session (duplicate prevention)
7. On successful validation, an `Attendance` record is created and the live roster updates immediately.

## Deployment (Render)

The repository includes ready-to-deploy Render configuration in `render.yaml`.

- **Live Production Endpoint:** `https://attendify-rebuild-backend-l9r4.onrender.com`
- **Runtime:** Render Web Service (Node.js 20.x)
- **Database:** Neon PostgreSQL (connection pooled via Prisma pg adapter)
- **Build Command:** `npm ci && npm run build`
- **Start Command:** `npm start` (runs `prisma migrate deploy && node dist/server.js`)
- **Health Check Path:** `/health`
- environment: production variables from .env
- start command: npm run start

## Security considerations

- Use a strong JWT secret in production.
- Keep database URLs in environment variables, not source control.
- Use a separate migration connection and runtime connection if your database provider requires it.
- Consider limiting CORS origins in production.
- Protect attendance routes with role checks and validated class membership.

## Troubleshooting

### Prisma errors

If Prisma cannot connect to the database:

- check DATABASE_URL and DIRECT_URL
- ensure the DB is reachable
- run Prisma migration commands after creating the database

### JWT errors

If auth requests fail:

- confirm JWT_SECRET is set in the environment
- verify the front-end sends the Authorization header with the bearer token

### Attendance fails

If marking attendance does not work:

- confirm the teacher session is still active
- check that the student has an accepted class membership
- verify the BLE token matches the active session
- ensure the session has not expired

## Summary

The backend is the security and coordination layer for the BLE attendance system. It verifies classroom membership, validates proximity-based attendance tokens, and ensures attendance records are only created under the correct conditions.
