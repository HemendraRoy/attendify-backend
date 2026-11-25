export function testAttendancePage(nonce: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Attendify Test Attendance</title>
  <style nonce="${nonce}">
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #17251f; background: #eef4f0; }
    body { margin: 0; }
    main { max-width: 38rem; margin: 0 auto; padding: clamp(1rem, 6vw, 4rem) 1rem; }
    h1 { margin: .25rem 0; font-size: clamp(1.9rem, 6vw, 2.8rem); line-height: 1.1; }
    p { margin: .5rem 0 1rem; }
    .card { background: #fff; border: 1px solid #cbd8ce; border-radius: 1rem; padding: clamp(1rem, 5vw, 2rem); }
    label { display: block; font-weight: 650; margin: 1rem 0 .25rem; }
    button, input, select { box-sizing: border-box; font: inherit; min-height: 2.75rem; border-radius: .45rem; }
    input, select { width: 100%; padding: .4rem .6rem; border: 1px solid #687b70; background: white; color: inherit; }
    button { padding: .4rem .9rem; border: 1px solid #23563f; color: white; background: #23563f; font-weight: 650; cursor: pointer; }
    button.secondary { color: #23563f; background: white; }
    button:disabled { opacity: .55; cursor: default; }
    :focus-visible { outline: .2rem solid #196bb2; outline-offset: .15rem; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
    #status { min-height: 1.5rem; margin-bottom: 0; }
    #status[data-error="true"] { color: #9a2828; }
  </style>
</head>
<body>
  <main>
    <h1>Test attendance</h1>
    <p>Use an active test session to mark an approved test student present.</p>
    <div class="card">
      <form id="login">
        <label for="email">Test teacher email</label>
        <input id="email" type="email" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" required>
        <div class="actions"><button id="sign-in">Sign in</button></div>
      </form>
      <form id="attendance" hidden>
        <p id="session"></p>
        <label for="student">Test student</label>
        <select id="student" required disabled></select>
        <div class="actions">
          <button id="mark" aria-label="X: mark selected student present" disabled>X · Mark present</button>
          <button id="refresh" class="secondary" type="button">Refresh session</button>
          <button id="sign-out" class="secondary" type="button">Sign out</button>
        </div>
      </form>
      <p id="status" role="status" aria-atomic="true"></p>
    </div>
  </main>
  <script nonce="${nonce}">
    const field = id => document.getElementById(id);
    const login = field('login');
    const form = field('attendance');
    const student = field('student');
    const mark = field('mark');
    const status = field('status');
    let token = '';
    let session = null;
    let busy = false;
    let expiryTimer;

    function announce(message, error = false) {
      status.textContent = message;
      status.dataset.error = String(error);
    }

    function updateControls() {
      field('sign-in').disabled = busy;
      field('refresh').disabled = busy;
      field('sign-out').disabled = busy;
      student.disabled = busy || !session || session.expiresAt <= Date.now() || student.options.length < 2;
      mark.disabled = student.disabled || !student.value || student.selectedOptions[0].disabled;
    }

    async function request(path, data) {
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      if (data) headers['Content-Type'] = 'application/json';
      const response = await fetch(path, { headers, method: data ? 'POST' : 'GET', body: data ? JSON.stringify(data) : undefined });
      const result = await response.json();
      if (!response.ok) {
        if (path !== '/auth/login' && response.status === 401) signOut();
        throw new Error(result.message || 'The request failed. Try again.');
      }
      return result;
    }

    function signOut() {
      token = '';
      session = null;
      clearTimeout(expiryTimer);
      student.replaceChildren();
      form.hidden = true;
      login.hidden = false;
      field('email').focus();
    }

    async function loadSession() {
      const { session: active, students } = await request('/dev/attendance/session');
      clearTimeout(expiryTimer);
      session = active && { ...active, expiresAt: Date.parse(active.expiresAt) };
      field('session').textContent = active
        ? active.className + ' · Ends at ' + new Date(active.expiresAt).toLocaleTimeString()
        : 'No active test session. Start one in the teacher app, then refresh.';
      student.replaceChildren(new Option(students.length ? 'Select a test student' : 'No eligible test students', ''));
      for (const entry of students) {
        const option = new Option(entry.name + ' (' + entry.id + ')' + (entry.marked ? ' · Present' : ''), entry.id);
        option.disabled = entry.marked;
        student.add(option);
      }
      if (session) expiryTimer = setTimeout(() => {
        field('session').textContent = 'Test session expired. Start another session, then refresh.';
        updateControls();
      }, Math.max(0, session.expiresAt - Date.now()));
    }

    async function run(action) {
      if (busy) return;
      busy = true;
      updateControls();
      announce('');
      try { await action(); }
      catch (error) { announce(error.message, true); }
      finally {
        busy = false;
        updateControls();
      }
    }

    login.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const password = field('password');
        const credentials = { email: field('email').value, password: password.value };
        password.value = '';
        const result = await request('/auth/login', credentials);
        token = result.token;
        try { await loadSession(); }
        catch (error) { signOut(); throw error; }
        login.hidden = true;
        form.hidden = false;
        announce('Signed in.');
      });
    });

    student.addEventListener('change', updateControls);
    field('refresh').addEventListener('click', () => run(loadSession));
    field('sign-out').addEventListener('click', () => { signOut(); announce('Signed out.'); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (mark.disabled) return;
      const selected = student.selectedOptions[0];
      run(async () => {
        const result = await request('/dev/attendance/mark', { sessionId: session.id, studentId: selected.value });
        selected.disabled = true;
        announce(result.alreadyMarked ? 'Already marked present for ' + selected.text : 'Attendance recorded for ' + selected.text);
        selected.text += ' · Present';
        student.value = '';
      });
    });
  </script>
</body>
</html>`;
}
