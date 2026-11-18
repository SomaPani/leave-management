import { describe, expect, it } from "vitest";

import { toCsv } from "@/lib/csv";

describe("toCsv", () => {
  it("joins plain cells with commas and rows with CRLF", () => {
    expect(toCsv([["Date", "Day"], ["2026-11-02", 3]])).toBe("Date,Day\r\n2026-11-02,3\r\n");
  });

  it("quotes a cell with a comma, a quote or a newline", () => {
    expect(toCsv([['a,b', 'say "hi"', "two\nlines"]])).toBe('"a,b","say ""hi""","two\nlines"\r\n');
  });

  it("defuses a cell a spreadsheet would run as a formula", () => {
    expect(toCsv([["=SUM(A1)", "+1", "-2", "@cmd", "ok"]])).toBe("'=SUM(A1),'+1,'-2,'@cmd,ok\r\n");
  });

  it("leaves numbers alone, including negative ones", () => {
    expect(toCsv([[-1, 0, 12]])).toBe("-1,0,12\r\n");
  });

  it("writes an empty row as a blank line", () => {
    expect(toCsv([["a"], [], ["b"]])).toBe("a\r\n\r\nb\r\n");
  });
});
