import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { newJoinCode } from '../utils/security.js';

const router = Router();
const createClassSchema = z.object({
  name: z.string().trim().min(2).max(100),
  subject: z.string().trim().max(100).optional().or(z.literal('')),
  schedule: z.string().trim().max(200).optional().or(z.literal(''))
});

router.use(requireAuth);

router.post('/', requireRole('TEACHER'), asyncHandler(async (req, res) => {
  const input = createClassSchema.parse(req.body);
  const created = await prisma.class.create({
    data: {
      name: input.name,
      subject: input.subject || null,
      schedule: input.schedule || null,
      teacherId: req.user!.id,
      joinCode: newJoinCode()
    },
    select: { id: true, name: true, subject: true, schedule: true, joinCode: true, createdAt: true }
  });
  res.status(201).json({ class: created });
}));

router.get('/teacher', requireRole('TEACHER'), asyncHandler(async (req, res) => {
  const classes = await prisma.class.findMany({
    where: { teacherId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { memberships: true } } }
  });
  res.json({ classes });
}));

router.get('/student', requireRole('STUDENT'), asyncHandler(async (req, res) => {
  const memberships = await prisma.classMembership.findMany({
    where: { studentId: req.user!.id, status: 'ACCEPTED' },
    include: {
      class: {
        include: { teacher: { select: { id: true, name: true, email: true } } }
      }
    },
    orderBy: { requestedAt: 'desc' }
  });
  res.json({ classes: memberships.map((m) => ({ ...m.class, membershipId: m.id })) });
}));

router.post('/join', requireRole('STUDENT'), asyncHandler(async (req, res) => {
  const input = z.object({ classId: z.string().min(1), joinCode: z.string().trim().min(1).optional() }).parse(req.body);
  const target = await prisma.class.findUnique({ where: { id: input.classId } });
  if (!target || (input.joinCode && input.joinCode.toUpperCase() !== target.joinCode)) {
    return res.status(404).json({ message: 'Class not found or join code does not match' });
  }

  const existing = await prisma.classMembership.findUnique({
    where: { classId_studentId: { classId: target.id, studentId: req.user!.id } }
  });

  if (existing?.status === 'ACCEPTED') {
    return res.status(409).json({ message: 'You are already a member of this class' });
  }

  const membership = existing
    ? await prisma.classMembership.update({
        where: { id: existing.id },
        data: { status: 'PENDING', requestedAt: new Date(), respondedAt: null }
      })
    : await prisma.classMembership.create({
        data: { classId: target.id, studentId: req.user!.id }
      });

  res.status(201).json({ membership });
}));

router.get('/:classId', asyncHandler(async (req, res) => {
  const classId = z.string().min(1).parse(req.params.classId);

  const cls = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      teacher: { select: { id: true, name: true, email: true } },
      memberships: {
        where: { status: 'ACCEPTED' },
        include: { student: { select: { id: true, name: true, email: true } } },
        orderBy: { requestedAt: 'asc' }
      }
    }
  });
  if (!cls) return res.status(404).json({ message: 'Class not found' });

  const allowed =
    req.user!.id === cls.teacherId ||
    cls.memberships.some((m) => m.studentId === req.user!.id);
  if (!allowed) return res.status(403).json({ message: 'You are not a member of this class' });

  res.json({ class: cls });
}));

router.get('/:classId/requests', requireRole('TEACHER'), asyncHandler(async (req, res) => {
  const classId = z.string().min(1).parse(req.params.classId);

  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: req.user!.id }
  });
  if (!cls) return res.status(404).json({ message: 'Class not found' });
  const requests = await prisma.classMembership.findMany({
    where: { classId: cls.id, status: 'PENDING' },
    include: { student: { select: { id: true, name: true, email: true } } },
    orderBy: { requestedAt: 'asc' }
  });
  res.json({ requests });
}));

router.patch('/:classId/members/:membershipId', requireRole('TEACHER'), asyncHandler(async (req, res) => {
  const classId = z.string().min(1).parse(req.params.classId);
  const membershipId = z.string().min(1).parse(req.params.membershipId);

  const input = z.object({
    status: z.enum(['ACCEPTED', 'REJECTED'])
  }).parse(req.body);

  const membership = await prisma.classMembership.findFirst({
    where: {
      id: membershipId,
      classId,
      class: { teacherId: req.user!.id }
    }
  });
  if (!membership) return res.status(404).json({ message: 'Membership request not found' });

  const updated = await prisma.classMembership.update({
    where: { id: membership.id },
    data: { status: input.status, respondedAt: new Date() }
  });
  res.json({ membership: updated });
}));

export default router;
