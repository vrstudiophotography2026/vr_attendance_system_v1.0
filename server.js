const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
// Late rule: LATE only if the first punch-in is MORE than GRACE_MIN minutes after the employee's own shift start
const GRACE_MIN = Number(process.env.GRACE_MIN ?? 5);
// Break / lunch allowance per day. Time taken beyond this is deducted from the day's worked hours.
const BREAK_ALLOWED_MIN = 30;
const LUNCH_ALLOWED_MIN = 60;

// All punch times and dates use this timezone, no matter where the server runs (Render = UTC)
const TZ = process.env.APP_TZ || 'Asia/Kolkata';
const PORT = process.env.PORT || 3000;

// ---------- FIREBASE REALTIME DATABASE ----------
const DB_URL = process.env.FIREBASE_DB_URL || 'https://attendance-system-bc0dd-default-rtdb.firebaseio.com';
function loadServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON (or base64 JSON):', e.message);
    return null;
  }
}
const serviceAccount = loadServiceAccount();
if (!serviceAccount) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT. Firebase console > Project settings > Service accounts > Generate new private key, then paste the whole JSON into this environment variable.');
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount), databaseURL: DB_URL });
const rdb = getDatabase();

const get = async p => (await rdb.ref(p).get()).val();
const set = (p, v) => rdb.ref(p).set(v);
const update = (p, v) => rdb.ref(p).update(v);
const remove = p => rdb.ref(p).remove();
const push = async (p, v) => { const r = rdb.ref(p).push(); await r.set(v); return r.key; };

// Wrap async routes so errors go to the error handler instead of hanging
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- DATA LAYOUT ----------
// admins/{key}                    { username, passwordHash }
// employees/{empId}               { name, passwordHash, dept, role, hourlyRate, workStart, workEnd, joined }
// attendance/{empId}/{date}       daily summary row
// punches/{empId}/{date}/{id}     { in, out }
// overtime/{empId}/{date}/{id}    { start, end }
// breaks/{empId}/{date}/{id}      { kind, start, end }   (start/end are epoch ms)
// leaves/{id}                     { empId, type, startDate, endDate, reason, status, seen, seq }

const encKey = s => encodeURIComponent(String(s)).replace(/\./g, '%2E');
const okKey = s => /^[A-Za-z0-9_-]+$/.test(s);

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

// Reject ids with characters Firebase does not allow in keys
app.param('id', (req, res, next, v) => okKey(v) ? next() : res.status(400).json({ error: 'Bad id' }));

const mins = t => { const [hh, m] = t.split(':'); return hh * 60 + +m; };
const hoursBetween = (i, o) => { let x = (mins(o) - mins(i)) / 60; if (x < 0) x += 24; return x; };
const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
const newId = prefix => prefix + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

// Minutes of [a,b] (24h minutes) that fall inside the shift [ws,we] (handles overnight shifts)
function shiftOverlapMin(a, b, ws, we) {
  let s = mins(ws), e = mins(we);
  if (e <= s) e += 1440;
  if (b < a) b += 1440;
  return overlap(a, b, s, e) + overlap(a + 1440, b + 1440, s, e);
}

// {key: value} -> [{key, ...value}]
const toList = o => o ? Object.entries(o).map(([key, v]) => ({ key, ...v })) : [];
// emp/date/key tree -> flat list with empId + date
const flatTree = tree => {
  const out = [];
  Object.entries(tree || {}).forEach(([empId, days]) =>
    Object.entries(days || {}).forEach(([date, items]) =>
      Object.entries(items || {}).forEach(([key, v]) => out.push({ empId, date, key, ...v }))));
  return out;
};
const dayList = async (kind, empId, date) => toList(await get(`${kind}/${empId}/${date}`));

// Row -> shape the frontend understands (times are stored/sent as 24h "HH:MM", the UI shows 12h)
const E = (id, r) => ({
  id, name: r.name, dept: r.dept || 'Staff', role: r.role, hourlyRate: r.hourlyRate,
  workStart: r.workStart || '09:00', workEnd: r.workEnd || '17:00', joined: r.joined || null
});
const V = (id, r) => ({
  id, empId: r.empId, type: r.type, startDate: r.startDate, endDate: r.endDate,
  reason: r.reason, status: r.status, seen: !!r.seen
});

