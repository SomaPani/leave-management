# Score Boards on Real Data — Design

**Date:** 2026-09-09
**Status:** Approved design (pre-plan)
**Goal:** Put `/score` and `/scores` on the daily performance scores that the Standup-Automation pipeline already computes, and enforce the visibility rule the two screens only pretend to have today: an admin sees every member of their own organization, a member sees themselves and has no way to ask for anyone else.

**Builds on:**
[`2026-09-07-leave-approvals-real-data-design.md`](./2026-09-07-leave-approvals-real-data-design.md),
[`2026-09-02-member-attendance-and-holidays-plan.md`](./2026-09-02-member-attendance-and-holidays-plan.md),
[`2026-08-27-multi-tenant-org-rbac-design.md`](./2026-08-27-multi-tenant-org-rbac-design.md).

**Upstream source of truth:** `C:\Users\panis\Projects\Standup-Automation`, specifically
`docs/SCORING.md` (the rubric) and `docs/SCORECARD_API.md` (the pure module contract).
Section references below in the form *SCORING.md §4.7* point at that document.

---

## 1. Where things stand

`/score` and `/scores` are the last two screens on this branch still rendering `lib/seed.ts`. Neither has ever shown a real number.

| # | Defect | Where |
|---|--------|-------|
| C1 | `/score` renders `MY_SCORE`, a module-level constant. Every member of every organization sees the identical 86 / Strong / "182 of 194 working days". There is no user in the read and no organization either. | `app/(member)/score/page.tsx`, `lib/seed.ts:186` |
| C2 | `/score` is the only `(member)` route with a body that never calls `requirePageActor()`. It is covered today by `proxy.ts:44` and by `requirePageRole(Role.MEMBER)` in the layout, but `lib/page-guards.ts:12` says plainly that a page must not depend on the proxy. | `app/(member)/score/page.tsx` |
| C3 | `/scores` keys off `SCORES[person.id]` — a fixture map in `lib/seed.ts` — against a fixture roster from `seedDb()`. An admin is shown seven strangers, not their organization. | `app/(leave)/scores/page.tsx` |
| C4 | Two of the four metrics on `/score` — **Punctuality** and **Utilisation** — have no source anywhere in either system. Nothing computes them and nothing ever will without new instrumentation. | `lib/seed.ts:190-195` |
| C5 | The quarter chart computes bar height as `(value / 100) * (CHART_HEIGHT - 40)`, so 100 maps to 56px and the real spread 82–88 renders as 3.4px. The bars are indistinguishable; the numeric labels do all the work. | `app/(member)/score/page.tsx:74` |
| C6 | Q4 renders a hard `0` with a floor-height bar. A quarter that has not started reads as *scored zero* rather than *not yet* — the same defect class the approvals work fixed elsewhere. | `lib/seed.ts:200` |
| C7 | The year is hardcoded in three places: the page subtitle, the `SCORE 2026` label, and the seed. | `app/(member)/score/page.tsx`, `lib/seed.ts` |
| C8 | `Meter` is a bare `span` pair with no `role="progressbar"` and no `aria-valuenow`. The adjacent text carries the number, so it is not inaccessible, but it is not announced as a meter either. | `components/ui.tsx:108` |
| C9 | There is no score table, no service, and no RBAC predicate. Nothing in `lib/rbac.ts` mentions scores. | `prisma/schema.prisma`, `lib/rbac.ts` |

## 2. The rules this implements

Rules 1–4 are inherited from SCORING.md and are not ours to change. Rules 5–9 were settled during design on 2026-09-09.

1. **`Not Scored` is not zero, ever.** A Jira outage, a Slack fetch failure, an unposted roll-call and approved leave all produce `Not Scored`. An absence produces a real `0`. SCORING.md §7 calls collapsing the two *"the single most likely way this system produces an unfair number, because it is silent."* This is the invariant the schema is shaped around — see §4.

2. **Averages are weighted, and exclude what was not scored.** Mirroring `period_average` in `scorecard.py:697`: `Not Scored` rows are dropped entirely, a **Half Day** counts at 0.5 weight, everything else at 1.0. An empty period averages to `null`, which is not `0` and must not render as one.

