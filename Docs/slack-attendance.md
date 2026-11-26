# Slack attendance notifications

Two messages are posted in **#stacx_admin** (`C0CM0FHAM8B`):

| When | Message |
|---|---|
| An admin marks someone's **today** as Present or WFH for the first time (one person on the Attendance screen, or everyone with "Mark everyone present") | `@person Your attendance has been successfully marked for today. Have a productive day ahead!` (one post for a bulk mark, tagging everyone filled in) |
| Every working day at **11:00 AM IST** (cron job) | `Attendance not marked for today:` followed by a tagged list of everyone still not marked |

No message for:
- edits to a day that is already marked;
- Absent or Leave marks;
- past dates;
- a day that is cleared and marked again.

The not-marked list leaves out weekends, holidays, approved leave and people who have not joined yet, so a weekend or holiday posts nothing.

People are tagged by looking up their leave-management email in Slack. If the email has no Slack account, their name is shown in bold instead.

Code:
- `lib/slack.ts` is the Web API client;
- `lib/attendance-notify.ts` holds the rules and wording;
- `app/api/attendance/not-marked-reminder/route.ts` is the cron endpoint.

A Slack failure is only logged. It never blocks marking attendance.

## One-time setup

### 1. Create the Slack app

1. Go to https://api.slack.com/apps, click **Create New App**, then **From scratch**. Name it `Stacx24 Attendance` and pick the Stacx24 workspace.
2. Open **OAuth & Permissions**. Under **Bot Token Scopes**, add:
   - `chat:write`, to post;
   - `users:read` and `users:read.email`, to tag people by email.
3. Click **Install to Workspace**, then **Allow**. Copy the **Bot User OAuth Token**, which starts with `xoxb-`.
4. In Slack, open #stacx_admin and type `/invite @Stacx24 Attendance`.

### 2. Configure the server

Add these to `/opt/leave-management/.env`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_ATTENDANCE_CHANNEL=C0CM0FHAM8B
ATTENDANCE_CRON_TOKEN=<random secret, e.g. from: openssl rand -hex 32>
```

Then run `npm run build && pm2 restart leave-management --update-env`.

### 3. Schedule the daily reminder

Run `crontab -e` and add this line. 05:30 UTC is 11:00 AM IST, Monday to Friday:

```
30 5 * * 1-5 curl -fsS -X POST -H "Authorization: Bearer <ATTENDANCE_CRON_TOKEN>" https://leave-management.stacx24.com/api/attendance/not-marked-reminder >> /var/log/attendance-reminder.log 2>&1
```

Test it once by hand with the same `curl` command. It returns JSON such as:

```
{"results":[{"organization":"Stacx","notMarked":3,"posted":true}]}
```

| Response | Meaning |
|---|---|
| `401` | The token is wrong. |
| `503` | `SLACK_BOT_TOKEN` is not set. |
