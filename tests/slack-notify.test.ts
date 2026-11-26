import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttendanceStatus } from "@/generated/prisma/enums";
import { isFirstMarkToday, markedMessage, notMarkedMessage } from "@/lib/attendance-notify";
import { clearSlackCache, postAttendanceMessage, slackMention } from "@/lib/slack";

const TODAY = "2026-11-26";

describe("messages", () => {
  it("tags the people, then the agreed wording", () => {
    expect(markedMessage(["<@U1>"])).toBe(
      "<@U1> Your attendance has been successfully marked for today. Have a productive day ahead!",
    );
    expect(notMarkedMessage(["<@U1>", "*Anu*"])).toBe("Attendance not marked for today:\n• <@U1>\n• *Anu*");
  });
});

describe("isFirstMarkToday", () => {
  const base = { previous: null, markedBefore: false, status: AttendanceStatus.PRESENT, date: TODAY, today: TODAY };

  it("is the first Present or WFH mark of today", () => {
    expect(isFirstMarkToday(base)).toBe(true);
    expect(isFirstMarkToday({ ...base, status: AttendanceStatus.WFH })).toBe(true);
  });

  it("is not an edit, a re-mark, Absent / Leave, or another day", () => {
    expect(isFirstMarkToday({ ...base, previous: { status: AttendanceStatus.ABSENT } })).toBe(false);
    expect(isFirstMarkToday({ ...base, markedBefore: true })).toBe(false);
    expect(isFirstMarkToday({ ...base, status: AttendanceStatus.ABSENT })).toBe(false);
    expect(isFirstMarkToday({ ...base, status: AttendanceStatus.LEAVE })).toBe(false);
    expect(isFirstMarkToday({ ...base, date: "2026-11-25" })).toBe(false);
  });
});

describe("Slack client", () => {
  const calls: { url: string; auth: string | null; body: URLSearchParams }[] = [];
  let reply: (method: string, body: URLSearchParams) => unknown;

  beforeEach(() => {
    calls.length = 0;
    clearSlackCache();
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.stubEnv("SLACK_ATTENDANCE_CHANNEL", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = new URLSearchParams(init.body as URLSearchParams);
        calls.push({ url, auth: new Headers(init.headers).get("authorization"), body });
        return Response.json(reply(url.split("/").at(-1)!, body));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts in #stacx_admin with the bot token", async () => {
    reply = () => ({ ok: true });
    expect(await postAttendanceMessage("hello")).toBe(true);
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]?.auth).toBe("Bearer xoxb-test");
    expect(calls[0]?.body.get("channel")).toBe("C0CM0FHAM8B");
    expect(calls[0]?.body.get("text")).toBe("hello");
  });

  it("tags by email, and remembers the answer", async () => {
    reply = () => ({ ok: true, user: { id: "U42" } });
    expect(await slackMention({ email: "Anu@Stacx24.com", name: "Anu" })).toBe("<@U42>");
    expect(await slackMention({ email: "anu@stacx24.com", name: "Anu" })).toBe("<@U42>");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.get("email")).toBe("anu@stacx24.com");
  });

  it("falls back to the name for someone not in Slack", async () => {
    reply = () => ({ ok: false, error: "users_not_found" });
    expect(await slackMention({ email: "x@example.test", name: "Anu" })).toBe("*Anu*");
  });

  it("never throws, and sends nothing without a token", async () => {
    reply = () => {
      throw new Error("network down");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await postAttendanceMessage("hello")).toBe(false);

    vi.stubEnv("SLACK_BOT_TOKEN", "");
    calls.length = 0;
    expect(await postAttendanceMessage("hello")).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