// ---------- REALTIME (Server-Sent Events to the browser) ----------
const clients = new Set();
const broadcast = () => clients.forEach(r => r.write('data: change\n\n'));
setInterval(() => clients.forEach(r => r.write(': ping\n\n')), 25000);

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
    const a = await get('admins/' + encKey(username || ''));
    if (!a || !bcrypt.compareSync(password || '', a.passwordHash || '')) return bad();
    return res.json({ token: jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '8h' }) });
  }
  const id = String(as || '');
  const e = okKey(id) ? await get('employees/' + id) : null;
  if (!e || !bcrypt.compareSync(password || '', e.passwordHash || '')) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ token: jwt.sign({ role: 'employee', id }, SECRET, { expiresIn: '8h' }) });
}));

// Names only (no secrets) so the "Mode" dropdown can list staff
app.get('/api/public/employees', h(async (req, res) => {
  const list = toList(await get('employees')).map(e => ({ id: e.key, name: e.name }));
  list.sort((x, y) => (x.id < y.id ? -1 : 1));
  res.json(list);
}));

app.get('/api/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Admin gets everything, employee gets only own records
app.get('/api/data', auth, h(async (req, res) => {
  const a = req.user.role === 'admin', id = req.user.id;
  const sub = async kind => a ? await get(kind) : { [id]: await get(`${kind}/${id}`) };

  const sess = {};
  flatTree(await sub('punches'))
    .sort((x, y) => (x.in < y.in ? -1 : x.in > y.in ? 1 : x.key < y.key ? -1 : 1))
    .forEach(p => (sess[p.empId + '|' + p.date] ||= []).push({ in: p.in, out: p.out || null }));

  const ots = {};
  flatTree(await sub('overtime'))
    .sort((x, y) => (x.start < y.start ? -1 : 1))
    .forEach(o => (ots[o.empId + '|' + o.date] ||= []).push({ start: o.start, end: o.end, hours: hoursBetween(o.start, o.end) }));

  const brs = {};
  flatTree(await sub('breaks'))
    .sort((x, y) => x.start - y.start)
    .forEach(b => (brs[b.empId + '|' + b.date] ||= []).push({ kind: b.kind, start: b.start, end: b.end || null }));

  const empTree = a ? await get('employees') : { [id]: await get('employees/' + id) };
  const employees = Object.entries(empTree || {}).filter(([, v]) => v).map(([k, v]) => E(k, v))
    .sort((x, y) => (x.id < y.id ? -1 : 1));

  const attendanceLogs = [];
  Object.entries((await sub('attendance')) || {}).forEach(([empId, days]) =>
    Object.entries(days || {}).forEach(([date, r]) => {
      const k = empId + '|' + date;
      attendanceLogs.push({
        id: `${empId}__${date}`, empId, date, clockIn: r.clockIn || null, clockOut: r.clockOut || null,
        hoursWorked: r.hours || 0, overtimeHours: r.ot || 0, status: r.status, punches: r.punches || 0,
        sessions: sess[k] || [], overtimeSlots: ots[k] || [],
        breakMinutes: r.breakMin || 0, lunchMinutes: r.lunchMin || 0, deductedHours: r.deduct || 0,
        breakSlots: brs[k] || [], _seq: r.seq || 0
      });
    }));
  attendanceLogs.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : y._seq - x._seq));
  attendanceLogs.forEach(l => delete l._seq);

  const leaveRequests = toList(await get('leaves'))
    .filter(r => a || r.empId === id)
    .sort((x, y) => (y.seq || 0) - (x.seq || 0))
    .map(r => V(r.key, r));

  res.json({
    employees, attendanceLogs, leaveRequests,
    config: { graceMin: GRACE_MIN, breakMin: BREAK_ALLOWED_MIN, lunchMin: LUNCH_ALLOWED_MIN },
    serverNow: Date.now()
  });
}));

// ---------- EMPLOYEES (admin) ----------
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
  const keys = Object.keys((await get('employees')) || {});
  const maxNum = keys.reduce((m, k) => Math.max(m, parseInt(k.slice(4), 10) || 0), 100);
  const id = 'EMP-' + (maxNum + 1);
  await set('employees/' + id, {
    name: v.name, passwordHash: bcrypt.hashSync(v.password, 10), dept: 'Staff', role: v.role,
    hourlyRate: v.hourlyRate, workStart: v.workStart, workEnd: v.workEnd, joined: today()
  });
  broadcast(); res.json({ ok: true });
}));

app.put('/api/employees/:id', auth, adminOnly, h(async (req, res) => {
  const v = checkEmployee(req.body, false);
  if (v.error) return res.status(400).json({ error: v.error });
  const id = req.params.id;
  if (!(await get('employees/' + id))) return res.status(404).json({ error: 'Employee not found' });
  const upd = { name: v.name, role: v.role, hourlyRate: v.hourlyRate, workStart: v.workStart, workEnd: v.workEnd };
  if (v.password) upd.passwordHash = bcrypt.hashSync(v.password, 10);
  await update('employees/' + id, upd);
  broadcast(); res.json({ ok: true });
}));

