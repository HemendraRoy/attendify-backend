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
- `POST /attendance/mark` student only `{ classId, bleToken, ultrasoundVerified? }`
- `GET /attendance/student/history` student only
