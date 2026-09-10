import { describe, expect, it } from "vitest";

import { parseScorePayload } from "@/lib/score-input";
import { HttpError } from "@/lib/rbac";

/**
 * What the ingest endpoint will accept, with no database in sight.
 *
 * The load-bearing case is the second one: a day the pipeline could not score
 * arrives with no numbers at all, and every column has to stay null. A zero
 * here would make a Jira outage indistinguishable from a bad day, which is the
 * one failure the whole design is shaped to prevent.
 */

const scored = {
  date: "2026-09-08",
  email: "Soma@Stacx24.com",
  status: "SCORED",
  attendance: "Present",
  points: {
    checkin: 10,
    picked: 5,
    description: 6.7,
    commit: 0,
    comment: 8.3,
    done: 60,
    coordination: 10,
  },
  process: 30,
  delivery: 60,
  total: 100,
  band: "Excellent",
  tasksPicked: 2,
  tasksDone: 2,
  tasksCredit: 2,
  volumeFactor: 1,
  pickedTasks: ["HIR-131", "BHA-158"],
  flags: ["coordinated"],
  computedAt: "2026-09-08T18:04:11",
};

describe("parseScorePayload", () => {
  it("reads a scored day and lower-cases the email", () => {
    const [day] = parseScorePayload({ days: [scored] });
    expect(day.email).toBe("soma@stacx24.com");
    expect(day.date).toBe("2026-09-08");
    expect(day.total).toBe(100);
    expect(day.deliveryPts).toBe(60);
    expect(day.pickedTasks).toEqual(["HIR-131", "BHA-158"]);
  });

  it("stores nulls, not zeros, for a day that was not scored", () => {
    const [day] = parseScorePayload({
      days: [
        {
          date: "2026-09-09",
          email: "soma@stacx24.com",
          status: "NOT_SCORED",
          attendance: "Unknown",
          reason: "no roll-call posted for the day",
          computedAt: "2026-09-09T02:00:00",
        },
      ],
    });
    expect(day.status).toBe("NOT_SCORED");
    expect(day.total).toBeNull();
    expect(day.checkinPts).toBeNull();
    expect(day.reason).toBe("no roll-call posted for the day");
    expect(day.pickedTasks).toEqual([]);
  });

  it("accepts a total above 100 — the coordination bonus is real", () => {
    const [day] = parseScorePayload({ days: [{ ...scored, total: 110 }] });
    expect(day.total).toBe(110);
  });

  it("rejects a body with no days array", () => {
    expect(() => parseScorePayload({})).toThrow(HttpError);
  });

  it("rejects a day with no email", () => {
    const withoutEmail: Record<string, unknown> = { ...scored };
    delete withoutEmail.email;
    expect(() => parseScorePayload({ days: [withoutEmail] })).toThrow(/email/);
  });

  it("rejects a malformed date", () => {
    expect(() => parseScorePayload({ days: [{ ...scored, date: "08-09-2026" }] })).toThrow(
      /date/,
    );
  });

  it("rejects an unknown status", () => {
    expect(() => parseScorePayload({ days: [{ ...scored, status: "MAYBE" }] })).toThrow(
      /status/,
    );
  });

  it("rejects an empty batch, which is always a mistake in the caller", () => {
    expect(() => parseScorePayload({ days: [] })).toThrow(HttpError);
  });
});