app.delete('/api/employees/:id', auth, adminOnly, h(async (req, res) => {
  const id = req.params.id;
  await Promise.all(['punches', 'overtime', 'breaks', 'attendance', 'employees'].map(k => remove(`${k}/${id}`)));
  for (const l of toList(await get('leaves')).filter(l => l.empId === id)) await remove('leaves/' + l.key);
  broadcast(); res.json({ ok: true });
}));

// ---------- ATTENDANCE (multiple punch sessions per day) ----------

// Rebuild the daily summary row from that day's punches.
// - Regular hours = ONLY the punched time that falls inside the admin-set work timing (start-end),
//   minus break / lunch time that went over the allowance.
// - Overtime = ONLY the exact timing the employee declared. Never automatic, never inside the shift.
// - LATE only if the first punch-in is later than the shift start + GRACE_MIN minutes.
async function recalc(empId, date) {
  const ps = (await dayList('punches', empId, date))
    .sort((x, y) => (x.in < y.in ? -1 : x.in > y.in ? 1 : x.key < y.key ? -1 : 1));
  const attPath = `attendance/${empId}/${date}`;
  if (!ps.length) { await remove(attPath); return; }

  const emp = (await get('employees/' + empId)) || {};
  const ws = emp.workStart || '09:00', we = emp.workEnd || '17:00';

  const regMin = ps.reduce((a, p) => a + (p.out ? shiftOverlapMin(mins(p.in), mins(p.out), ws, we) : 0), 0);
  const gross = regMin / 60;

  const now = Date.now();
  let brk = 0, lun = 0;
  (await dayList('breaks', empId, date)).forEach(b => {
    const m = Math.max(0, ((b.end || now) - b.start) / 60000);
    if (b.kind === 'LUNCH') lun += m; else brk += m;
  });
  const deduct = (Math.max(0, brk - BREAK_ALLOWED_MIN) + Math.max(0, lun - LUNCH_ALLOWED_MIN)) / 60;
  const hours = Math.max(0, gross - deduct);

  const ot = (await dayList('overtime', empId, date)).reduce((a, o) => a + hoursBetween(o.start, o.end), 0);
  const first = ps[0].in, last = ps[ps.length - 1];
  const out = last.out || null;                               // null = currently punched in
  const count = ps.length + ps.filter(p => p.out).length;     // every IN and every OUT
  const status = mins(first) > mins(ws) + GRACE_MIN ? 'LATE' : 'PRESENT';

  const prev = await get(attPath);
  await set(attPath, {
    id: `${empId}__${date}`, empId, date, clockIn: first, clockOut: out, hours, ot, status, punches: count,
    breakMin: brk, lunchMin: lun, deduct, seq: (prev && prev.seq) || Date.now()
  });
}

async function closeBreaks(empId, date, atMs) {
  for (const b of (await dayList('breaks', empId, date)).filter(b => !b.end))
    await update(`breaks/${empId}/${date}/${b.key}`, { end: atMs });
}

// Sessions / breaks left open on an earlier day are closed so nobody gets locked out
async function closeStale(empId) {
  const t = today();
  const brTree = (await get('breaks/' + empId)) || {};
  for (const [date, items] of Object.entries(brTree)) {
    if (date === t) continue;
    let changed = false;
    for (const [key, b] of Object.entries(items || {})) {
      if (b.end) continue;
      await update(`breaks/${empId}/${date}/${key}`, { end: b.start + (b.kind === 'LUNCH' ? LUNCH_ALLOWED_MIN : BREAK_ALLOWED_MIN) * 60000 });
      changed = true;
    }
    if (changed) await recalc(empId, date);
  }
  let staleCount = 0;
  const pTree = (await get('punches/' + empId)) || {};
  for (const [date, items] of Object.entries(pTree)) {
    if (date === t) continue;
    let changed = false;
    for (const [key, p] of Object.entries(items || {})) {
      if (p.out) continue;
      await update(`punches/${empId}/${date}/${key}`, { out: '23:59' });
      changed = true; staleCount++;
    }
    if (changed) await recalc(empId, date);
  }
  return staleCount;
}

const onApprovedLeave = async (empId, d) =>
  toList(await get('leaves')).some(r => r.empId === empId && r.status === 'APPROVED' && r.startDate <= d && r.endDate >= d);