3. **A total may exceed 100.** The coordination bonus (SCORING.md §4.7) is deliberately outside the sum-to-100 validation, so a day that scored 100 becomes 110. Production has already produced 105. No column, no check constraint and no meter may assume a 100 ceiling.

4. **Corrections arrive by re-push, not by editing.** SCORING.md §7.2 replaces an appeals process with a nightly recompute over the trailing three days. There is no manual override in the upstream system and this design adds none downstream: the board has no edit affordance, and a late Jira update corrects the screen when the recompute re-pushes it.

5. **Standup pushes; leave-management does not pull.** The pipeline gains a fourth output sink alongside Sheets, the Slack post and the DM. Rejected alternatives are in §3.

6. **A person is identified by email.** `User.email` is globally unique and is already the login identity, so it resolves the organization as well — `organizationId` is copied from the stored `User` row and never read from the request body, the same rule `lib/attendance-service.ts` follows for attendance marks.

7. **An unknown email is reported, not guessed at.** A Standup developer with no `User` row is expected and is not an error. The route accepts the rest of the batch and returns the rejections; the pipeline posts them to `SCORE_OPS_CHANNEL_ID`.

8. **The member read takes no user id.** `listOwnScoreDays(actor, year, month)` has no id parameter at all, the convention `listOwnLeaveRequests` set and `app/(member)/requests/page.tsx:16` states: *"the applicant is the session — so there is no id in the URL for a member to change into a colleague's."* A member cannot see a colleague's score because there is no way to ask for one, not because a check refuses.

9. **The admin read is organization-scoped.** `listOrgScoreDays` filters on `visibleOrgId(actor)`. A `SUPERADMIN` may read an organization's scores — the same read/write split `canListAttendance` and `canMarkAttendance` already draw — and nobody may read across organizations.

## 3. Approach

### 3.1 Transport

**A. Standup POSTs to a new leave-management route.** The pipeline already writes to three external sinks; this is a fourth, guarded by config that is empty by default.

**B. leave-management reads the Google Sheet.** No change to the Python side at all.

**C. Both processes share one Postgres; Python writes the score rows itself.**

**Chosen: A.**

B's appeal is that it touches nothing upstream, and that is real — the pipeline is live and hand-operated, and not modifying it has value. It was rejected on two counts. It puts Google service-account credentials into the web app, which currently holds none. And it promotes the `Scorecard Daily` tab from a human-readable report to a load-bearing API contract, where a column reorder by anyone with edit access on the spreadsheet becomes a silent production break. The tab is a presentation surface and is documented as one (SCORING.md §8.1).

C is worse than it looks. Two writers on one schema with no shared migration history means a Prisma migration silently breaks the Python side at 02:00, unattended, with the failure surfacing as `Not Scored` rows — which rule 1 exists to keep meaning *"the integration is broken"*. It would make that signal ambiguous exactly where it matters most.

A's cost is ~150 lines of additive Python (§6.1). Its payoff is that each system owns its own schema, the pure/IO split upstream is preserved, and the recompute pass carries corrections all the way to the screen with no new machinery.

**Note:** the identity join is needed under A, B and C alike. `Scorecard Daily` names people by Standup short name (`Soma`, `Mallesh`), so the Master tab gains an Email column regardless of transport. The transport choice does not avoid that work.

### 3.2 What the screens show

The fixture's four metrics cannot survive contact with the data (C4). Two options:

**A. Re-point every panel at the real rubric.** Same layout, same components, different meaning: period average and band in the headline card, the five process checks in the meter grid, a per-day trend where the quarter chart is, real counts in the ledger.

**B. Keep the four labels and derive stand-ins** — check-in rate as "Punctuality", delivery ratio as "Utilisation".

**Chosen: A.** B produces numbers whose labels are lies, on a screen whose entire purpose is that a disputed score can be traced to its evidence. A is also a smaller change than it sounds: `Card`, `Meter` and `MonoLabel` are reused unmodified, and the grid shapes are the same.

