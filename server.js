const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+ / 24
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const GRACE_MIN = 0; // minutes allowed after shift start before marking LATE (0 = strict)

// All punch times and dates use this timezone, no matter where the server runs (Render = UTC)
const TZ = process.env.APP_TZ || 'Asia/Kolkata';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
// no-store so the browser never keeps an old index.html / backend.js
app.use(express.static('public', { etag: false, setHeaders: res => res.set('Cache-Control', 'no-store') }));

// ---------- DATABASE ----------
const db = new DatabaseSync('attendflow.db');
db.exec(`
CREATE TABLE IF NOT EXISTS admins(username TEXT PRIMARY KEY, password_hash TEXT);
CREATE TABLE IF NOT EXISTS employees(
  id TEXT PRIMARY KEY, name TEXT, password_hash TEXT,
  dept TEXT DEFAULT 'Staff', role TEXT, hourly_rate REAL,
  work_start TEXT DEFAULT '09:00', work_end TEXT DEFAULT '17:00');
CREATE TABLE IF NOT EXISTS attendance(
  id TEXT PRIMARY KEY, emp_id TEXT, date TEXT, clock_in TEXT, clock_out TEXT,
  hours REAL DEFAULT 0, ot REAL DEFAULT 0, status TEXT, punches INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS punches(
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT, date TEXT, punch_in TEXT, punch_out TEXT);
CREATE TABLE IF NOT EXISTS leaves(
  id TEXT PRIMARY KEY, emp_id TEXT, type TEXT, start_date TEXT, end_date TEXT,
  reason TEXT, status TEXT DEFAULT 'PENDING');
`);
// Upgrade older databases (these fail harmlessly if the column already exists)
try { db.exec('ALTER TABLE attendance ADD COLUMN punches INTEGER DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE employees ADD COLUMN work_start TEXT DEFAULT '09:00'"); } catch {}
try { db.exec("ALTER TABLE employees ADD COLUMN work_end TEXT DEFAULT '17:00'"); } catch {}

if (!db.prepare('SELECT 1 FROM admins').get()) {
  db.prepare('INSERT INTO admins VALUES(?,?)').run('admin@vr', bcrypt.hashSync('RojaRaj@1721', 10));
}
const q = (s, ...a) => db.prepare(s).all(...a);
const one = (s, ...a) => db.prepare(s).get(...a);
const run = (s, ...a) => db.prepare(s).run(...a);

// Row -> shape the frontend understands (times are stored/sent as 24h "HH:MM", the UI shows 12h)
const E = r => ({
  id: r.id, name: r.name, dept: r.dept, role: r.role, hourlyRate: r.hourly_rate,
  workStart: r.work_start || '09:00', workEnd: r.work_end || '17:00'
});
const L = (r, sess) => ({
  id: r.id, empId: r.emp_id, date: r.date, clockIn: r.clock_in, clockOut: r.clock_out,
  hoursWorked: r.hours, overtimeHours: r.ot, status: r.status, punches: r.punches || 0,
  sessions: sess[r.emp_id + '|' + r.date] || []
});
const V = r => ({ id: r.id, empId: r.emp_id, type: r.type, startDate: r.start_date, endDate: r.end_date, reason: r.reason, status: r.status });

// ---------- REALTIME (Server-Sent Events) ----------
const clients = new Set();
const broadcast = () => clients.forEach(r => r.write('data: change\n\n'));

// ---------- AUTH ----------
function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    req.user = jwt.verify(t, SECRET);
    next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
}
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const empOnly = (req, res, next) => req.user.role === 'employee' ? next() : res.status(403).json({ error: 'Employee only' });

app.post('/api/login', (req, res) => {
  const { as, username, password } = req.body || {};
  const bad = () => res.status(401).json({ error: 'Invalid username or password' });
  if (as === 'admin') {
    const a = one('SELECT * FROM admins WHERE username=?', username);
    if (!a || !bcrypt.compareSync(password || '', a.password_hash)) return bad();
    return res.json({ token: jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '8h' }) });
  }
  // Employee: the profile is chosen in the Mode switch, so only the password is needed
  const e = one('SELECT * FROM employees WHERE id=?', as);
  if (!e || !bcrypt.compareSync(password || '', e.password_hash || '')) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ token: jwt.sign({ role: 'employee', id: e.id }, SECRET, { expiresIn: '8h' }) });
});

// Names only (no secrets) so the "Mode" dropdown can list staff
app.get('/api/public/employees', (req, res) => res.json(q('SELECT id,name FROM employees ORDER BY id')));

