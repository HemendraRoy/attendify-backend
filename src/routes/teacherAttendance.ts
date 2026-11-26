import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { teacherAttendancePage } from '../pages/teacherAttendance.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export function createTeacherAttendanceRouter() {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.get('/', (_req, res) => {
    const nonce = randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`);
    res.type('html').send(teacherAttendancePage(nonce));
  });
  router.use(requireAuth, requireRole('TEACHER'));

  router.get('/session', asyncHandler(async (req, res) => {
    const teacherId = req.user!.id;
    const session = await prisma.attendanceSession.findFirst({
      where: { teacherId, teacher: { role: 'TEACHER' }, class: { teacherId }, endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, classId: true, expiresAt: true, class: { select: { name: true } } }
    });
    if (!session) return res.json({ session: null, students: [] });

    const students = await prisma.user.findMany({
      where: { role: 'STUDENT', memberships: { some: { classId: session.classId, status: 'ACCEPTED' } } },
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
    const teacherId = req.user!.id;

    const id = randomUUID();
    // Check session and membership in the write itself so a stale browser selection can't mark a new session.
    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "Attendance" ("id", "sessionId", "studentId", "recordedByTeacherId")
      SELECT ${id}, session."id", member."studentId", teacher."id"
      FROM "AttendanceSession" AS session
      JOIN "Class" AS class ON class."id" = session."classId"
      JOIN "ClassMembership" AS member ON member."classId" = class."id"
      JOIN "User" AS student ON student."id" = member."studentId"
      JOIN "User" AS teacher ON teacher."id" = session."teacherId"
      WHERE session."id" = ${sessionId} AND session."teacherId" = ${teacherId} AND class."teacherId" = ${teacherId}
        AND teacher."role" = 'TEACHER'
        AND session."endedAt" IS NULL AND session."expiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND member."studentId" = ${studentId} AND member."status" = 'ACCEPTED' AND student."role" = 'STUDENT'
      FOR SHARE OF session, class, member, student, teacher
      ON CONFLICT ("sessionId", "studentId") DO UPDATE SET "studentId" = EXCLUDED."studentId"
      RETURNING "id"
    `;
    if (!row) return res.status(409).json({ message: 'This session or student is no longer available. Refresh the session and try again.' });

    const alreadyMarked = row.id !== id;
    res.status(alreadyMarked ? 200 : 201).json({ studentId, alreadyMarked });
  }));

  return router;
}
