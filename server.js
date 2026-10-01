const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+ / 24
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
// Late rule: LATE only if the first punch-in is MORE than GRACE_MIN minutes after the employee's own shift start
// (admin sets 10:00 AM, grace 5 -> 10:05 is on time, 10:06 is LATE). Override with env GRACE_MIN.
const GRACE_MIN = Number(process.env.GRACE_MIN ?? 5);
// Break / lunch allowance per day. Time taken beyond this is deducted from the day's worked hours.
const BREAK_ALLOWED_MIN = 30;
const LUNCH_ALLOWED_MIN = 60;

// All punch times and dates use this timezone, no matter where the server runs (Render = UTC)
const TZ = process.env.APP_TZ || 'Asia/Kolkata';
const PORT = process.env.PORT || 3000;

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

const app = express();
app.use(express.json());
// no-store so the browser never keeps an old index.html / backend.js
app.use(express.static('public', { etag: false, setHeaders: res => res.set('Cache-Control', 'no-store') }));

// ---------- DATABASE ----------
const db = new DatabaseSync('attendflow.db');

// Remember if the overtime table is new (older databases had auto-calculated overtime that we reset once)
const hadOvertimeTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='overtime'").get();

db.exec(`
CREATE TABLE IF NOT EXISTS admins(username TEXT PRIMARY KEY, password_hash TEXT);
CREATE TABLE IF NOT EXISTS employees(
  id TEXT PRIMARY KEY, name TEXT, password_hash TEXT,
  dept TEXT DEFAULT 'Staff', role TEXT, hourly_rate REAL,
  work_start TEXT DEFAULT '09:00', work_end TEXT DEFAULT '17:00', joined TEXT);
CREATE TABLE IF NOT EXISTS attendance(
  id TEXT PRIMARY KEY, emp_id TEXT, date TEXT, clock_in TEXT, clock_out TEXT,
  hours REAL DEFAULT 0, ot REAL DEFAULT 0, status TEXT, punches INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS punches(
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT, date TEXT, punch_in TEXT, punch_out TEXT);
CREATE TABLE IF NOT EXISTS overtime(
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT, date TEXT, ot_start TEXT, ot_end TEXT);
CREATE TABLE IF NOT EXISTS breaks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, emp_id TEXT, date TEXT, kind TEXT, start_ms INTEGER, end_ms INTEGER);
CREATE TABLE IF NOT EXISTS leaves(
  id TEXT PRIMARY KEY, emp_id TEXT, type TEXT, start_date TEXT, end_date TEXT,
  reason TEXT, status TEXT DEFAULT 'PENDING', seen INTEGER DEFAULT 0);
`);
// Upgrade older databases (these fail harmlessly if the column already exists)
try { db.exec('ALTER TABLE attendance ADD COLUMN punches INTEGER DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE employees ADD COLUMN work_start TEXT DEFAULT '09:00'"); } catch {}
try { db.exec("ALTER TABLE employees ADD COLUMN work_end TEXT DEFAULT '17:00'"); } catch {}
try { db.exec('ALTER TABLE employees ADD COLUMN joined TEXT'); } catch {}
try { db.exec('ALTER TABLE attendance ADD COLUMN break_min REAL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE attendance ADD COLUMN lunch_min REAL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE attendance ADD COLUMN deduct REAL DEFAULT 0'); } catch {}
// Old employees: "joined" = their first attendance date, or today if they have none
db.prepare(`UPDATE employees SET joined = COALESCE(
  (SELECT MIN(date) FROM attendance WHERE attendance.emp_id = employees.id), ?) WHERE joined IS NULL`).run(today());
// Leave notifications: leaves that were already decided before this upgrade are marked as seen
let addedSeen = false;
try { db.exec('ALTER TABLE leaves ADD COLUMN seen INTEGER DEFAULT 0'); addedSeen = true; } catch {}
if (addedSeen) db.exec("UPDATE leaves SET seen=1 WHERE status<>'PENDING'");
// Overtime is now only what the employee declares (with timing). Clear old automatic overtime once.
if (!hadOvertimeTable) db.exec('UPDATE attendance SET ot=0');

if (!db.prepare('SELECT 1 FROM admins').get()) {
  db.prepare('INSERT INTO admins VALUES(?,?)').run('admin@vr', bcrypt.hashSync('RojaRaj@1721', 10));
}
const q = (s, ...a) => db.prepare(s).all(...a);
const one = (s, ...a) => db.prepare(s).get(...a);
const run = (s, ...a) => db.prepare(s).run(...a);

const mins = t => { const [h, m] = t.split(':'); return h * 60 + +m; };
const hoursBetween = (i, o) => { let h = (mins(o) - mins(i)) / 60; if (h < 0) h += 24; return h; };

// Row -> shape the frontend understands (times are stored/sent as 24h "HH:MM", the UI shows 12h)
const E = r => ({
  id: r.id, name: r.name, dept: r.dept, role: r.role, hourlyRate: r.hourly_rate,
  workStart: r.work_start || '09:00', workEnd: r.work_end || '17:00', joined: r.joined || null
});
const L = (r, sess, ots, brs) => ({
  id: r.id, empId: r.emp_id, date: r.date, clockIn: r.clock_in, clockOut: r.clock_out,
  hoursWorked: r.hours, overtimeHours: r.ot, status: r.status, punches: r.punches || 0,
  sessions: sess[r.emp_id + '|' + r.date] || [],
  overtimeSlots: ots[r.emp_id + '|' + r.date] || [],
  breakMinutes: r.break_min || 0, lunchMinutes: r.lunch_min || 0, deductedHours: r.deduct || 0,
  breakSlots: brs[r.emp_id + '|' + r.date] || []
});
const V = r => ({
  id: r.id, empId: r.emp_id, type: r.type, startDate: r.start_date, endDate: r.end_date,
  reason: r.reason, status: r.status, seen: !!r.seen
});

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
  const otRows = a ? q('SELECT * FROM overtime ORDER BY ot_start, id') : q('SELECT * FROM overtime WHERE emp_id=? ORDER BY ot_start, id', id);
  const ots = {};
  otRows.forEach(o => (ots[o.emp_id + '|' + o.date] ||= []).push({ start: o.ot_start, end: o.ot_end, hours: hoursBetween(o.ot_start, o.ot_end) }));
  const brRows = a ? q('SELECT * FROM breaks ORDER BY start_ms, id') : q('SELECT * FROM breaks WHERE emp_id=? ORDER BY start_ms, id', id);
  const brs = {};
  brRows.forEach(b => (brs[b.emp_id + '|' + b.date] ||= []).push({ kind: b.kind, start: b.start_ms, end: b.end_ms }));
  res.json({
    employees: (a ? q('SELECT * FROM employees ORDER BY id') : q('SELECT * FROM employees WHERE id=?', id)).map(E),
    attendanceLogs: (a ? q('SELECT * FROM attendance ORDER BY date DESC, rowid DESC') : q('SELECT * FROM attendance WHERE emp_id=? ORDER BY date DESC', id)).map(r => L(r, sess, ots, brs)),
    leaveRequests: (a ? q('SELECT * FROM leaves ORDER BY rowid DESC') : q('SELECT * FROM leaves WHERE emp_id=? ORDER BY rowid DESC', id)).map(V),
    config: { graceMin: GRACE_MIN, breakMin: BREAK_ALLOWED_MIN, lunchMin: LUNCH_ALLOWED_MIN },
    serverNow: Date.now()
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
  run('INSERT INTO employees(id,name,password_hash,role,hourly_rate,work_start,work_end,joined) VALUES(?,?,?,?,?,?,?,?)',
    nextId(), v.name, bcrypt.hashSync(v.password, 10), v.role, v.hourlyRate, v.workStart, v.workEnd, today());
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
  run('DELETE FROM overtime WHERE emp_id=?', req.params.id);
  run('DELETE FROM breaks WHERE emp_id=?', req.params.id);
  run('DELETE FROM attendance WHERE emp_id=?', req.params.id);
  run('DELETE FROM leaves WHERE emp_id=?', req.params.id);
  run('DELETE FROM employees WHERE id=?', req.params.id);
  broadcast(); res.json({ ok: true });
});

// ---------- ATTENDANCE (multiple punch sessions per day) ----------

// Rebuild the daily summary row from that day's punch sessions.
// - LATE only if the first punch-in is later than THIS employee's shift start + GRACE_MIN minutes.
// - Hours worked = punched hours minus the break / lunch time that went OVER the allowance.
// - Overtime is ONLY the timing the employee declared (overtime table) - never automatic.
function recalc(empId, date) {
  const ps = q('SELECT * FROM punches WHERE emp_id=? AND date=? ORDER BY punch_in, id', empId, date);
  const ex = one('SELECT id FROM attendance WHERE emp_id=? AND date=?', empId, date);
  if (!ps.length) { if (ex) run('DELETE FROM attendance WHERE id=?', ex.id); return; }

  const emp = one('SELECT work_start FROM employees WHERE id=?', empId) || {};
  const ws = emp.work_start || '09:00';

  const gross = ps.reduce((a, p) => a + (p.punch_out ? hoursBetween(p.punch_in, p.punch_out) : 0), 0);

  // Break / lunch minutes used today (a break still running counts up to now)
  const now = Date.now();
  let brk = 0, lun = 0;
  q('SELECT * FROM breaks WHERE emp_id=? AND date=?', empId, date).forEach(b => {
    const m = Math.max(0, ((b.end_ms || now) - b.start_ms) / 60000);
    if (b.kind === 'LUNCH') lun += m; else brk += m;
  });
  const deduct = (Math.max(0, brk - BREAK_ALLOWED_MIN) + Math.max(0, lun - LUNCH_ALLOWED_MIN)) / 60;
  const hours = Math.max(0, gross - deduct);

  const ot = q('SELECT * FROM overtime WHERE emp_id=? AND date=?', empId, date)
    .reduce((a, o) => a + hoursBetween(o.ot_start, o.ot_end), 0);
  const first = ps[0].punch_in, last = ps[ps.length - 1];
  const out = last.punch_out || null;                                   // null = currently punched in
  const count = ps.length + ps.filter(p => p.punch_out).length;          // every IN and every OUT
  const status = mins(first) > mins(ws) + GRACE_MIN ? 'LATE' : 'PRESENT';
  if (ex) run('UPDATE attendance SET clock_in=?, clock_out=?, hours=?, ot=?, punches=?, status=?, break_min=?, lunch_min=?, deduct=? WHERE id=?',
    first, out, hours, ot, count, status, brk, lun, deduct, ex.id);
  else run('INSERT INTO attendance(id,emp_id,date,clock_in,clock_out,hours,ot,status,punches,break_min,lunch_min,deduct) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    'LOG-' + Date.now(), empId, date, first, out, hours, ot, status, count, brk, lun, deduct);
}

// Close any break / lunch still running for that employee (used at punch-out)
function closeBreaks(empId, date, atMs) {
  run('UPDATE breaks SET end_ms=? WHERE emp_id=? AND date=? AND end_ms IS NULL', atMs, empId, date);
}

// Sessions left open on an earlier day (forgot to punch out) are closed at 23:59 so nobody gets locked out
function closeStale(empId) {
  // A break forgotten on an earlier day ends after its normal allowance (no penalty for forgetting)
  q('SELECT * FROM breaks WHERE emp_id=? AND end_ms IS NULL AND date<>?', empId, today()).forEach(b => {
    run('UPDATE breaks SET end_ms=? WHERE id=?', b.start_ms + (b.kind === 'LUNCH' ? LUNCH_ALLOWED_MIN : BREAK_ALLOWED_MIN) * 60000, b.id);
    recalc(b.emp_id, b.date);
  });
  const stale = q('SELECT * FROM punches WHERE emp_id=? AND punch_out IS NULL AND date<>?', empId, today());
  stale.forEach(p => {
    run('UPDATE punches SET punch_out=? WHERE id=?', '23:59', p.id);
    recalc(p.emp_id, p.date);
  });
  return stale.length;
}

const onApprovedLeave = (empId, d) =>
  one("SELECT 1 FROM leaves WHERE emp_id=? AND status='APPROVED' AND start_date<=? AND end_date>=?", empId, d, d);

// Employee punches IN (any number of times, as long as the previous session is closed)
app.post('/api/clock-in', auth, empOnly, (req, res) => {
  const d = today();
  closeStale(req.user.id);
  // Not allowed to punch in on a day covered by approved leave
  if (onApprovedLeave(req.user.id, d))
    return res.status(400).json({ error: 'You are on leave today, so you cannot punch in.' });
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
  closeBreaks(req.user.id, d, Date.now());                 // punching out ends a running break / lunch
  run('UPDATE punches SET punch_out=? WHERE id=?', nowHM(), open.id);
  recalc(req.user.id, d);
  broadcast(); res.json({ ok: true });
});

// ---------- OVERTIME (employee declares the exact timing, e.g. 9:00 PM - 9:30 PM) ----------
app.post('/api/overtime', auth, empOnly, (req, res) => {
  const { start, end } = req.body || {};
  const id = req.user.id, d = today();
  if (!validTime(start) || !validTime(end))
    return res.status(400).json({ error: 'Valid overtime start and end time are required' });
  if (mins(end) <= mins(start))
    return res.status(400).json({ error: 'Overtime end time must be after the start time' });
  if (onApprovedLeave(id, d))
    return res.status(400).json({ error: 'You are on leave today, so overtime cannot be added.' });
  if (!one('SELECT 1 FROM punches WHERE emp_id=? AND date=?', id, d))
    return res.status(400).json({ error: 'Punch in first. Overtime can only be added on a day you attended.' });
  const clash = q('SELECT * FROM overtime WHERE emp_id=? AND date=?', id, d)
    .some(o => mins(start) < mins(o.ot_end) && mins(end) > mins(o.ot_start));
  if (clash) return res.status(400).json({ error: 'This overlaps an overtime slot you already added today.' });
  run('INSERT INTO overtime(emp_id,date,ot_start,ot_end) VALUES(?,?,?,?)', id, d, start, end);
  recalc(id, d);
  broadcast(); res.json({ ok: true });
});

// ---------- BREAK (30 min) / LUNCH (1 hr): free up to the allowance, extra is deducted from the day's hours ----------
app.post('/api/break/start', auth, empOnly, (req, res) => {
  const id = req.user.id, d = today();
  const kind = String((req.body || {}).kind || '').toUpperCase();
  if (!['BREAK', 'LUNCH'].includes(kind)) return res.status(400).json({ error: 'Choose break or lunch' });
  closeStale(id);
  if (onApprovedLeave(id, d)) return res.status(400).json({ error: 'You are on leave today.' });
  if (!one('SELECT 1 FROM punches WHERE emp_id=? AND date=? AND punch_out IS NULL', id, d))
    return res.status(400).json({ error: 'Punch in first. You can take a break only while punched in.' });
  if (one('SELECT 1 FROM breaks WHERE emp_id=? AND end_ms IS NULL', id))
    return res.status(400).json({ error: 'You are already on a break. End it first.' });
  run('INSERT INTO breaks(emp_id,date,kind,start_ms) VALUES(?,?,?,?)', id, d, kind, Date.now());
  recalc(id, d);
  broadcast(); res.json({ ok: true });
});

app.post('/api/break/end', auth, empOnly, (req, res) => {
  const id = req.user.id;
  const b = one('SELECT * FROM breaks WHERE emp_id=? AND end_ms IS NULL ORDER BY id DESC', id);
  if (!b) return res.status(400).json({ error: 'You are not on a break.' });
  run('UPDATE breaks SET end_ms=? WHERE id=?', Date.now(), b.id);
  recalc(id, b.date);
  broadcast(); res.json({ ok: true });
});

// ---------- SUDDEN LEAVE (no application needed - the day becomes LEAVE immediately) ----------
app.post('/api/leave-today', auth, empOnly, (req, res) => {
  const id = req.user.id, d = today();
  closeStale(id);
  if (onApprovedLeave(id, d))
    return res.status(400).json({ error: 'You are already on leave today.' });
  if (one('SELECT 1 FROM punches WHERE emp_id=? AND date=?', id, d))
    return res.status(400).json({ error: 'You have already punched in today, so you cannot take leave for today.' });
  // Auto-approved leave record: this makes the kiosk red, blocks punching, and counts in the dashboard
  run("INSERT INTO leaves(id,emp_id,type,start_date,end_date,reason,status,seen) VALUES(?,?,?,?,?,?,?,1)",
    'LV-' + Date.now(), id, 'Sudden Leave', d, d, 'Marked on leave by employee (no prior application)', 'APPROVED');
  // Daily log row with status ON_LEAVE so admin Attendance Logs shows it too
  run('DELETE FROM attendance WHERE emp_id=? AND date=?', id, d);
  run('INSERT INTO attendance(id,emp_id,date,clock_in,clock_out,hours,ot,status,punches) VALUES(?,?,?,?,?,?,?,?,?)',
    'LOG-' + Date.now(), id, d, null, null, 0, 0, 'ON_LEAVE', 0);
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

// Deletes the whole day (punches, overtime and any sudden leave) for that employee
app.delete('/api/attendance/:id', auth, adminOnly, (req, res) => {
  const row = one('SELECT * FROM attendance WHERE id=?', req.params.id);
  if (row) {
    run('DELETE FROM punches WHERE emp_id=? AND date=?', row.emp_id, row.date);
    run('DELETE FROM overtime WHERE emp_id=? AND date=?', row.emp_id, row.date);
    run('DELETE FROM breaks WHERE emp_id=? AND date=?', row.emp_id, row.date);
    if (row.status === 'ON_LEAVE')
      run("DELETE FROM leaves WHERE emp_id=? AND type='Sudden Leave' AND start_date=? AND end_date=?", row.emp_id, row.date, row.date);
  }
  run('DELETE FROM attendance WHERE id=?', req.params.id);
  broadcast(); res.json({ ok: true });
});

// ---------- LEAVES ----------
app.post('/api/leaves', auth, empOnly, (req, res) => {
  const { type, startDate, endDate, reason } = req.body || {};
  const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (!type || !dateOk(startDate) || !dateOk(endDate) || !String(reason || '').trim())
    return res.status(400).json({ error: 'Leave type, start date, end date and reason are required' });
  if (endDate < startDate) return res.status(400).json({ error: 'End date cannot be before the start date' });
  run('INSERT INTO leaves(id,emp_id,type,start_date,end_date,reason) VALUES(?,?,?,?,?,?)',
    'LV-' + Date.now(), req.user.id, type, startDate, endDate, String(reason).trim());
  broadcast(); res.json({ ok: true });
});

// Admin approves / rejects. seen=0 means the employee has not been notified yet.
app.patch('/api/leaves/:id', auth, adminOnly, (req, res) => {
  const s = (req.body || {}).status;
  if (!['APPROVED', 'REJECTED'].includes(s)) return res.status(400).json({ error: 'Bad status' });
  run('UPDATE leaves SET status=?, seen=0 WHERE id=?', s, req.params.id);
  broadcast(); res.json({ ok: true });
});

// Employee closed the notification pop-up
app.patch('/api/leaves/:id/seen', auth, empOnly, (req, res) => {
  run('UPDATE leaves SET seen=1 WHERE id=? AND emp_id=?', req.params.id, req.user.id);
  res.json({ ok: true });
});

// Open /api/version in the browser to confirm the NEW server.js is the one running
app.get('/api/version', (req, res) => res.json({ version: '1.6.0', features: ['overtime', 'leave-today', 'break-lunch', 'grace'] }));

// Unknown API route -> readable JSON instead of an HTML 404 page
app.use('/api', (req, res) => res.status(404).json({
  error: `API route not found: ${req.method} ${req.originalUrl}. The server is running an old server.js - replace it and restart.`
}));

// Any unexpected server/database error is returned as readable JSON (and logged in the terminal)
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Server error: ' + (err && err.message ? err.message : 'unknown') });
});

app.listen(PORT, () => console.log(`Attendance system running on port ${PORT} (timezone: ${TZ})`));