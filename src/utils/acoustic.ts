import { createHmac, timingSafeEqual } from 'node:crypto';

export const ACOUSTIC_PROTOCOL = 'chirp-v1' as const;
export const ACOUSTIC_WINDOW_MS = 20_000;
type SessionBinding = { id: string; classId: string; expiresAt: Date; endedAt?: Date | null };

export function acousticSecret(): string {
  const secret = process.env.ACOUSTIC_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('Acoustic signing requires a secret of at least 32 characters');
  return secret;
}

function tokenFor(session: SessionBinding, epoch: number): string {
  return createHmac('sha256', acousticSecret())
    .update(JSON.stringify([ACOUSTIC_PROTOCOL, session.id, session.classId, epoch]))
    .digest('hex').slice(0, 16);
}

export function acousticBroadcast(session: SessionBinding, now = Date.now()) {
  if (session.endedAt || session.expiresAt.getTime() <= now) return null;
  const epoch = Math.floor(now / ACOUSTIC_WINDOW_MS);
  return {
    protocol: ACOUSTIC_PROTOCOL,
    token: tokenFor(session, epoch),
    validUntil: new Date(Math.min((epoch + 1) * ACOUSTIC_WINDOW_MS, session.expiresAt.getTime())).toISOString()
  };
}

export function verifyAcousticToken(session: SessionBinding, token: string, now = Date.now()): boolean {
  if (session.endedAt || session.expiresAt.getTime() <= now || !/^[a-f0-9]{16}$/i.test(token)) return false;
  const received = Buffer.from(token, 'hex');
  const epoch = Math.floor(now / ACOUSTIC_WINDOW_MS);
  // A previous epoch allows a packet already in flight at a rotation boundary.
  return [epoch, epoch - 1].some(window => timingSafeEqual(received, Buffer.from(tokenFor(session, window), 'hex')));
}
