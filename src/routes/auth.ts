import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { passwordHash, passwordMatches, signAccessToken } from '../utils/security.js';

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
  password: z.string().min(6).max(128),
  role: z.enum(['TEACHER', 'STUDENT'])
});

const loginSchema = z.object({
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1)
});

router.post('/register', asyncHandler(async (req, res) => {
  const input = registerSchema.parse(req.body);
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) return res.status(409).json({ message: 'An account with this email already exists' });

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      role: input.role,
      passwordHash: await passwordHash(input.password)
    }
  });

  const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.status(201).json({ user: safeUser, token: signAccessToken(safeUser) });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user || !(await passwordMatches(input.password, user.passwordHash))) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.json({ user: safeUser, token: signAccessToken(safeUser) });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, name: true, email: true, role: true }
  });
  if (!user) return res.status(404).json({ message: 'User not found' });
  res.json({ user });
}));

export default router;
