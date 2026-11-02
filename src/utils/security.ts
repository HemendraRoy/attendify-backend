import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Role } from '../generated/prisma/client.js';

export const passwordHash = (password: string) => bcrypt.hash(password, 12);
export const passwordMatches = (password: string, hash: string) => bcrypt.compare(password, hash);
export const createSessionToken = () => crypto.randomBytes(24).toString('hex');
export const hashSessionToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function signAccessToken(user: { id: string; role: Role; name: string; email: string }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(user, secret, { expiresIn: '7d' });
}

export function newJoinCode() {
  return `CLS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
