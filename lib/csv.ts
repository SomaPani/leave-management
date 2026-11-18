/**
 * Rows to CSV text (RFC 4180, CRLF line ends).
 *
 * Text cells that start with `= + - @` get a leading `'`: names, policy names
 * and holiday names are typed by people, and a spreadsheet would otherwise run
 * such a cell as a formula when the file is opened. Numbers are written as-is.
 */
export function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(cell).join(",") + "\r\n").join("");
}

function cell(value: string | number): string {
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