Scoped to a **month**, following `/calendar`'s `?y=&m=` convention, because the source is daily rows and a month is the period the upstream system already reports on (SCORING.md §8.2).

## 4. Schema

One table, one enum. No changes to any existing model beyond the two back-relations.

```prisma
enum ScoreStatus {
  SCORED
  NOT_SCORED
}

/// One member's performance score for one day, as computed upstream by
/// Standup-Automation and pushed here. Never computed in this application:
/// the scoring rules live in that pipeline's `scorecard.py` and this is a
/// read model of its output.
///
/// `organizationId` is denormalised from the member's own `User` row so the
/// admin screen's hottest query — every score in one organization for one
/// month — is a single indexed read with no join, exactly as `Attendance`
/// does. lib/score-service.ts always copies it from the stored user, never
/// from a request body.
model ScoreDay {
  id String @id @default(cuid())

  userId String
  user   User   @relation("ScoreSubject", fields: [userId], references: [id], onDelete: Cascade)

  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  /// Stored as DATE, not a timestamp: a day has no time and no offset.
  date DateTime @db.Date

  status ScoreStatus
  /// Why a day was not scored — "jira: 503", "no roll-call posted for the day".
  /// Null when SCORED.
  reason String?
  /// The upstream attendance label as reported: Present | Half Day | Absent |
  /// Leave | Weekend | Holiday. Stored as text, not this application's
  /// AttendanceStatus enum: it is the pipeline's judgement about a Slack
  /// roll-call, not a mark an admin made on /attendance, and conflating the
  /// two would make it look like one could be derived from the other.
  attendance String

  /// One column per check (SCORING.md §1). All nullable, and null is the
  /// point: a NOT_SCORED day has no zeros to average by mistake. Making the
  /// invariant in rule 1 structural beats trusting every future query to
  /// remember the filter.
  checkinPts      Float?
  pickedPts       Float?
  descriptionPts  Float?
  commitPts       Float?
  commentPts      Float?
  deliveryPts     Float?
  /// The §4.7 bonus, on top of the 100. 0 when unearned, null when unscored.
  coordinationPts Float?

  process  Float?
  delivery Float?
  /// 0–110, not 0–100 — see rule 3. No check constraint.
  total    Float?
  band     String?

  tasksPicked  Int?
  tasksDone    Int?
  tasksCredit  Float?
  volumeFactor Float?

  /// Jira keys frozen at capture, and the day's flags: unplanned_work,
  /// half_day, no_tasks, under_committed, coordinated.
  pickedTasks String[]
  flags       String[]

  /// From the scoring run that produced the row, not from our clock.
  computedAt DateTime
  receivedAt DateTime @default(now())

  /// The upsert key. A re-push of the same day corrects in place, which is
  /// what carries SCORING.md §7.2 recompute through to the screen.
  @@unique([userId, date])
  @@index([organizationId, date])
}
```

`User` gains `scores ScoreDay[] @relation("ScoreSubject")`; `Organization` gains `scores ScoreDay[]`.

## 5. The ingest contract

`POST /api/scores` — the only route in the application not authenticated by a user session.

```
Authorization: Bearer <SCORE_INGEST_TOKEN>
Content-Type: application/json

{ "source": "standup-automation",
  "days": [{
    "date": "2026-09-08", "email": "soma@stacx24.com",
    "status": "SCORED", "attendance": "Present",
    "points": { "checkin": 10, "picked": 5, "description": 6.7,
                "commit": 0, "comment": 8.3, "done": 60, "coordination": 10 },
    "process": 30, "delivery": 60, "total": 100, "band": "Excellent",
    "tasksPicked": 2, "tasksDone": 2, "tasksCredit": 2.0, "volumeFactor": 1.0,
    "pickedTasks": ["HIR-131", "BHA-158"], "flags": ["coordinated"],
    "computedAt": "2026-09-08T18:04:11" }] }
```

A `NOT_SCORED` day carries `status`, `attendance`, `reason` and `computedAt` only; every numeric field is absent and is stored null.