app.get('/api/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Admin gets everything, employee gets only own records
app.get('/api/data', auth, (req, res) => {
  const a = req.user.role === 'admin', id = req.user.id;
  const punchRows = a ? q('SELECT * FROM punches ORDER BY punch_in, id') : q('SELECT * FROM punches WHERE emp_id=? ORDER BY punch_in, id', id);
  const sess = {};
  punchRows.forEach(p => (sess[p.emp_id + '|' + p.date] ||= []).push({ in: p.punch_in, out: p.punch_out }));
  res.json({
    employees: (a ? q('SELECT * FROM employees ORDER BY id') : q('SELECT * FROM employees WHERE id=?', id)).map(E),
    attendanceLogs: (a ? q('SELECT * FROM attendance ORDER BY date DESC, rowid DESC') : q('SELECT * FROM attendance WHERE emp_id=? ORDER BY date DESC', id)).map(r => L(r, sess)),
    leaveRequests: (a ? q('SELECT * FROM leaves ORDER BY rowid DESC') : q('SELECT * FROM leaves WHERE emp_id=? ORDER BY rowid DESC', id)).map(V)
  });
});

// ---------- EMPLOYEES (admin) ----------
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');
const nextId = () => 'EMP-' + ((one("SELECT MAX(CAST(SUBSTR(id,5) AS INTEGER)) m FROM employees").m || 100) + 1);

// Validates the employee form and says exactly which field is wrong
function checkEmployee(body, needPassword) {
  const b = body || {};
  const name = String(b.name || '').trim();
  const role = String(b.role || '').trim();
  const password = String(b.password || '');
  const hourlyRate = Number(b.hourlyRate);
  let error = null;
  if (!name) error = 'Full name is required';
  else if (!role) error = 'Role title is required';
  else if (!(hourlyRate > 0)) error = 'A valid hourly rate (greater than 0) is required';
  else if (needPassword && !password) error = 'Password is required for a new employee';
  else if (!validTime(b.workStart) || !validTime(b.workEnd)) error = 'Valid work start and end time are required';
  return { error, name, role, password, hourlyRate, workStart: b.workStart, workEnd: b.workEnd };
}

app.post('/api/employees', auth, adminOnly, (req, res) => {
  const v = checkEmployee(req.body, true);
  if (v.error) return res.status(400).json({ error: v.error });
  run('INSERT INTO employees(id,name,password_hash,role,hourly_rate,work_start,work_end) VALUES(?,?,?,?,?,?,?)',
    nextId(), v.name, bcrypt.hashSync(v.password, 10), v.role, v.hourlyRate, v.workStart, v.workEnd);
  broadcast(); res.json({ ok: true });
});

app.put('/api/employees/:id', auth, adminOnly, (req, res) => {
  const v = checkEmployee(req.body, false);
  if (v.error) return res.status(400).json({ error: v.error });
  run('UPDATE employees SET name=?, role=?, hourly_rate=?, work_start=?, work_end=? WHERE id=?',
    v.name, v.role, v.hourlyRate, v.workStart, v.workEnd, req.params.id);
  if (v.password) run('UPDATE employees SET password_hash=? WHERE id=?', bcrypt.hashSync(v.password, 10), req.params.id);
  broadcast(); res.json({ ok: true });
});

app.delete('/api/employees/:id', auth, adminOnly, (req, res) => {
  run('DELETE FROM punches WHERE emp_id=?', req.params.id);
  run('DELETE FROM attendance WHERE emp_id=?', req.params.id);
  run('DELETE FROM leaves WHERE emp_id=?', req.params.id);
  run('DELETE FROM employees WHERE id=?', req.params.id);
  broadcast(); res.json({ ok: true });
});

// ---------- ATTENDANCE (multiple punch sessions per day) ----------
const mins = t => { const [h, m] = t.split(':'); return h * 60 + +m; };
const hoursBetween = (i, o) => { let h = (mins(o) - mins(i)) / 60; if (h < 0) h += 24; return h; };

// Current date/time in the configured timezone (not the server's own timezone)
const tzParts = () => {
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return p;
};
const today = () => { const p = tzParts(); return `${p.year}-${p.month}-${p.day}`; };
const nowHM = () => { const p = tzParts(); return `${p.hour}:${p.minute}`; };

// Rebuild the daily summary row from that day's punch sessions,
// using THIS employee's own shift for late status and overtime.
function recalc(empId, date) {
  const ps = q('SELECT * FROM punches WHERE emp_id=? AND date=? ORDER BY punch_in, id', empId, date);
  const ex = one('SELECT id FROM attendance WHERE emp_id=? AND date=?', empId, date);
  if (!ps.length) { if (ex) run('DELETE FROM attendance WHERE id=?', ex.id); return; }

  const emp = one('SELECT work_start, work_end FROM employees WHERE id=?', empId) || {};
  const ws = emp.work_start || '09:00', we = emp.work_end || '17:00';
  let shiftHours = hoursBetween(ws, we);
  if (shiftHours <= 0) shiftHours = 8;

  const hours = ps.reduce((a, p) => a + (p.punch_out ? hoursBetween(p.punch_in, p.punch_out) : 0), 0);
  const ot = Math.max(0, hours - shiftHours);
  const first = ps[0].punch_in, last = ps[ps.length - 1];
  const out = last.punch_out || null;                                   // null = currently punched in
  const count = ps.length + ps.filter(p => p.punch_out).length;          // every IN and every OUT
  const status = mins(first) > mins(ws) + GRACE_MIN ? 'LATE' : 'PRESENT';
  if (ex) run('UPDATE attendance SET clock_in=?, clock_out=?, hours=?, ot=?, punches=?, status=? WHERE id=?', first, out, hours, ot, count, status, ex.id);
  else run('INSERT INTO attendance(id,emp_id,date,clock_in,clock_out,hours,ot,status,punches) VALUES(?,?,?,?,?,?,?,?,?)',
    'LOG-' + Date.now(), empId, date, first, out, hours, ot, status, count);
}

// Sessions left open on an earlier day (forgot to punch out) are closed at 23:59 so nobody gets locked out
function closeStale(empId) {
  const stale = q('SELECT * FROM punches WHERE emp_id=? AND punch_out IS NULL AND date<>?', empId, today());
  stale.forEach(p => {
    run('UPDATE punches SET punch_out=? WHERE id=?', '23:59', p.id);
    recalc(p.emp_id, p.date);
  });
  return stale.length;
}

// Employee punches IN (any number of times, as long as the previous session is closed)
app.post('/api/clock-in', auth, empOnly, (req, res) => {
  const d = today();
  closeStale(req.user.id);
  if (one('SELECT 1 FROM punches WHERE emp_id=? AND date=? AND punch_out IS NULL', req.user.id, d))
    return res.status(400).json({ error: 'You are already punched in. Punch out first.' });
  run('INSERT INTO punches(emp_id,date,punch_in) VALUES(?,?,?)', req.user.id, d, nowHM());
  recalc(req.user.id, d);
  broadcast(); res.json({ ok: true });
});

// Employee punches OUT (closes the open session, even if it is only seconds old)
app.post('/api/clock-out', auth, empOnly, (req, res) => {
  const d = today();
  const staleClosed = closeStale(req.user.id);
  const open = one('SELECT id FROM punches WHERE emp_id=? AND date=? AND punch_out IS NULL ORDER BY id DESC', req.user.id, d);
  if (!open) {
    if (staleClosed) { broadcast(); return res.json({ ok: true, note: 'Previous open session closed' }); }
    return res.status(400).json({ error: 'You are not punched in.' });
  }
  run('UPDATE punches SET punch_out=? WHERE id=?', nowHM(), open.id);
  recalc(req.user.id, d);
  broadcast(); res.json({ ok: true });
});

// Admin manual entry: adds one session to that day and sets the chosen status
app.post('/api/attendance', auth, adminOnly, (req, res) => {
  const { empId, date, clockIn, clockOut, status } = req.body || {};
  if (!empId || !date || !validTime(clockIn) || !validTime(clockOut)) return res.status(400).json({ error: 'Employee, date, clock in and clock out are required' });
  run('INSERT INTO punches(emp_id,date,punch_in,punch_out) VALUES(?,?,?,?)', empId, date, clockIn, clockOut);
  recalc(empId, date);
  if (status) run('UPDATE attendance SET status=? WHERE emp_id=? AND date=?', status, empId, date);
  broadcast(); res.json({ ok: true });
});

// Deletes the whole day (all punches) for that employee
app.delete('/api/attendance/:id', auth, adminOnly, (req, res) => {
  const row = one('SELECT * FROM attendance WHERE id=?', req.params.id);
  if (row) run('DELETE FROM punches WHERE emp_id=? AND date=?', row.emp_id, row.date);
  run('DELETE FROM attendance WHERE id=?', req.params.id);
  broadcast(); res.json({ ok: true });
});

// ---------- LEAVES ----------
app.post('/api/leaves', auth, empOnly, (req, res) => {
  const { type, startDate, endDate, reason } = req.body || {};
  run('INSERT INTO leaves(id,emp_id,type,start_date,end_date,reason) VALUES(?,?,?,?,?,?)',
    'LV-' + Date.now(), req.user.id, type, startDate, endDate, reason);
  broadcast(); res.json({ ok: true });
});

app.patch('/api/leaves/:id', auth, adminOnly, (req, res) => {
  const s = (req.body || {}).status;
  if (!['APPROVED', 'REJECTED'].includes(s)) return res.status(400).json({ error: 'Bad status' });
  run('UPDATE leaves SET status=? WHERE id=?', s, req.params.id);
  broadcast(); res.json({ ok: true });
});

// Any unexpected server/database error is returned as readable JSON (and logged in the terminal)
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Server error: ' + (err && err.message ? err.message : 'unknown') });
});

app.listen(PORT, () => console.log(`Attendance system running on port ${PORT} (timezone: ${TZ})`));