app.post('/api/clock-in', auth, empOnly, h(async (req, res) => {
  const id = req.user.id, d = today();
  if (!(await get('employees/' + id))) return res.status(403).json({ error: 'Employee not found' });
  await closeStale(id);
  if (await onApprovedLeave(id, d))
    return res.status(400).json({ error: 'You are on leave today, so you cannot punch in.' });
  if ((await dayList('punches', id, d)).some(p => !p.out))
    return res.status(400).json({ error: 'You are already punched in. Punch out first.' });
  await push(`punches/${id}/${d}`, { in: nowHM() });
  await recalc(id, d);
  broadcast(); res.json({ ok: true });
}));

app.post('/api/clock-out', auth, empOnly, h(async (req, res) => {
  const id = req.user.id, d = today();
  const staleClosed = await closeStale(id);
  const open = (await dayList('punches', id, d)).filter(p => !p.out).pop();
  if (!open) {
    if (staleClosed) { broadcast(); return res.json({ ok: true, note: 'Previous open session closed' }); }
    return res.status(400).json({ error: 'You are not punched in.' });
  }
  await closeBreaks(id, d, Date.now());                       // punching out ends a running break / lunch
  await update(`punches/${id}/${d}/${open.key}`, { out: nowHM() });
  await recalc(id, d);
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
  if (!(await dayList('punches', id, d)).length)
    return res.status(400).json({ error: 'Punch in first. Overtime can only be added on a day you attended.' });

  // Overtime must be OUTSIDE the regular timing set by the admin (regular hours are paid separately)
  const emp = (await get('employees/' + id)) || {};
  const ws = emp.workStart || '09:00', we = emp.workEnd || '17:00';
  if (shiftOverlapMin(mins(start), mins(end), ws, we) > 0)
    return res.status(400).json({ error: `Overtime must be outside your regular timing (${ws} - ${we}).` });

  const clash = (await dayList('overtime', id, d)).some(o => mins(start) < mins(o.end) && mins(end) > mins(o.start));
  if (clash) return res.status(400).json({ error: 'This overlaps an overtime slot you already added today.' });
  await push(`overtime/${id}/${d}`, { start, end });
  await recalc(id, d);
  broadcast(); res.json({ ok: true });
}));

// ---------- BREAK (30 min) / LUNCH (1 hr) ----------
app.post('/api/break/start', auth, empOnly, h(async (req, res) => {
  const id = req.user.id, d = today();
  const kind = String((req.body || {}).kind || '').toUpperCase();
  if (!['BREAK', 'LUNCH'].includes(kind)) return res.status(400).json({ error: 'Choose break or lunch' });
  await closeStale(id);
  if (await onApprovedLeave(id, d)) return res.status(400).json({ error: 'You are on leave today.' });
  if (!(await dayList('punches', id, d)).some(p => !p.out))
    return res.status(400).json({ error: 'Punch in first. You can take a break only while punched in.' });
  if ((await dayList('breaks', id, d)).some(b => !b.end))
    return res.status(400).json({ error: 'You are already on a break. End it first.' });
  await push(`breaks/${id}/${d}`, { kind, start: Date.now() });
  await recalc(id, d);
  broadcast(); res.json({ ok: true });
}));

app.post('/api/break/end', auth, empOnly, h(async (req, res) => {
  const id = req.user.id;
  const open = flatTree({ [id]: await get('breaks/' + id) }).filter(b => !b.end).pop();
  if (!open) return res.status(400).json({ error: 'You are not on a break.' });
  await update(`breaks/${id}/${open.date}/${open.key}`, { end: Date.now() });
  await recalc(id, open.date);
  broadcast(); res.json({ ok: true });
}));

// ---------- SUDDEN LEAVE (no application needed - the day becomes LEAVE immediately) ----------
app.post('/api/leave-today', auth, empOnly, h(async (req, res) => {
  const id = req.user.id, d = today();
  await closeStale(id);
  if (await onApprovedLeave(id, d))
    return res.status(400).json({ error: 'You are already on leave today.' });
  if ((await dayList('punches', id, d)).length)
    return res.status(400).json({ error: 'You have already punched in today, so you cannot take leave for today.' });
  await set('leaves/' + newId('LV-'), {
    empId: id, type: 'Sudden Leave', startDate: d, endDate: d,
    reason: 'Marked on leave by employee (no prior application)', status: 'APPROVED', seen: true, seq: Date.now()
  });
  await set(`attendance/${id}/${d}`, {
    id: `${id}__${d}`, empId: id, date: d, clockIn: null, clockOut: null, hours: 0, ot: 0,
    status: 'ON_LEAVE', punches: 0, breakMin: 0, lunchMin: 0, deduct: 0, seq: Date.now()
  });
  broadcast(); res.json({ ok: true });
}));

