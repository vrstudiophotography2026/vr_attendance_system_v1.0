const express = require('express');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Postgres returns BIGINT as string; we want numbers (used for break timestamps)
types.setTypeParser(20, v => parseInt(v, 10));

const SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
// Late rule: LATE only if the first punch-in is MORE than GRACE_MIN minutes after the employee's own shift start
const GRACE_MIN = Number(process.env.GRACE_MIN ?? 5);
// Break / lunch allowance per day. Time taken beyond this is deducted from the day's worked hours.
const BREAK_ALLOWED_MIN = 30;
const LUNCH_ALLOWED_MIN = 60;

// All punch times and dates use this timezone, no matter where the server runs (Render = UTC)
const TZ = process.env.APP_TZ || 'Asia/Kolkata';
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Create a free Postgres database (e.g. Neon) and set DATABASE_URL.');
  process.exit(1);
}

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
app.use(express.static('public', { etag: false, setHeaders: res => res.set('Cache-Control', 'no-store') }));

// ---------- DATABASE (PostgreSQL - data survives redeploys) ----------
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});
pool.on('error', e => console.error('DB pool error:', e.message));

// Keep the "?" placeholders used below: convert to $1, $2 ...
const toPg = s => { let i = 0; return s.replace(/\?/g, () => '$' + (++i)); };
const q = async (s, ...a) => (await pool.query(toPg(s), a)).rows;
const one = async (s, ...a) => (await q(s, ...a))[0];
const run = (s, ...a) => pool.query(toPg(s), a);

// Wrap async routes so errors go to the error handler instead of hanging
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function initDb() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS admins(username TEXT PRIMARY KEY, password_hash TEXT);
CREATE TABLE IF NOT EXISTS employees(
  id TEXT PRIMARY KEY, name TEXT, password_hash TEXT,
  dept TEXT DEFAULT 'Staff', role TEXT, hourly_rate DOUBLE PRECISION,
  work_start TEXT DEFAULT '09:00', work_end TEXT DEFAULT '17:00', joined TEXT);
CREATE TABLE IF NOT EXISTS attendance(
  id TEXT PRIMARY KEY, seq BIGSERIAL, emp_id TEXT, date TEXT, clock_in TEXT, clock_out TEXT,
  hours DOUBLE PRECISION DEFAULT 0, ot DOUBLE PRECISION DEFAULT 0, status TEXT, punches INTEGER DEFAULT 0,
  break_min DOUBLE PRECISION DEFAULT 0, lunch_min DOUBLE PRECISION DEFAULT 0, deduct DOUBLE PRECISION DEFAULT 0);
CREATE TABLE IF NOT EXISTS punches(
  id SERIAL PRIMARY KEY, emp_id TEXT, date TEXT, punch_in TEXT, punch_out TEXT);
CREATE TABLE IF NOT EXISTS overtime(
  id SERIAL PRIMARY KEY, emp_id TEXT, date TEXT, ot_start TEXT, ot_end TEXT);
CREATE TABLE IF NOT EXISTS breaks(
  id SERIAL PRIMARY KEY, emp_id TEXT, date TEXT, kind TEXT, start_ms BIGINT, end_ms BIGINT);