**Response — `200` with per-row outcome, even when some rows failed:**

```json
{ "accepted": 6, "rejected": [{ "email": "x@y.com", "reason": "no such user" }] }
```

Partial success is the normal case, not a degraded one (rule 7). `401` for a bad token, `400` for a malformed body — a body that cannot be parsed is a mistake in the request, and SCORING.md's own retry policy treats 4xx as *"a real answer"* that must not be retried.

The token is compared with a timing-safe equality check and read from `SCORE_INGEST_TOKEN`. If that variable is unset the route returns `503` rather than accepting anything — an unset secret must not read as an empty-string match.

## 6. Where the code changes

### 6.1 Standup-Automation — additive, and inert until configured

| Change | Where |
|--------|-------|
| Append an `Email` column to the `Master` tab | Sheet data. `read_master()` reads columns 0–3 positionally and `tests/test_master_roster.py:68` already asserts an appended column is ignored — that test exists because `Date of Joining` was appended for the same reason. |
| `roster_emails(sh) -> dict[short, email]`, ~10 lines | `build_scorecard.py`. It never opens the `Master` tab today; its roster comes from Slack via `read_channel`. |
| `compose_payload(records, emails) -> dict`, **pure** | `src/standup_summarizer/scorecard.py`. Pure to preserve the split `SCORECARD_API.md` documents — the module performs no I/O — which is also what makes it testable against literal records with no network. |
| The POST itself | `build_scorecard.py`, in `do_score` after the sheet write. `requests` is already a dependency; `retrying.retry_api` already has the right policy (retry 429/5xx and incomplete connections, raise 4xx immediately). |
| `SCORE_PUSH_URL`, `SCORE_PUSH_TOKEN` | `ScoreConfig.from_env()`. Both empty by default, so an unconfigured pipeline behaves exactly as it does today and this can ship dark. |
| Containment: a failed push prints, alerts ops, and **returns** | SCORING.md §4.7 already establishes the rule for an unreadable coordination channel — *"Extra credit must not be able to take down the scoring of everybody's actual work."* An export earns the same treatment. |

Nothing in `score_day` changes. No weight, no threshold, no existing sink.

Backfill needs no new code: `--recompute --days 30` re-runs the identical scorer over the trailing window and pushes each day, so the board has history the day it goes live.

### 6.2 Two new predicates in `lib/rbac.ts`

```ts
canReadOwnScores(actor)     // MEMBER or ADMIN, in an organization
canListScores(actor)        // ADMIN or SUPERADMIN; scope with visibleOrgId(actor)
```

Mirrors `canReadOwnAttendance` / `canListAttendance`. `canListScores` takes no organization id for the same reason `canListAttendance` does not: the predicate answers *may this actor list at all*, and `visibleOrgId` decides *whose*. Splitting it that way means an organization filter can never be forgotten in one branch and applied in another. Ingest is deliberately **not** a predicate: it is not an actor, and giving a bearer token an `Actor` would let it flow into functions that assume a real user.

### 6.3 A pure rules module — `lib/score.ts`

The aggregation in rule 2 is a rule, not plumbing, and it is a re-implementation of `period_average` in another language. That is a drift risk, so it goes in one pure, unit-tested place — the same split `lib/attendance.ts` and `lib/attendance-service.ts` already use.

```ts
weightOf(day)                  // 0.5 for a half day, 1.0 otherwise
periodAverage(days)            // number | null — null is not zero
summarizeMonth(days)           // per-check averages, counts, the ledger
bandOf(total)                  // ≥85 Excellent · 70 On Track · 50 Needs Attention · At Risk
CHECKS                         // label + key + cap, one definition
```

`CHECKS` mirrors the upstream constant at `scorecard.py:69`, which exists there for exactly this reason: *"a cap that drifted between them would be a scoring bug that only showed up as a mismatched denominator."*

### 6.4 A new module — `lib/score-service.ts`

```ts
listOwnScoreDays(actor, year, month)        // no user id parameter — rule 8
listOrgScoreDays(actor, year, month)        // roster + each member's month
findMemberScoreDays(actor, userId, y, m)    // admin drill-down, org-checked
ingestScoreDays(payload)                    // token-authenticated, no Actor
```

