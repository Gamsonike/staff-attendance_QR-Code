const express = require('express'), Database = require('better-sqlite3'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, TZ = process.env.TZ_NAME || 'Africa/Accra', W = 45000;
const db = new Database(process.env.DB_FILE || './attendance.db');
db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
db.exec(`
CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT UNIQUE NOT NULL,pin_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'staff',active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,staff_id INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY,staff_id INTEGER NOT NULL REFERENCES staff(id),date TEXT NOT NULL,time_in TEXT NOT NULL,time_out TEXT,hours REAL,edited INTEGER DEFAULT 0,UNIQUE(staff_id,date));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT,actor INTEGER,action TEXT,detail TEXT);`);

/* ---------- helpers ---------- */
const put = (k, v) => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
if (!db.prepare("SELECT 1 FROM settings WHERE key='secret'").get()) put('secret', crypto.randomBytes(32).toString('hex'));
if (!db.prepare("SELECT 1 FROM settings WHERE key='kiosk_key'").get()) put('kiosk_key', crypto.randomBytes(16).toString('hex'));
function settings() {
  const o = { start: '08:00', end: '17:00', grace: '10', radius: '100', lat: '', lng: '', app_url: process.env.APP_URL || '' };
  for (const r of db.prepare('SELECT * FROM settings').all()) o[r.key] = r.value;
  return { secret: o.secret, kiosk_key: o.kiosk_key, start: o.start, end: o.end, grace: +o.grace, radius: +o.radius, lat: o.lat === '' ? null : +o.lat, lng: o.lng === '' ? null : +o.lng, app_url: o.app_url };
}
const audit = (actor, action, detail) => db.prepare('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), actor, action, JSON.stringify(detail));
const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const hmLocal = iso => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
function localToIso(date, hm) {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = hm.split(':').map(Number), guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  return new Date(guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess)).toISOString();
}
const mins = s => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
function dec(r, S) {
  if (!r.time_in) return r;
  const std = (mins(S.end) - mins(S.start)) / 60;
  return { ...r, in_local: hmLocal(r.time_in), out_local: r.time_out ? hmLocal(r.time_out) : null,
    late: mins(hmLocal(r.time_in)) > mins(S.start) + S.grace, ot: r.hours != null ? Math.max(0, +(r.hours - std).toFixed(2)) : 0,
    missing: !r.time_out && r.date < localDate() };
}
const dist = (a, b, c, d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
const checkPin = (pin, h) => { const [s, x] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(x, 'hex'), crypto.scryptSync(pin, s, 32)); };
const norm = p => String(p || '').replace(/\D/g, ''), okPhone = p => p.length >= 7 && p.length <= 15, okPin = p => /^\d{4,6}$/.test(String(p));
const codeAt = w => String(crypto.createHmac('sha256', settings().secret).update(String(w)).digest().readUIntBE(0, 3) % 1000000).padStart(6, '0');
const codeOk = c => { const w = Math.floor(Date.now() / W); return c === codeAt(w) || c === codeAt(w - 1); };
const fails = new Map();
const locked = k => { const f = fails.get(k); if (f && f.until && Date.now() > f.until) fails.delete(k); return f && f.n >= 5 && Date.now() < f.until; };
const fail = k => { const f = fails.get(k) || { n: 0 }; f.n++; if (f.n >= 5) f.until = Date.now() + 15 * 60e3; fails.set(k, f); };
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]));
const me = u => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, today: localDate() });

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1); app.use(express.json({ limit: '20kb' })); app.use(express.static('public'));
const err = (res, code, msg) => res.status(code).json({ error: msg });
function auth(req, res, next) {
  const t = cookie(req).sid, u = t && db.prepare('SELECT st.* FROM sessions s JOIN staff st ON st.id=s.staff_id WHERE s.token=? AND s.expires>? AND st.active=1').get(t, Date.now());
  if (!u) return err(res, 401, 'Please sign in.'); req.u = u; next();
}
const admin = (req, res, next) => req.u.role === 'admin' ? next() : err(res, 403, 'Admins only.');
function startSession(req, res, u) {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t, u.id, Date.now() + 30 * 864e5);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${req.secure ? '; Secure' : ''}`);
}

app.get('/api/status', (req, res) => res.json({ setup: !db.prepare('SELECT 1 FROM staff').get() }));
app.post('/api/setup', (req, res) => {
  if (db.prepare('SELECT 1 FROM staff').get()) return err(res, 403, 'Already set up.');
  const { name } = req.body, phone = norm(req.body.phone);
  if (!name || !okPhone(phone) || !okPin(req.body.pin)) return err(res, 400, 'Enter a name, valid phone and 4–6 digit PIN.');
  const id = db.prepare("INSERT INTO staff(name,phone,pin_hash,role) VALUES(?,?,?,'admin')").run(String(name).trim(), phone, hashPin(req.body.pin)).lastInsertRowid;
  const u = db.prepare('SELECT * FROM staff WHERE id=?').get(id); startSession(req, res, u); res.json(me(u));
});
app.post('/api/login', (req, res) => {
  const phone = norm(req.body.phone), k1 = 'p' + phone, k2 = 'i' + req.ip;
  if (locked(k1) || locked(k2)) return err(res, 429, 'Too many attempts. Try again in 15 minutes.');
  const u = db.prepare('SELECT * FROM staff WHERE phone=? AND active=1').get(phone);
  if (!u || !checkPin(String(req.body.pin || ''), u.pin_hash)) { fail(k1); fail(k2); return err(res, 401, 'Phone number or PIN is incorrect.'); }
  fails.delete(k1); startSession(req, res, u); res.json(me(u));
});
app.post('/api/logout', auth, (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(cookie(req).sid); res.json({ ok: 1 }); });
app.get('/api/me', auth, (req, res) => res.json(me(req.u)));
app.post('/api/pin', auth, (req, res) => {
  if (!checkPin(String(req.body.old || ''), req.u.pin_hash)) return err(res, 400, 'Current PIN is incorrect.');
  if (!okPin(req.body.new)) return err(res, 400, 'New PIN must be 4–6 digits.');
  db.prepare('UPDATE staff SET pin_hash=? WHERE id=?').run(hashPin(req.body.new), req.u.id); res.json({ ok: 1 });
});

/* ---- sign in / out (all checks happen here, on the server) ---- */
app.post('/api/scan', auth, (req, res) => {
  if (!codeOk(String(req.body.code || ''))) return err(res, 400, 'Code expired or invalid. Use the code currently on the entrance screen.');
  const S = settings();
  if (S.lat != null) {
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') return err(res, 400, 'Location is required. Please allow location access.');
    const d = dist(S.lat, S.lng, lat, lng);
    if (d > S.radius) return err(res, 400, `You appear to be ${Math.round(d)} m from the office (limit ${S.radius} m).`);
  }
  const date = localDate(), now = new Date();
  const out = db.transaction(() => {
    const r = db.prepare('SELECT * FROM attendance WHERE staff_id=? AND date=?').get(req.u.id, date);
    if (!r) { db.prepare('INSERT INTO attendance(staff_id,date,time_in) VALUES(?,?,?)').run(req.u.id, date, now.toISOString()); return { action: 'in', at: hmLocal(now) }; }
    if (r.time_out) return { action: 'done' };
    if (now - new Date(r.time_in) < 60000) return { action: 'wait' };
    const h = Math.round((now - new Date(r.time_in)) / 36e5 * 100) / 100;
    db.prepare('UPDATE attendance SET time_out=?,hours=? WHERE id=?').run(now.toISOString(), h, r.id);
    return { action: 'out', at: hmLocal(now), hours: h };
  })();
  res.json(out);
});
app.get('/api/my', auth, (req, res) => { const S = settings(); res.json(db.prepare('SELECT * FROM attendance WHERE staff_id=? ORDER BY date DESC LIMIT 14').all(req.u.id).map(r => dec(r, S))); });

/* ---- admin ---- */
const qrPayload = (req, S) => { const code = codeAt(Math.floor(Date.now() / W)); return { code, seconds: Math.ceil((W - Date.now() % W) / 1000), url: (S.app_url || `${req.protocol}://${req.get('host')}`) + '/#scan=' + code }; };
app.get('/api/qr', auth, admin, (req, res) => res.json(qrPayload(req, settings())));
app.get('/api/kiosk', (req, res) => {  // entrance display: no login, protected by a secret key
  const S = settings(), k = String(req.query.key || '');
  if (k.length !== S.kiosk_key.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(S.kiosk_key))) return err(res, 403, 'Invalid display link.');
  res.json(qrPayload(req, S));
});
app.post('/api/kiosk/reset', auth, admin, (req, res) => { put('kiosk_key', crypto.randomBytes(16).toString('hex')); audit(req.u.id, 'reset_kiosk_key', {}); res.json({ ok: 1 }); });
app.get('/api/attendance', auth, admin, (req, res) => {
  const S = settings(), date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : localDate();
  res.json({ date, rows: db.prepare('SELECT s.id staff_id,s.name,s.phone,a.date,a.time_in,a.time_out,a.hours,a.edited FROM staff s LEFT JOIN attendance a ON a.staff_id=s.id AND a.date=? WHERE s.active=1 ORDER BY s.name').all(date).map(r => dec(r, S)) });
});
app.put('/api/attendance', auth, admin, (req, res) => {
  const { staff_id, date, time_in, time_out } = req.body, t = /^\d{2}:\d{2}$/;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !t.test(time_in) || (time_out && !t.test(time_out))) return err(res, 400, 'Invalid date or time.');
  const a = localToIso(date, time_in), b = time_out ? localToIso(date, time_out) : null;
  if (b && b <= a) return err(res, 400, 'Sign-out must be after sign-in.');
  const h = b ? Math.round((new Date(b) - new Date(a)) / 36e5 * 100) / 100 : null;
  db.prepare('INSERT INTO attendance(staff_id,date,time_in,time_out,hours,edited) VALUES(?,?,?,?,?,1) ON CONFLICT(staff_id,date) DO UPDATE SET time_in=excluded.time_in,time_out=excluded.time_out,hours=excluded.hours,edited=1').run(staff_id, date, a, b, h);
  audit(req.u.id, 'edit_attendance', { staff_id, date, time_in, time_out }); res.json({ ok: 1 });
});
app.delete('/api/attendance', auth, admin, (req, res) => { db.prepare('DELETE FROM attendance WHERE staff_id=? AND date=?').run(req.query.staff_id, req.query.date); audit(req.u.id, 'delete_attendance', req.query); res.json({ ok: 1 }); });
app.get('/api/report', auth, admin, (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : localDate().slice(0, 7), S = settings();
  const recs = db.prepare('SELECT * FROM attendance WHERE date>=? AND date<=?').all(m + '-01', m + '-31');
  const rows = db.prepare('SELECT id,name,phone FROM staff WHERE active=1 ORDER BY name').all().map(s => {
    const r = recs.filter(x => x.staff_id === s.id).map(x => dec(x, S)), h = r.reduce((a, x) => a + (x.hours || 0), 0), n = r.filter(x => x.hours != null).length;
    return { name: s.name, phone: s.phone, days: r.length, hours: +h.toFixed(2), avg: n ? +(h / n).toFixed(2) : null, late: r.filter(x => x.late).length, ot: +r.reduce((a, x) => a + x.ot, 0).toFixed(2), missing: r.filter(x => x.missing).length };
  });
  if (req.query.csv) {
    const q = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    return res.type('text/csv').set('Content-Disposition', `attachment; filename="attendance-${m}.csv"`)
      .send('Name,Phone,Days,Total hours,Late days,Overtime hours,Missing sign-outs\n' + rows.map(r => [r.name, r.phone, r.days, r.hours, r.late, r.ot, r.missing].map(q).join(',')).join('\n'));
  }
  res.json({ month: m, rows });
});
app.get('/api/staff', auth, admin, (req, res) => res.json(db.prepare('SELECT id,name,phone,role FROM staff WHERE active=1 ORDER BY name').all()));
app.post('/api/staff', auth, admin, (req, res) => {
  const name = String(req.body.name || '').trim(), phone = norm(req.body.phone);
  if (!name || !okPhone(phone) || !okPin(req.body.pin)) return err(res, 400, 'Enter name, valid phone and a 4–6 digit PIN.');
  db.prepare("INSERT INTO staff(name,phone,pin_hash) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name,pin_hash=excluded.pin_hash,active=1").run(name, phone, hashPin(req.body.pin));
  audit(req.u.id, 'upsert_staff', { phone }); res.json({ ok: 1 });
});
app.delete('/api/staff/:id', auth, admin, (req, res) => {
  if (+req.params.id === req.u.id) return err(res, 400, 'You cannot remove yourself.');
  db.prepare('UPDATE staff SET active=0 WHERE id=?').run(req.params.id); db.prepare('DELETE FROM sessions WHERE staff_id=?').run(req.params.id);
  audit(req.u.id, 'deactivate_staff', { id: req.params.id }); res.json({ ok: 1 });
});
app.get('/api/settings', auth, admin, (req, res) => { const { secret, ...S } = settings(); res.json(S); });
app.put('/api/settings', auth, admin, (req, res) => {
  const b = req.body, t = /^\d{2}:\d{2}$/;
  if (!t.test(b.start) || !t.test(b.end) || mins(b.end) <= mins(b.start)) return err(res, 400, 'Invalid working hours.');
  put('start', b.start); put('end', b.end); put('grace', Math.max(0, +b.grace || 0)); put('radius', Math.max(20, +b.radius || 100));
  put('lat', b.lat ?? ''); put('lng', b.lng ?? ''); put('app_url', String(b.app_url || '').replace(/\/+$/, ''));
  audit(req.u.id, 'settings', b); res.json({ ok: 1 });
});
app.use((e, req, res, next) => { console.error(e); err(res, 500, 'Server error.'); });
app.listen(PORT, () => console.log('Attendance server on :' + PORT));