CREATE TABLE IF NOT EXISTS leaves(
  id TEXT PRIMARY KEY, seq BIGSERIAL, emp_id TEXT, type TEXT, start_date TEXT, end_date TEXT,
  reason TEXT, status TEXT DEFAULT 'PENDING', seen INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_att_emp_date ON attendance(emp_id, date);
CREATE INDEX IF NOT EXISTS idx_punch_emp_date ON punches(emp_id, date);
`);
  if (!(await one('SELECT 1 FROM admins'))) {
    // Set ADMIN_USER / ADMIN_PASS in Render env vars (defaults kept so existing login keeps working)
    const user = process.env.ADMIN_USER || 'admin@vr';
    const pass = process.env.ADMIN_PASS || 'RojaRaj@1721';
    await run('INSERT INTO admins VALUES(?,?)', user, bcrypt.hashSync(pass, 10));
  }
}

const mins = t => { const [hh, m] = t.split(':'); return hh * 60 + +m; };
const hoursBetween = (i, o) => { let x = (mins(o) - mins(i)) / 60; if (x < 0) x += 24; return x; };
const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
const newId = prefix => prefix + Date.now() + '-' + crypto.randomBytes(3).toString('hex');

// Minutes of [a,b] (24h minutes) that fall inside the shift [ws,we] (handles overnight shifts)
function shiftOverlapMin(a, b, ws, we) {
  let s = mins(ws), e = mins(we);
  if (e <= s) e += 1440;
  if (b < a) b += 1440;
  return overlap(a, b, s, e) + overlap(a + 1440, b + 1440, s, e);
}

// Row -> shape the frontend understands
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
setInterval(() => clients.forEach(r => r.write(': ping\n\n')), 25000); // keeps the stream alive behind proxies

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

app.post('/api/login', h(async (req, res) => {
  const { as, username, password } = req.body || {};
  const bad = () => res.status(401).json({ error: 'Invalid username or password' });
  if (as === 'admin') {
    const a = await one('SELECT * FROM admins WHERE username=?', String(username || ''));
    if (!a || !bcrypt.compareSync(password || '', a.password_hash)) return bad();
    return res.json({ token: jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '8h' }) });
  }
  const e = await one('SELECT * FROM employees WHERE id=?', String(as || ''));
  if (!e || !bcrypt.compareSync(password || '', e.password_hash || '')) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ token: jwt.sign({ role: 'employee', id: e.id }, SECRET, { expiresIn: '8h' }) });
}));

app.get('/api/public/employees', h(async (req, res) => res.json(await q('SELECT id,name FROM employees ORDER BY id'))));

app.get('/api/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/data', auth, h(async (req, res) => {
  const a = req.user.role === 'admin', id = req.user.id;
  const punchRows = a ? await q('SELECT * FROM punches ORDER BY punch_in, id') : await q('SELECT * FROM punches WHERE emp_id=? ORDER BY punch_in, id', id);
  const sess = {};
  punchRows.forEach(p => (sess[p.emp_id + '|' + p.date] ||= []).push({ in: p.punch_in, out: p.punch_out }));
  const otRows = a ? await q('SELECT * FROM overtime ORDER BY ot_start, id') : await q('SELECT * FROM overtime WHERE emp_id=? ORDER BY ot_start, id', id);
  const ots = {};
  otRows.forEach(o => (ots[o.emp_id + '|' + o.date] ||= []).push({ start: o.ot_start, end: o.ot_end, hours: hoursBetween(o.ot_start, o.ot_end) }));
  const brRows = a ? await q('SELECT * FROM breaks ORDER BY start_ms, id') : await q('SELECT * FROM breaks WHERE emp_id=? ORDER BY start_ms, id', id);
  const brs = {};
  brRows.forEach(b => (brs[b.emp_id + '|' + b.date] ||= []).push({ kind: b.kind, start: b.start_ms, end: b.end_ms }));
  const emps = a ? await q('SELECT * FROM employees ORDER BY id') : await q('SELECT * FROM employees WHERE id=?', id);
  const logs = a ? await q('SELECT * FROM attendance ORDER BY date DESC, seq DESC') : await q('SELECT * FROM attendance WHERE emp_id=? ORDER BY date DESC, seq DESC', id);
  const leaves = a ? await q('SELECT * FROM leaves ORDER BY seq DESC') : await q('SELECT * FROM leaves WHERE emp_id=? ORDER BY seq DESC', id);
  res.json({
    employees: emps.map(E),
    attendanceLogs: logs.map(r => L(r, sess, ots, brs)),
    leaveRequests: leaves.map(V),
    config: { graceMin: GRACE_MIN, breakMin: BREAK_ALLOWED_MIN, lunchMin: LUNCH_ALLOWED_MIN },
    serverNow: Date.now()
  });
}));

// ---------- EMPLOYEES (admin) ----------
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');

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

app.post('/api/employees', auth, adminOnly, h(async (req, res) => {
  const v = checkEmployee(req.body, true);
  if (v.error) return res.status(400).json({ error: v.error });
  const m = (await one("SELECT MAX(CAST(SUBSTR(id,5) AS INTEGER)) AS m FROM employees")).m;
  const id = 'EMP-' + ((m || 100) + 1);
  await run('INSERT INTO employees(id,name,password_hash,role,hourly_rate,work_start,work_end,joined) VALUES(?,?,?,?,?,?,?,?)',
    id, v.name, bcrypt.hashSync(v.password, 10), v.role, v.hourlyRate, v.workStart, v.workEnd, today());
  broadcast(); res.json({ ok: true });
}));

app.put('/api/employees/:id', auth, adminOnly, h(async (req, res) => {
  const v = checkEmployee(req.body, false);
  if (v.error) return res.status(400).json({ error: v.error });
  await run('UPDATE employees SET name=?, role=?, hourly_rate=?, work_start=?, work_end=? WHERE id=?',
    v.name, v.role, v.hourlyRate, v.workStart, v.workEnd, req.params.id);
  if (v.password) await run('UPDATE employees SET password_hash=? WHERE id=?', bcrypt.hashSync(v.password, 10), req.params.id);
  broadcast(); res.json({ ok: true });
}));

app.delete('/api/employees/:id', auth, adminOnly, h(async (req, res) => {
  const id = req.params.id;
  await run('DELETE FROM punches WHERE emp_id=?', id);
  await run('DELETE FROM overtime WHERE emp_id=?', id);
  await run('DELETE FROM breaks WHERE emp_id=?', id);
  await run('DELETE FROM attendance WHERE emp_id=?', id);
  await run('DELETE FROM leaves WHERE emp_id=?', id);
  await run('DELETE FROM employees WHERE id=?', id);
  broadcast(); res.json({ ok: true });
}));

// ---------- ATTENDANCE ----------

// Rebuild the daily summary row from that day's punches.
// - Regular hours = ONLY the punched time that falls inside the admin-set work timing (start-end),
//   minus break / lunch time that went over the allowance.
// - Overtime = ONLY the exact timing the employee declared (e.g. 9:00 PM - 9:30 PM). Never automatic,
//   and never overlaps the shift, so nothing is paid twice.
// - LATE only if the first punch-in is later than the shift start + GRACE_MIN minutes.
async function recalc(empId, date) {
  const ps = await q('SELECT * FROM punches WHERE emp_id=? AND date=? ORDER BY punch_in, id', empId, date);
  const ex = await one('SELECT id FROM attendance WHERE emp_id=? AND date=?', empId, date);
  if (!ps.length) { if (ex) await run('DELETE FROM attendance WHERE id=?', ex.id); return; }

  const emp = (await one('SELECT work_start, work_end FROM employees WHERE id=?', empId)) || {};
  const ws = emp.work_start || '09:00', we = emp.work_end || '17:00';

  // Regular minutes = punched time inside the shift window
  const regMin = ps.reduce((a, p) => a + (p.punch_out ? shiftOverlapMin(mins(p.punch_in), mins(p.punch_out), ws, we) : 0), 0);
  const gross = regMin / 60;

  const now = Date.now();
  let brk = 0, lun = 0;
  (await q('SELECT * FROM breaks WHERE emp_id=? AND date=?', empId, date)).forEach(b => {
    const m = Math.max(0, ((b.end_ms || now) - b.start_ms) / 60000);
    if (b.kind === 'LUNCH') lun += m; else brk += m;
  });
  const deduct = (Math.max(0, brk - BREAK_ALLOWED_MIN) + Math.max(0, lun - LUNCH_ALLOWED_MIN)) / 60;
  const hours = Math.max(0, gross - deduct);

  const ot = (await q('SELECT * FROM overtime WHERE emp_id=? AND date=?', empId, date))
    .reduce((a, o) => a + hoursBetween(o.ot_start, o.ot_end), 0);
  const first = ps[0].punch_in, last = ps[ps.length - 1];
  const out = last.punch_out || null;
  const count = ps.length + ps.filter(p => p.punch_out).length;
  const status = mins(first) > mins(ws) + GRACE_MIN ? 'LATE' : 'PRESENT';
  if (ex) await run('UPDATE attendance SET clock_in=?, clock_out=?, hours=?, ot=?, punches=?, status=?, break_min=?, lunch_min=?, deduct=? WHERE id=?',
    first, out, hours, ot, count, status, brk, lun, deduct, ex.id);
  else await run('INSERT INTO attendance(id,emp_id,date,clock_in,clock_out,hours,ot,status,punches,break_min,lunch_min,deduct) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    newId('LOG-'), empId, date, first, out, hours, ot, status, count, brk, lun, deduct);
}

async function closeBreaks(empId, date, atMs) {
  await run('UPDATE breaks SET end_ms=? WHERE emp_id=? AND date=? AND end_ms IS NULL', atMs, empId, date);
}

// Sessions left open on an earlier day are closed at 23:59 so nobody gets locked out
async function closeStale(empId) {
  const t = today();
  for (const b of await q('SELECT * FROM breaks WHERE emp_id=? AND end_ms IS NULL AND date<>?', empId, t)) {
    await run('UPDATE breaks SET end_ms=? WHERE id=?', b.start_ms + (b.kind === 'LUNCH' ? LUNCH_ALLOWED_MIN : BREAK_ALLOWED_MIN) * 60000, b.id);
    await recalc(b.emp_id, b.date);
  }
  const stale = await q('SELECT * FROM punches WHERE emp_id=? AND punch_out IS NULL AND date<>?', empId, t);
  for (const p of stale) {
    await run('UPDATE punches SET punch_out=? WHERE id=?', '23:59', p.id);
    await recalc(p.emp_id, p.date);
  }
  return stale.length;
}

const onApprovedLeave = (empId, d) =>
  one("SELECT 1 AS x FROM leaves WHERE emp_id=? AND status='APPROVED' AND start_date<=? AND end_date>=?", empId, d, d);

app.post('/api/clock-in', auth, empOnly, h(async (req, res) => {
  const d = today();
  await closeStale(req.user.id);
  if (await onApprovedLeave(req.user.id, d))
    return res.status(400).json({ error: 'You are on leave today, so you cannot punch in.' });
  if (await one('SELECT 1 AS x FROM punches WHERE emp_id=? AND date=? AND punch_out IS NULL', req.user.id, d))
    return res.status(400).json({ error: 'You are already punched in. Punch out first.' });
  await run('INSERT INTO punches(emp_id,date,punch_in) VALUES(?,?,?)', req.user.id, d, nowHM());
  await recalc(req.user.id, d);
  broadcast(); res.json({ ok: true });
}));

app.post('/api/clock-out', auth, empOnly, h(async (req, res) => {
  const d = today();
  const staleClosed = await closeStale(req.user.id);
  const open = await one('SELECT id FROM punches WHERE emp_id=? AND date=? AND punch_out IS NULL ORDER BY id DESC', req.user.id, d);
  if (!open) {
    if (staleClosed) { broadcast(); return res.json({ ok: true, note: 'Previous open session closed' }); }
    return res.status(400).json({ error: 'You are not punched in.' });
  }
  await closeBreaks(req.user.id, d, Date.now());
  await run('UPDATE punches SET punch_out=? WHERE id=?', nowHM(), open.id);
  await recalc(req.user.id, d);
  broadcast(); res.json({ ok: true });
}));

// ---------- OVERTIME (employee declares the exact timing, e.g. 9:00 PM - 9:30 PM) ----------
app.post('/api/overtime', auth, empOnly, h(async (req, res) => {
  const { start, end } = req.body || {};
  const id = req.user.id, d = today();
  if (!validTime(start) || !validTime(end))
    return res.status(400).json({ error: 'Valid overtime start and end time are required' });
  if (mins(end) <= mins(start))
    return res.status(400).json({ error: 'Overtime end time must be after the start time' });
  if (await onApprovedLeave(id, d))
    return res.status(400).json({ error: 'You are on leave today, so overtime cannot be added.' });
  if (!(await one('SELECT 1 AS x FROM punches WHERE emp_id=? AND date=?', id, d)))
    return res.status(400).json({ error: 'Punch in first. Overtime can only be added on a day you attended.' });

  // Overtime must be OUTSIDE the regular timing set by the admin (regular hours are paid separately)
  const emp = (await one('SELECT work_start, work_end FROM employees WHERE id=?', id)) || {};
  const ws = emp.work_start || '09:00', we = emp.work_end || '17:00';
  if (shiftOverlapMin(mins(start), mins(end), ws, we) > 0)
    return res.status(400).json({ error: `Overtime must be outside your regular timing (${ws} - ${we}).` });

  const clash = (await q('SELECT * FROM overtime WHERE emp_id=? AND date=?', id, d))
    .some(o => mins(start) < mins(o.ot_end) && mins(end) > mins(o.ot_start));
  if (clash) return res.status(400).json({ error: 'This overlaps an overtime slot you already added today.' });
  await run('INSERT INTO overtime(emp_id,date,ot_start,ot_end) VALUES(?,?,?,?)', id, d, start, end);
  await recalc(id, d);
  broadcast(); res.json({ ok: true });
}));

// ---------- BREAK / LUNCH ----------
app.post('/api/break/start', auth, empOnly, h(async (req, res) => {
  const id = req.user.id, d = today();
  const kind = String((req.body || {}).kind || '').toUpperCase();
  if (!['BREAK', 'LUNCH'].includes(kind)) return res.status(400).json({ error: 'Choose break or lunch' });
  await closeStale(id);
  if (await onApprovedLeave(id, d)) return res.status(400).json({ error: 'You are on leave today.' });
  if (!(await one('SELECT 1 AS x FROM punches WHERE emp_id=? AND date=? AND punch_out IS NULL', id, d)))
    return res.status(400).json({ error: 'Punch in first. You can take a break only while punched in.' });
  if (await one('SELECT 1 AS x FROM breaks WHERE emp_id=? AND end_ms IS NULL', id))
    return res.status(400).json({ error: 'You are already on a break. End it first.' });
  await run('INSERT INTO breaks(emp_id,date,kind,start_ms) VALUES(?,?,?,?)', id, d, kind, Date.now());
  await recalc(id, d);
  broadcast(); res.json({ ok: true });
}));

app.post('/api/break/end', auth, empOnly, h(async (req, res) => {
  const id = req.user.id;
  const b = await one('SELECT * FROM breaks WHERE emp_id=? AND end_ms IS NULL ORDER BY id DESC', id);
  if (!b) return res.status(400).json({ error: 'You are not on a break.' });
  await run('UPDATE breaks SET end_ms=? WHERE id=?', Date.now(), b.id);
  await recalc(id, b.date);
  broadcast(); res.json({ ok: true });
}));

// ---------- SUDDEN LEAVE ----------
app.post('/api/leave-today', auth, empOnly, h(async (req, res) => {
  const id = req.user.id, d = today();
  await closeStale(id);
  if (await onApprovedLeave(id, d))
    return res.status(400).json({ error: 'You are already on leave today.' });
  if (await one('SELECT 1 AS x FROM punches WHERE emp_id=? AND date=?', id, d))
    return res.status(400).json({ error: 'You have already punched in today, so you cannot take leave for today.' });
  await run("INSERT INTO leaves(id,emp_id,type,start_date,end_date,reason,status,seen) VALUES(?,?,?,?,?,?,?,1)",
    newId('LV-'), id, 'Sudden Leave', d, d, 'Marked on leave by employee (no prior application)', 'APPROVED');
  await run('DELETE FROM attendance WHERE emp_id=? AND date=?', id, d);
  await run('INSERT INTO attendance(id,emp_id,date,clock_in,clock_out,hours,ot,status,punches) VALUES(?,?,?,?,?,?,?,?,?)',
    newId('LOG-'), id, d, null, null, 0, 0, 'ON_LEAVE', 0);
  broadcast(); res.json({ ok: true });
}));

// Admin manual entry: adds one session to that day and sets the chosen status
app.post('/api/attendance', auth, adminOnly, h(async (req, res) => {
  const { empId, date, clockIn, clockOut, status } = req.body || {};
  if (!empId || !date || !validTime(clockIn) || !validTime(clockOut)) return res.status(400).json({ error: 'Employee, date, clock in and clock out are required' });
  await run('INSERT INTO punches(emp_id,date,punch_in,punch_out) VALUES(?,?,?,?)', empId, date, clockIn, clockOut);
  await recalc(empId, date);
  if (status) await run('UPDATE attendance SET status=? WHERE emp_id=? AND date=?', status, empId, date);
  broadcast(); res.json({ ok: true });
}));

app.delete('/api/attendance/:id', auth, adminOnly, h(async (req, res) => {
  const row = await one('SELECT * FROM attendance WHERE id=?', req.params.id);
  if (row) {
    await run('DELETE FROM punches WHERE emp_id=? AND date=?', row.emp_id, row.date);
    await run('DELETE FROM overtime WHERE emp_id=? AND date=?', row.emp_id, row.date);
    await run('DELETE FROM breaks WHERE emp_id=? AND date=?', row.emp_id, row.date);
    if (row.status === 'ON_LEAVE')
      await run("DELETE FROM leaves WHERE emp_id=? AND type='Sudden Leave' AND start_date=? AND end_date=?", row.emp_id, row.date, row.date);
  }
  await run('DELETE FROM attendance WHERE id=?', req.params.id);
  broadcast(); res.json({ ok: true });
}));

// ---------- LEAVES ----------
app.post('/api/leaves', auth, empOnly, h(async (req, res) => {
  const { type, startDate, endDate, reason } = req.body || {};
  const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (!type || !dateOk(startDate) || !dateOk(endDate) || !String(reason || '').trim())
    return res.status(400).json({ error: 'Leave type, start date, end date and reason are required' });
  if (endDate < startDate) return res.status(400).json({ error: 'End date cannot be before the start date' });
  await run('INSERT INTO leaves(id,emp_id,type,start_date,end_date,reason) VALUES(?,?,?,?,?,?)',
    newId('LV-'), req.user.id, type, startDate, endDate, String(reason).trim());
  broadcast(); res.json({ ok: true });
}));

app.patch('/api/leaves/:id', auth, adminOnly, h(async (req, res) => {
  const s = (req.body || {}).status;
  if (!['APPROVED', 'REJECTED'].includes(s)) return res.status(400).json({ error: 'Bad status' });
  await run('UPDATE leaves SET status=?, seen=0 WHERE id=?', s, req.params.id);
  broadcast(); res.json({ ok: true });
}));

app.patch('/api/leaves/:id/seen', auth, empOnly, h(async (req, res) => {
  await run('UPDATE leaves SET seen=1 WHERE id=? AND emp_id=?', req.params.id, req.user.id);
  res.json({ ok: true });
}));

app.get('/api/version', (req, res) => res.json({ version: '1.7.0', db: 'postgres', features: ['overtime', 'leave-today', 'break-lunch', 'grace', 'shift-hours'] }));

app.use('/api', (req, res) => res.status(404).json({
  error: `API route not found: ${req.method} ${req.originalUrl}. The server is running an old server.js - replace it and restart.`
}));

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Server error: ' + (err && err.message ? err.message : 'unknown') });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Attendance system running on port ${PORT} (timezone: ${TZ}, db: postgres)`)))
  .catch(e => { console.error('Database setup failed:', e); process.exit(1); });