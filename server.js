// UniReg Cloud - mock registration portal.  Run: node server.js   (Node 16+, no npm install needed)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = process.env, PORT = +E.PORT || 3000, ADMIN = E.ADMIN_KEY || 'admin123';
const LAT = E.LATENCY_SCALE === undefined ? 1 : +E.LATENCY_SCALE;      // simulated DB time multiplier (0 = off)
const PEN = E.LOAD_PENALTY_MS === undefined ? 0.3 : +E.LOAD_PENALTY_MS; // extra ms per in-flight request (slows down under load)
const MAXIN = +E.MAX_INFLIGHT || 250;                                    // per-university in-flight limit -> 503 "busy"
const TTL = 30 * 60e3, FEE = 3500;

const UNI = { A: 'University A', B: 'University B', C: 'University C' };
const SIZE = { A: 20000, B: 10000, C: 5000 };
const STU = [
  ['A2026001', 'Pw4821', 'Rahim Uddin'], ['A2026002', 'Pw7305', 'Nusrat Jahan'], ['A2026003', 'Pw1948', 'Tanvir Ahmed'],
  ['A2026004', 'Pw5562', 'Sadia Islam'], ['A2026005', 'Pw8037', 'Imran Hossain'], ['B2026001', 'Pw2694', 'Farhana Akter'],
  ['B2026002', 'Pw3350', 'Mehedi Hasan'], ['B2026003', 'Pw9176', 'Tasnim Rahman'], ['C2026001', 'Pw6413', 'Arif Chowdhury'],
  ['C2026002', 'Pw0589', 'Sumaiya Khan']
].map(([id, pw, name]) => ({ id, pw, name, uni: id[0] }));
const byId = Object.fromEntries(STU.map(s => [s.id, s]));
// code, title, dept, credits, seats, instructor, time.  CSE101 / ENG101 have few seats on purpose (only 10 test students).
const BASE = [
  ['CSE101', 'Introduction to Programming', 'CSE', 3, 3, 'Dr. Karim', 'Sun/Tue 09:00'],
  ['CSE201', 'Data Structures', 'CSE', 3, 50, 'Dr. Salma', 'Mon/Wed 10:30'],
  ['CSE305', 'Database Systems', 'CSE', 3, 50, 'Mr. Habib', 'Sun/Tue 12:00'],
  ['BBA101', 'Principles of Management', 'Business', 3, 50, 'Ms. Rina', 'Mon/Wed 09:00'],
  ['BBA210', 'Financial Accounting', 'Business', 3, 50, 'Dr. Anwar', 'Tue/Thu 11:00'],
  ['ECO101', 'Microeconomics', 'Business', 3, 50, 'Dr. Farid', 'Sun/Tue 14:00'],
  ['MAT101', 'Calculus I', 'Science', 3, 50, 'Dr. Nasrin', 'Mon/Wed 12:00'],
  ['PHY101', 'Physics I', 'Science', 3, 50, 'Dr. Jalal', 'Tue/Thu 09:30'],
  ['STA201', 'Statistics', 'Science', 3, 50, 'Ms. Lipi', 'Sun/Tue 15:30'],
  ['ENG101', 'Academic English', 'Humanities', 3, 5, 'Ms. Tania', 'Mon/Wed 14:00'],
  ['BEN101', 'Bangla Literature', 'Humanities', 3, 50, 'Dr. Shahin', 'Tue/Thu 13:00'],
  ['ART110', 'Design Fundamentals', 'Arts', 2, 50, 'Mr. Dipu', 'Thu 10:00']
];
const DEPTS = {}; BASE.forEach(c => DEPTS[c[2]] = (DEPTS[c[2]] || 0) + 3);

let courses, mine, N;
const infl = { A: 0, B: 0, C: 0, PUB: 0 }, peak = { A: 0, B: 0, C: 0, PUB: 0 }, sess = new Map();
function reset() {
  courses = {}; mine = {}; N = { req: 0, busy: 0 };
  for (const u in UNI) for (const [code, title, dept, credits, seats, ins, time] of BASE) {
    const id = u + '-' + code;
    courses[id] = { id, uni: u, code, title, dept, credits, seats, ins, time, got: new Set() };
  }
  for (const s of STU) mine[s.id] = [];
}
reset();
const view = (c, sid) => ({ id: c.id, code: c.code, title: c.title, dept: c.dept, credits: c.credits, seats: c.seats,
  left: c.seats - c.got.size, instructor: c.ins, time: c.time, enrolled: c.got.has(sid) });
const send = (res, code, obj, h = {}) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), ...h }); res.end(b);
};
const readBody = req => new Promise(r => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 1e4) req.destroy(); });
  req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } });
});
const wait = (ms, t) => new Promise(r => setTimeout(r, LAT ? LAT * ms * (0.5 + Math.random()) + PEN * infl[t] : 0));
const PUBLIC = new Set(['GET /api/info', 'GET /api/about']);

