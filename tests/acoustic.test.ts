import test from 'node:test';
import assert from 'node:assert/strict';
import { acousticBroadcast, verifyAcousticToken, ACOUSTIC_WINDOW_MS as W } from '../src/utils/acoustic.js';
process.env.ACOUSTIC_TOKEN_SECRET = 'test-only-acoustic-key-000000000000000000';
const now = 100 * W + 1_000;
const session = { id: 'session-A', classId: 'class-A', expiresAt: new Date(now + 10 * W) };

test('valid acoustic values are bound to class/session and current/previous epochs', () => {
  const token = acousticBroadcast(session, now)!.token;
  assert.equal(token.length, 16);
  assert.equal(verifyAcousticToken(session, token, now), true);
  assert.equal(verifyAcousticToken(session, token.toUpperCase(), now), true);
  assert.equal(verifyAcousticToken(session, token, now + W), true);
  assert.equal(verifyAcousticToken(session, token, now + 2 * W), false);
  assert.equal(verifyAcousticToken({ ...session, id: 'session-B' }, token, now), false);
  assert.equal(verifyAcousticToken({ ...session, classId: 'class-B' }, token, now), false);
  assert.equal(verifyAcousticToken(session, acousticBroadcast(session, now + W)!.token, now), false);
});

test('closed/expired sessions, malformed and tampered values fail closed', () => {
  const token = acousticBroadcast(session, now)!.token;
  for (const bad of ['', 'true', '0000', 'zzzzzzzzzzzzzzzz', token.slice(0, 15) + (token[15] === '0' ? '1' : '0')]) {
    assert.equal(verifyAcousticToken(session, bad, now), false);
  }
  const expired = { ...session, expiresAt: new Date(now) };
  const ended = { ...session, endedAt: new Date(now - 1) };
  assert.equal(acousticBroadcast(expired, now), null);
  assert.equal(acousticBroadcast(ended, now), null);
  assert.equal(verifyAcousticToken(expired, token, now), false);
  assert.equal(verifyAcousticToken(ended, token, now), false);
});
