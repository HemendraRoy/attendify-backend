import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { testAttendancePage } from '../pages/testAttendance.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export async function createTestAttendanceRouter() {
  if (process.env.NODE_ENV !== 'development' || process.env.ATTENDIFY_TEST_DASHBOARD !== '1') return;

  const teacherId = process.env.ATTENDIFY_TEST_TEACHER_ID?.trim();
  const studentIds = (process.env.ATTENDIFY_TEST_STUDENT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!teacherId || !studentIds.length) {
    throw new Error('The test dashboard requires ATTENDIFY_TEST_TEACHER_ID and ATTENDIFY_TEST_STUDENT_IDS.');
  }

  const [database] = await prisma.$queryRaw<{ name: string; host: string | null }[]>`
    SELECT current_database() AS name, host(inet_server_addr()) AS host
  `;
  const isLocalDev = database?.name === 'attendify_dev'
    && ['127.0.0.1', '::1'].includes(database.host ?? '')
    && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname);
  if (database?.name !== 'attendify_test' && !isLocalDev) {
    throw new Error('The test dashboard requires a separate PostgreSQL database named attendify_test or a loopback attendify_dev database.');
  }

  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/', (_req, res) => {
    const nonce = randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`);
    res.type('html').send(testAttendancePage(nonce));
  });
  router.use(requireAuth, requireRole('TEACHER'), (req, res, next) => {
    if (req.user!.id !== teacherId) return res.status(403).json({ message: 'This teacher is not configured for the test dashboard.' });
    next();
  });

  router.get('/session', asyncHandler(async (_req, res) => {
    const session = await prisma.attendanceSession.findFirst({
      where: { teacherId, class: { teacherId }, endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, classId: true, expiresAt: true, class: { select: { name: true } } }
    });
    if (!session) return res.json({ session: null, students: [] });

    const students = await prisma.user.findMany({
      where: { id: { in: studentIds }, role: 'STUDENT', memberships: { some: { classId: session.classId, status: 'ACCEPTED' } } },
      select: { id: true, name: true, attendance: { where: { sessionId: session.id }, select: { id: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }]
    });
    res.json({
      session: { id: session.id, className: session.class.name, expiresAt: session.expiresAt },
      students: students.map(({ id, name, attendance }) => ({ id, name, marked: attendance.length > 0 }))
    });
  }));

  const markSchema = z.object({ sessionId: z.string().trim().min(1).max(128), studentId: z.string().trim().min(1).max(128) });
  router.post('/mark', asyncHandler(async (req, res) => {
    const { sessionId, studentId } = markSchema.parse(req.body);
    if (!studentIds.includes(studentId)) return res.status(403).json({ message: 'Select a configured test student.' });

    const id = randomUUID();
    // Check session and membership in the write itself so a stale browser selection can't mark a new session.
    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "Attendance" ("id", "sessionId", "studentId", "recordedByDashboard")
      SELECT ${id}, session."id", member."studentId", true
      FROM "AttendanceSession" AS session
      JOIN "Class" AS class ON class."id" = session."classId"
      JOIN "ClassMembership" AS member ON member."classId" = class."id"
      JOIN "User" AS student ON student."id" = member."studentId"
      WHERE session."id" = ${sessionId} AND session."teacherId" = ${teacherId} AND class."teacherId" = ${teacherId}
        AND session."endedAt" IS NULL AND session."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND member."studentId" = ${studentId} AND member."status" = 'ACCEPTED' AND student."role" = 'STUDENT'
      FOR SHARE OF session, class, member, student
      ON CONFLICT ("sessionId", "studentId") DO UPDATE SET "studentId" = EXCLUDED."studentId"
      RETURNING "id"
    `;
    if (!row) return res.status(409).json({ message: 'The test session or enrollment changed. Refresh the session and try again.' });

    const alreadyMarked = row.id !== id;
    if (!alreadyMarked) console.info('Test dashboard attendance recorded', { teacherId, sessionId, studentId });
    res.status(alreadyMarked ? 200 : 201).json({ studentId, alreadyMarked });
  }));

  return router;
}