// Returns [status, body, simulatedDbMs]. Runs synchronously, so seat check + seat grab is atomic (R1).
function handle(key, p, u, b, s, req) {
  if (key === 'GET /api/info') return [200, { students: 35000, sections: Object.keys(courses).length, depts: DEPTS,
    universities: Object.keys(UNI).map(k => ({ id: k, name: UNI[k], students: SIZE[k] })) }, 5];
  if (key === 'GET /api/about') return [200, { title: 'About UniReg Cloud',
    text: ['UniReg Cloud is one registration system serving three universities.',
      'Pre-registration lets you build a preference list. Final registration is first come, first served: seats are limited and never given twice.',
      'If the portal is overloaded you will see a "busy, try again" message instead of an error page.'] }, 5];
  if (key === 'POST /api/login') {
    if (!s || s.pw !== b.password) return [401, { error: 'invalid_credentials' }, 30];
    const token = 'tk-' + crypto.randomBytes(8).toString('hex');
    sess.set(token, { id: s.id, exp: Date.now() + TTL });
    return [200, { token, student: { id: s.id, name: s.name, university: UNI[s.uni] } }, 30];
  }
  if (key === 'POST /api/logout') { sess.delete(req.headers.authorization.slice(7)); return [200, { ok: true }, 5]; }
  if (key === 'GET /api/me') return [200, { id: s.id, name: s.name, university: UNI[s.uni] }, 5];
  if (key === 'GET /api/courses') {
    const q = (u.searchParams.get('q') || '').toLowerCase(), d = u.searchParams.get('dept');
    return [200, Object.values(courses).filter(c => c.uni === s.uni && (!d || c.dept === d) &&
      (c.title + c.code).toLowerCase().includes(q)).map(c => view(c, s.id)), 25];
  }
  if (req.method === 'GET' && p.startsWith('/api/courses/')) {
    const c = courses[p.slice(13)];
    return c && c.uni === s.uni ? [200, view(c, s.id), 15] : [404, { error: 'not_found' }, 5];
  }
  if (key === 'POST /api/enroll') {
    const c = courses[b.courseId];
    if (!c || c.uni !== s.uni) return [404, { error: 'not_found' }, 10];
    if (c.got.has(s.id)) return [409, { error: 'already_enrolled' }, 20];
    if (c.got.size >= c.seats) return [409, { error: 'seat_full', message: 'No seat left in this section.' }, 40];
    c.got.add(s.id); mine[s.id].push(c.id);
    return [201, { ok: true, courseId: c.id, left: c.seats - c.got.size }, 40];
  }
  if (key === 'POST /api/drop') {
    const c = courses[b.courseId];
    if (!c || !c.got.delete(s.id)) return [404, { error: 'not_enrolled' }, 10];
    mine[s.id] = mine[s.id].filter(x => x !== c.id);
    return [200, { ok: true }, 20];
  }
  if (key === 'GET /api/my-courses') return [200, mine[s.id].map(id => view(courses[id], s.id)), 15];
  if (key === 'GET /api/slip') {
    const l = mine[s.id].map(id => courses[id]);
    if (!l.length) return [400, { error: 'no_courses' }, 10];
    const tc = l.reduce((a, c) => a + c.credits, 0);
    return [200, { slipNo: 'PS-' + s.id + '-' + Date.now().toString(36).toUpperCase(), student: s.name, studentId: s.id,
      university: UNI[s.uni], courses: l.map(c => ({ code: c.code, title: c.title, credits: c.credits })),
      totalCredits: tc, amountBDT: tc * FEE, issued: new Date().toISOString() }, 30];
  }
  return [404, { error: 'not_found' }, 0];
}

const stats = () => ({ requests: N.req, busy503: N.busy, inflight: infl, peakInflight: peak, sessions: sess.size,
  overbooked: Object.values(courses).filter(c => c.got.size > c.seats).map(c => c.id),
  seatsTaken: Object.fromEntries(Object.values(courses).filter(c => c.got.size).map(c => [c.id, c.got.size + '/' + c.seats])) });

const readHTML = () => fs.readFileSync(path.join(__dirname, 'index.html'));  // re-read on every request: no restart needed after editing index.html
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  if (!p.startsWith('/api/')) {
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(readHTML());
  }
  N.req++;
  const key = req.method + ' ' + p, body = req.method === 'POST' ? await readBody(req) : {};
  try {
    if (key === 'GET /api/health') return send(res, 200, { ok: true });
    if (p.startsWith('/api/admin/')) {
      if (req.headers['x-admin-key'] !== ADMIN) return send(res, 403, { error: 'forbidden' });
      if (key === 'POST /api/admin/reset') { reset(); return send(res, 200, { ok: true }); }
      return send(res, 200, stats());
    }
    let s = null, t = 'PUB';
    if (key === 'POST /api/login') { s = byId[body.studentId]; t = s ? s.uni : 'PUB'; }
    else if (!PUBLIC.has(key)) {
      const a = sess.get((req.headers.authorization || '').slice(7));
      if (!a || a.exp < Date.now()) return send(res, 401, { error: 'unauthorized' });
      s = byId[a.id]; t = s.uni;
    }
    if (infl[t] >= MAXIN) {   // R4: overloaded -> friendly 503 instead of crashing
      N.busy++;
      return send(res, 503, { error: 'busy', message: 'The portal is busy right now. Please try again in a few seconds.' }, { 'Retry-After': '5' });
    }
    infl[t]++; peak[t] = Math.max(peak[t], infl[t]);
    try { const [code, obj, ms] = handle(key, p, u, body, s, req); await wait(ms, t); send(res, code, obj); }
    finally { infl[t]--; }
  } catch (e) { send(res, 500, { error: 'server_error' }); }
});
server.keepAliveTimeout = 65e3; server.headersTimeout = 66e3;
setInterval(() => { const n = Date.now(); for (const [k, v] of sess) if (v.exp < n) sess.delete(k); }, 60e3).unref();
server.listen(PORT, () => console.log(`UniReg Cloud on http://localhost:${PORT}  (latency x${LAT}, max in-flight/university ${MAXIN})`));