// Admin manual entry: adds one session to that day and sets the chosen status
app.post('/api/attendance', auth, adminOnly, h(async (req, res) => {
  const { empId, date, clockIn, clockOut, status } = req.body || {};
  if (!empId || !validDate(date) || !validTime(clockIn) || !validTime(clockOut))
    return res.status(400).json({ error: 'Employee, date, clock in and clock out are required' });
  if (!okKey(empId) || !(await get('employees/' + empId))) return res.status(400).json({ error: 'Employee not found' });
  await push(`punches/${empId}/${date}`, { in: clockIn, out: clockOut });
  await recalc(empId, date);
  if (status && ['PRESENT', 'LATE', 'ABSENT', 'ON_LEAVE'].includes(status))
    await update(`attendance/${empId}/${date}`, { status });
  broadcast(); res.json({ ok: true });
}));

// Deletes the whole day (punches, overtime, breaks and any sudden leave) for that employee
app.delete('/api/attendance/:id', auth, adminOnly, h(async (req, res) => {
  const m = /^(.+)__(\d{4}-\d{2}-\d{2})$/.exec(req.params.id);
  if (!m) return res.status(400).json({ error: 'Bad log id' });
  const [, empId, date] = m;
  const row = await get(`attendance/${empId}/${date}`);
  await Promise.all(['punches', 'overtime', 'breaks', 'attendance'].map(k => remove(`${k}/${empId}/${date}`)));
  if (row && row.status === 'ON_LEAVE') {
    for (const l of toList(await get('leaves')).filter(l => l.empId === empId && l.type === 'Sudden Leave' && l.startDate === date && l.endDate === date))
      await remove('leaves/' + l.key);
  }
  broadcast(); res.json({ ok: true });
}));

// ---------- LEAVES ----------
app.post('/api/leaves', auth, empOnly, h(async (req, res) => {
  const { type, startDate, endDate, reason } = req.body || {};
  if (!type || !validDate(startDate) || !validDate(endDate) || !String(reason || '').trim())
    return res.status(400).json({ error: 'Leave type, start date, end date and reason are required' });
  if (endDate < startDate) return res.status(400).json({ error: 'End date cannot be before the start date' });
  await set('leaves/' + newId('LV-'), {
    empId: req.user.id, type: String(type), startDate, endDate, reason: String(reason).trim(),
    status: 'PENDING', seen: false, seq: Date.now()
  });
  broadcast(); res.json({ ok: true });
}));

// Admin approves / rejects. seen=false means the employee has not been notified yet.
app.patch('/api/leaves/:id', auth, adminOnly, h(async (req, res) => {
  const s = (req.body || {}).status;
  if (!['APPROVED', 'REJECTED'].includes(s)) return res.status(400).json({ error: 'Bad status' });
  if (!(await get('leaves/' + req.params.id))) return res.status(404).json({ error: 'Leave request not found' });
  await update('leaves/' + req.params.id, { status: s, seen: false });
  broadcast(); res.json({ ok: true });
}));

// Employee closed the notification pop-up
app.patch('/api/leaves/:id/seen', auth, empOnly, h(async (req, res) => {
  const l = await get('leaves/' + req.params.id);
  if (l && l.empId === req.user.id) await update('leaves/' + req.params.id, { seen: true });
  res.json({ ok: true });
}));

app.get('/api/version', (req, res) => res.json({ version: '1.8.0', db: 'firebase-realtime-db', features: ['overtime', 'leave-today', 'break-lunch', 'grace', 'shift-hours'] }));

app.use('/api', (req, res) => res.status(404).json({
  error: `API route not found: ${req.method} ${req.originalUrl}. The server is running an old server.js - replace it and restart.`
}));

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Server error: ' + (err && err.message ? err.message : 'unknown') });
});

// Seed the first admin (only when there is none), then start
(async () => {
  const admins = await get('admins');
  if (!admins) {
    const user = process.env.ADMIN_USER || 'admin@vr';
    const pass = process.env.ADMIN_PASS || 'RojaRaj@1721';
    await set('admins/' + encKey(user), { username: user, passwordHash: bcrypt.hashSync(pass, 10) });
  }
  app.listen(PORT, () => console.log(`Attendance system running on port ${PORT} (timezone: ${TZ}, db: Firebase Realtime Database)`));
})().catch(e => { console.error('Firebase connection failed:', e); process.exit(1); });