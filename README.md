# UniReg Cloud (mock portal for the performance-testing assignment)

Two files: `index.html` (UI, Tailwind via CDN) and `server.js` (Node, no dependencies). `students.csv` is the same credential list for JMeter/k6.

## Run
```bash
node server.js            # http://localhost:3000   (Node 16+)
PORT=8080 node server.js  # other port
```
The browser needs internet once for the Tailwind CDN script (JMeter/k6 do not need it). Restart the server after editing `index.html`.

## Student accounts (10)
| studentId | password | University |
|---|---|---|
| A2026001 | Pw4821 | A |
| A2026002 | Pw7305 | A |
| A2026003 | Pw1948 | A |
| A2026004 | Pw5562 | A |
| A2026005 | Pw8037 | A |
| B2026001 | Pw2694 | B |
| B2026002 | Pw3350 | B |
| B2026003 | Pw9176 | B |
| C2026001 | Pw6413 | C |
| C2026002 | Pw0589 | C |

Admin key (for reset/stats): `admin123`

## Token
`POST /api/login` returns `{"token":"tk-...","student":{...}}`. Send it on every later request as `Authorization: Bearer <token>`.
JMeter: JSON Extractor `$.token` into `${token}`, then an HTTP Header Manager. k6: `res.json('token')`. One account may hold many tokens at once, so many virtual users can share the 10 accounts. Tokens last 30 minutes.

## API
| Method & path | Auth | Notes |
|---|---|---|
| `GET /` | no | Home page (the SPA) |
| `GET /api/info`, `GET /api/about` | no | Home stats, About page |
| `POST /api/login` `{studentId,password}` | no | 200 token / 401 |
| `POST /api/logout` | yes | |
| `GET /api/courses?q=&dept=` | yes | Course search (own university only) |
| `GET /api/courses/{id}` | yes | Course detail, e.g. `A-CSE101` (id = university letter + code) |
| `POST /api/enroll` `{courseId}` | yes | 201 ok / 409 `seat_full` / 409 `already_enrolled` |
| `POST /api/drop` `{courseId}` | yes | Lets a virtual user loop enroll and drop |
| `GET /api/my-courses`, `GET /api/slip` | yes | Payment slip (400 if no courses) |
| `GET /api/health` | no | Health check |
| `POST /api/admin/reset`, `GET /api/admin/stats` | `X-Admin-Key` | Reset seats between runs; see seats taken, peak load, 503 count, and `overbooked` (must stay `[]` for R1) |

### JMeter journey (Task 3)
Home `GET /` → `POST /api/login` → `GET /api/courses/{univLetter}-CSE101` (course detail) → `GET /api/about` (route change) → `POST /api/logout`.
Use the first letter of `studentId` as the university letter.

## Requirement hooks
- **R1** Seat check and seat grab run in one synchronous step, so a seat is never given twice. `CSE101` has only 3 seats and `ENG101` 5 (the others 50), scaled down because only 10 students exist. Check `overbooked` in `/api/admin/stats`.
- **R2/R3** Each call has a simulated database delay (about 15-50 ms) plus 0.3 ms per request already in flight, so response times grow as load grows.
- **R4** More than 250 in-flight requests for one university returns `503 {"error":"busy","message":"The portal is busy..."}` with `Retry-After: 5`.
- **R5** Limits are counted per university, so a rush on A returns 503 for A only. The server is one Node process, so heavy CPU load from A can still slow B and C a little. That is a good thing to observe and report.

## Tuning (environment variables)
`LATENCY_SCALE` (default 1, `0` = no simulated delay), `LOAD_PENALTY_MS` (0.3), `MAX_INFLIGHT` (250 per university), `ADMIN_KEY`, `PORT`.
Example for an easy overload: `MAX_INFLIGHT=40 node server.js`.

Passwords are plain text in memory and there is no database. Data resets whenever the server restarts.
