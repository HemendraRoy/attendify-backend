import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createSessionToken, hashSessionToken } from '../utils/security.js';

const router = Router();
router.use(requireAuth);

const ttlSeconds = () => Math.max(30, Number(process.env.SESSION_TTL_SECONDS ?? 120));

router.post('/sessions/start', requireRole('TEACHER'), asyncHandler(async (req, res) => {
  const input = z.object({ classId: z.string().min(1) }).parse(req.body);
  const cls = await prisma.class.findFirst({ where: { id: input.classId, teacherId: req.user!.id } });
  if (!cls) return res.status(404).json({ message: 'Class not found' });

  await prisma.attendanceSession.updateMany({
    where: { teacherId: req.user!.id, endedAt: null },
    data: { endedAt: new Date() }
  });

  const rawToken = createSessionToken();
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000);
  const session = await prisma.attendanceSession.create({
    data: {
      classId: cls.id,
      teacherId: req.user!.id,
      tokenHash: hashSessionToken(rawToken),
      expiresAt
    },
    select: { id: true, classId: true, expiresAt: true, createdAt: true }
  });

  res.status(201).json({
    session,
    bleToken: rawToken,
    code: rawToken,
    ble: { serviceUUID: '7d9d5b6d-b5f6-4f7a-8f07-a4fae2d9d0a1', characteristicUUID: 'd19439e4-0b6f-40b4-9af9-c77e38cc9b77' }
  });
}));

router.post('/sessions/:sessionId/end', requireRole('TEACHER'), asyncHandler(async (req, res) => {
  const sessionId = z.string().min(1).parse(req.params.sessionId);

  const updated = await prisma.attendanceSession.updateMany({
    where: { id: sessionId, teacherId: req.user!.id, endedAt: null },
    data: { endedAt: new Date() }
  });
  if (!updated.count) return res.status(404).json({ message: 'Active session not found' });
  res.json({ ok: true });
}));

router.get('/classes/:classId/current', requireRole('TEACHER'), asyncHandler(async (req, res) => {
  const classId = z.string().min(1).parse(req.params.classId);

  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: req.user!.id }
  });
  if (!cls) return res.status(404).json({ message: 'Class not found' });
  const session = await prisma.attendanceSession.findFirst({
    where: { classId: cls.id, endedAt: null },
    orderBy: { createdAt: 'desc' }
  });
  if (!session || session.expiresAt <= new Date()) return res.json({ session: null, attendance: [] });

  const attendance = await prisma.attendance.findMany({
    where: { sessionId: session.id },
    include: { student: { select: { id: true, name: true, email: true } } },
    orderBy: { markedAt: 'asc' }
  });
  res.json({ session: { id: session.id, classId: session.classId, expiresAt: session.expiresAt }, attendance });
}));

router.get('/classes/:classId/active', requireRole('STUDENT'), asyncHandler(async (req, res) => {
  const classId = z.string().min(1).parse(req.params.classId);

  const membership = await prisma.classMembership.findUnique({
    where: { classId_studentId: { classId, studentId: req.user!.id } }
  });
  if (!membership || membership.status !== 'ACCEPTED') {
    return res.status(403).json({ message: 'You must be accepted into this class first' });
  }

  const session = await prisma.attendanceSession.findFirst({
    where: { classId, endedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' }
  });
  if (!session) return res.json({ active: false, session: null });

  const alreadyMarked = await prisma.attendance.findUnique({
    where: { sessionId_studentId: { sessionId: session.id, studentId: req.user!.id } }
  });

  res.json({
    active: true,
    sessionId: session.id,
    alreadyMarked: !!alreadyMarked,
    expiresAt: session.expiresAt
  });
}));

router.post('/mark', requireRole('STUDENT'), asyncHandler(async (req, res) => {
  const input = z.object({
    classId: z.string().min(1),
    bleToken: z.string().trim().min(4).optional(),
    sessionId: z.string().trim().min(1).optional(),
    ultrasoundVerified: z.boolean().optional()
  }).parse(req.body);

  let session = null;
  if (input.bleToken) {
    const cleanToken = input.bleToken.trim();
    const hashUpper = hashSessionToken(cleanToken);
    session = await prisma.attendanceSession.findFirst({
      where: {
        OR: [
          { tokenHash: hashUpper },
          { tokenHash: hashSessionToken(cleanToken) }
        ],
        classId: input.classId
      },
      include: { class: true }
    });
  }

  if (!session && (input.sessionId || input.ultrasoundVerified)) {
    session = await prisma.attendanceSession.findFirst({
      where: {
        ...(input.sessionId ? { id: input.sessionId } : {}),
        classId: input.classId,
        endedAt: null,
        expiresAt: { gt: new Date() }
      },
      include: { class: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  if (!session || session.classId !== input.classId) return res.status(404).json({ message: 'No matching active session for this class' });
  if (session.endedAt || session.expiresAt <= new Date()) return res.status(410).json({ message: 'Attendance session has expired' });

  const membership = await prisma.classMembership.findUnique({
    where: { classId_studentId: { classId: session.classId, studentId: req.user!.id } }
  });
  if (!membership || membership.status !== 'ACCEPTED') {
    return res.status(403).json({ message: 'You must be accepted into this class first' });
  }

  const attendance = await prisma.attendance.upsert({
    where: { sessionId_studentId: { sessionId: session.id, studentId: req.user!.id } },
    create: { sessionId: session.id, studentId: req.user!.id },
    update: {}
  });

  res.status(201).json({ attendance, message: 'Attendance marked successfully' });
}));

router.get('/student/history', requireRole('STUDENT'), asyncHandler(async (req, res) => {
  const rows = await prisma.attendance.findMany({
    where: { studentId: req.user!.id },
    include: { session: { include: { class: { include: { teacher: { select: { name: true } } } } } } },
    orderBy: { markedAt: 'desc' },
    take: 100
  });
  res.json({ attendance: rows });
}));

export default router;
