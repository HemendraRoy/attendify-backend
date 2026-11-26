import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const databaseUrl = process.env.ATTENDIFY_TEST_DATABASE_URL;
const localTestDatabase = databaseUrl && (() => {
  const url = new URL(databaseUrl);
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === '/attendify_test';
})();

test('real HTTP routes and PostgreSQL enforce the acoustic requirement on both attendance paths', { skip: !localTestDatabase, timeout: 30_000 }, async t => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.JWT_SECRET = 'integration-only-jwt-key-000000000000000000';
  process.env.ACOUSTIC_TOKEN_SECRET = 'integration-only-acoustic-key-000000000000';
  const { prisma } = await import('../src/lib/prisma.js');
  const { passwordHash, signAccessToken } = await import('../src/utils/security.js');
  const { acousticBroadcast, ACOUSTIC_WINDOW_MS } = await import('../src/utils/acoustic.js');
  const unique = `test-${Date.now()}`;
  const password = 'synthetic-dashboard-password';
  const teacherPasswordHash = await passwordHash(password);
  const users = await Promise.all(['teacher', 'teacher2', 'student', 'student2', 'outsider', 'student-dashboard'].map(async name => {
    const user = await prisma.user.create({ data: { name, email: `${unique}-${name}@example.test`, role: name.startsWith('teacher') ? 'TEACHER' : 'STUDENT', passwordHash: name === 'teacher' ? teacherPasswordHash : 'synthetic-test-data' } });
    return { ...user, token: signAccessToken(user) };
  }));
  const [teacher, teacher2, student, student2, outsider, dashboardStudent] = users;
  const cls = await prisma.class.create({ data: { name: 'Integration room A', joinCode: `${unique}-A`, teacherId: teacher.id } });
  const other = await prisma.class.create({ data: { name: 'Integration room B', joinCode: `${unique}-B`, teacherId: teacher2.id } });
  await prisma.classMembership.createMany({ data: [student, student2, dashboardStudent].map(user => ({ classId: cls.id, studentId: user.id, status: 'ACCEPTED' as const })) });
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address(); assert.ok(address && typeof address === 'object'); const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const serverEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), NODE_ENV: 'production' };
  delete serverEnv.ATTENDIFY_TEACHER_DASHBOARD;
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(), env: serverEnv, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', data => { output += data; }); server.stderr.on('data', data => { output += data; });
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
    await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await prisma.$disconnect();
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url + '/health')).ok) break; } catch {}
    if (i === 79 || server.exitCode !== null) throw new Error('Test API did not start: ' + output);
    await delay(100);
  }
  async function request(path: string, token?: string, body?: unknown) {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  assert.equal((await request('/health')).body.acousticProtocol, 'chirp-v1');
  const started = await request('/attendance/sessions/start', teacher.token, { classId: cls.id });
  assert.equal(started.status, 201);
  assert.equal(started.body.acoustic.protocol, 'chirp-v1');
  const sessionId = started.body.session.id;
  const token = started.body.acoustic.token;
  const bleToken = started.body.bleToken;
  const second = await request('/attendance/sessions/start', teacher2.token, { classId: other.id });
  const submission = { classId: cls.id, sessionId, acousticToken: token };

  await t.test('student discovery does not disclose acoustic values and teacher ownership is enforced', async () => {
    const active = await request(`/attendance/classes/${cls.id}/active`, student.token);
    assert.equal(active.status, 200); assert.equal(active.body.sessionId, sessionId);
    assert.equal(JSON.stringify(active.body).includes(token), false);
    const current = await request(`/attendance/classes/${cls.id}/current`, teacher.token);
    assert.equal(current.status, 200); assert.ok(current.body.acoustic.token);
    assert.equal((await request(`/attendance/classes/${cls.id}/current`, student.token)).status, 403);
    assert.equal((await request(`/attendance/classes/${cls.id}/current`, teacher2.token)).status, 404);
  });
  await t.test('missing proof, old client boolean, malformed proof and wrong-class sound cannot mark', async () => {
    assert.equal((await request('/attendance/mark', undefined, submission)).status, 401);
    assert.equal((await request('/attendance/mark', teacher.token, submission)).status, 403);
    for (const body of [{ classId: cls.id, sessionId }, { classId: cls.id, sessionId, ultrasoundVerified: true }, { ...submission, acousticToken: bleToken }]) {
      assert.equal((await request('/attendance/mark', student.token, body)).status, 400);
    }
    assert.equal((await request('/attendance/mark', student.token, { ...submission, acousticToken: second.body.acoustic.token })).status, 403);
    assert.equal((await request('/attendance/mark', outsider.token, submission)).status, 403);
    assert.equal(await prisma.attendance.count({ where: { sessionId } }), 0);
  });
  await t.test('stale and future audio values are rejected by the actual route', async () => {
    const session = await prisma.attendanceSession.findUniqueOrThrow({ where: { id: sessionId } });
    for (const epochOffset of [-3, 2]) {
      const proof = acousticBroadcast(session, Date.now() + epochOffset * ACOUSTIC_WINDOW_MS)!.token;
      assert.equal((await request('/attendance/mark', student.token, { ...submission, acousticToken: proof })).status, 403);
    }
  });
  await t.test('BLE token and selected session must agree', async () => {
    const mismatch = await request('/attendance/mark', student.token, { ...submission, bleToken, sessionId: second.body.session.id });
    assert.equal(mismatch.status, 404);
    assert.equal((await request('/attendance/mark', student.token, { ...submission, bleToken: 'wrong-token' })).status, 403);
  });
  await t.test('valid BLE plus sound and acoustic fallback both work and are identified accurately', async () => {
    const first = await request('/attendance/mark', student.token, { ...submission, bleToken });
    assert.equal(first.status, 201); assert.equal(first.body.verificationMethod, 'BLE_ACOUSTIC');
    const fallback = await request('/attendance/mark', student2.token, submission);
    assert.equal(fallback.status, 201); assert.equal(fallback.body.verificationMethod, 'ACOUSTIC_FALLBACK');
    const duplicates = await Promise.all(Array.from({ length: 10 }, () => request('/attendance/mark', student.token, { ...submission, bleToken })));
    assert.equal(duplicates.every(response => response.status === 201 && response.body.attendance.id === first.body.attendance.id), true);
    assert.equal(await prisma.attendance.count({ where: { sessionId } }), 2);
  });
  await t.test('dashboard sign-in only exposes the owning teacher’s active roster and records one attributed check-in', async () => {
    const page = await fetch(url + '/teacher/attendance');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /X · Mark present/);

    const path = '/teacher/attendance';
    const payload = { sessionId, studentId: dashboardStudent.id };
    const login = await request('/auth/login', undefined, { email: teacher.email, password });
    assert.equal(login.status, 200);
    const dashboardToken = login.body.token;
    assert.equal((await request(path + '/session')).status, 401);
    assert.equal((await request(path + '/session', student.token)).status, 403);
    const current = await request(path + '/session', dashboardToken);
    assert.equal(current.status, 200);
    assert.equal(current.body.session.id, sessionId);
    assert.deepEqual(current.body.students.find((entry: { id: string }) => entry.id === dashboardStudent.id), {
      id: dashboardStudent.id, name: dashboardStudent.name, marked: false
    });
    assert.equal(current.body.students.some((entry: { id: string }) => entry.id === outsider.id), false);
    assert.equal(JSON.stringify(current.body).includes(token), false);
    assert.equal((await request(path + '/mark', undefined, payload)).status, 401);
    assert.equal((await request(path + '/mark', student.token, payload)).status, 403);
    assert.equal((await request(path + '/mark', teacher2.token, payload)).status, 409);
    assert.equal((await request(path + '/mark', dashboardToken, { ...payload, studentId: outsider.id })).status, 409);

    const responses = await Promise.all(Array.from({ length: 5 }, () => request(path + '/mark', dashboardToken, payload)));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 200, 200, 201]);
    const record = await prisma.attendance.findUniqueOrThrow({ where: { sessionId_studentId: payload } });
    assert.equal(record.recordedByTeacherId, teacher.id);
    assert.ok(record.markedAt instanceof Date);
    assert.equal(await prisma.attendance.count({ where: payload }), 1);

    const preexisting = { sessionId, studentId: student.id };
    assert.equal((await request(path + '/mark', dashboardToken, preexisting)).status, 200);
    const previousEntry = await prisma.attendance.findUniqueOrThrow({ where: { sessionId_studentId: preexisting } });
    assert.equal(previousEntry.recordedByTeacherId, null);
    const active = await request(`/attendance/classes/${cls.id}/active`, dashboardStudent.token);
    assert.equal(active.body.alreadyMarked, true);
    const scan = await request('/attendance/mark', dashboardStudent.token, { ...submission, bleToken });
    assert.equal(scan.status, 409);
    assert.equal(scan.body.verificationMethod, undefined);
  });
  await t.test('session expiry and teacher closure prevent further attendance', async () => {
    const payload = { sessionId, studentId: dashboardStudent.id };
    await prisma.attendanceSession.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 1) } });
    assert.equal((await request('/attendance/mark', student.token, { ...submission, bleToken })).status, 410);
    assert.equal((await request('/teacher/attendance/mark', teacher.token, payload)).status, 409);
    await prisma.attendanceSession.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    assert.equal((await request(`/attendance/sessions/${sessionId}/end`, teacher.token, {})).status, 200);
    assert.equal((await request('/attendance/mark', student.token, { ...submission, bleToken })).status, 410);
    assert.equal((await request('/teacher/attendance/mark', teacher.token, payload)).status, 409);
  });
});