`ingestScoreDays` resolves each email to a `User`, copies `organizationId` from that row, and upserts on `(userId, date)`. Unresolved emails accumulate into `rejected` rather than throwing.

### 6.5 Routes and pages

- `app/api/scores/route.ts` — new, bearer-token `POST`.
- `app/(member)/score/page.tsx` — `requirePageActor()` (fixes C2), month from `?y=&m=`, `DemoBanner` removed.
- `app/(leave)/scores/page.tsx` — real roster, real scores, `?u=` drill-down still org-checked in the service.

### 6.6 The screens

Both keep their current layout. `/score`:

| Panel | Now | After |
|-------|-----|-------|
| Headline card | `86` / `Strong` / placeholder note | Month average / band / "Not scored: 2 days" |
| Meter grid | Attendance, Punctuality, Leave discipline, Utilisation | Check-in, Task picked, Description, Commit, Comment — each `avg / cap` |
| Chart | 4 quarters, 82/88/86/**0** | One bar per day of the month; `Not Scored` renders as a gap, not a zero (fixes C6) |
| Ledger | Working days, WFH, Half days… | Days scored, Not scored, Tasks picked, Tasks done, Coordination days, Absent |

The bar-height bug (C5) is fixed in passing: bars scale against the observed maximum in the month rather than a fixed 56px ceiling, so a 6-point spread is visible. `Meter` gains `role="progressbar"` with `aria-valuenow`/`aria-valuemax` (C8) — a two-line change to a component both screens already use.

Clicking a day opens the breakdown agreed in design: the six check lines, coordination when earned, and the picked ticket keys. Per-task evidence is **not** stored — it stays in the Sheet and the Slack DM where it already lives (§9).

## 7. Testing

- **`lib/score.ts`** — pure, no database. `Not Scored` excluded from averages; half day at 0.5 weight; an all-unscored period returns `null` and not `0`; a total of 110 bands as Excellent and does not clamp.
- **`lib/score-service.ts`** — a member reading their own month; an admin reading their organization; an admin denied another organization's member; a `SUPERADMIN` reading but not ingesting.
- **Ingest** — a valid batch upserts; a re-push of the same `(userId, date)` corrects in place and does not duplicate; an unknown email lands in `rejected` while the rest of the batch is accepted; a bad token is `401`; an unset `SCORE_INGEST_TOKEN` is `503`; a `NOT_SCORED` day stores nulls, not zeros.
- **Upstream** — `compose_payload` against fixture records including a `Not Scored` day and a 110 day; config parsing with both keys absent; a push failure leaves the run's exit code unchanged.

## 8. What is still fixture after this

`/overview` and `/profile` remain on `demoDb()` / `demoMember(db)` and keep their demo banners. They need the same treatment and are not in this design's scope — the same one-screen-at-a-time rhythm the Team, Attendance, Apply and Approvals plans followed.

`MY_SCORE` and `SCORES` are deleted from `lib/seed.ts`; nothing else reads them.

## 9. Out of scope

- **Per-task evidence.** The `evidence` JSON — which ticket passed which check, with Jira links — is not stored. It is available in the Sheet and the DM, and SCORING.md §8.3 deliberately keeps it out of the public post for the same reason it stays off this screen: it turns a readable summary into a wall. Adding it later is a nullable column, not a migration to undo.
- **Computing scores here.** The rubric lives upstream and stays there. This application never scores anybody.
- **The attendance ledger from our own tables.** `Attendance` and `LeaveRequest` genuinely hold working days, WFH days, half days and leave taken, and a future revision of this screen could show them beside the score. It roughly doubles the work and is a separate aggregation concern.
- **Fixing the upstream defects found on 2026-09-09** — dead `SCORE_CAPTURE_HOUR`/`SCORE_CUTOFF_HOUR` config, the recompute window including the current day and alerting on it, and the stale `SCORECARD_API.md`. Real, filed, and not this design's job.
