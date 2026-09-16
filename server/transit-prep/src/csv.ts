/**
 * Strict minimal CSV parser for GTFS text files.
 * Handles RFC-4180 quoting ("" escapes), CRLF and LF line endings.
 * No dependencies; GTFS never needs more than this.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  eachCsvRow(text, (row) => {
    rows.push(row);
  });
  return rows;
}

/**
 * Streaming rows: invokes onRow per row (header first) without retaining
 * the matrix. Big GTFS files (Brooklyn stop_times is 155 MB) would
 * otherwise blow the default heap on parsing alone.
 */
export function eachCsvRow(text: string, onRow: (row: string[], line: number) => void): void {
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let i = 0;
  let line = 1;
  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    // Skip the phantom row from a single trailing newline.
    if (!(row.length === 1 && row[0] === "" && i >= text.length)) {
      onRow(row, line);
      line += 1;
    }
    row = [];
  };
  while (i < text.length) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          quoted = false;
          i += 1;
        }
      } else {
        field += char;
        i += 1;
      }
    } else if (char === '"') {
      quoted = true;
      i += 1;
    } else if (char === ",") {
      pushField();
      i += 1;
    } else if (char === "\r") {
      pushRow();
      i += text[i + 1] === "\n" ? 2 : 1;
    } else if (char === "\n") {
      pushRow();
      i += 1;
    } else {
      field += char;
      i += 1;
    }
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (row.length > 0 || field !== "") pushRow();
}

/** Split rows into header + body; throws when the file is empty. */
export function headerBody(rows: string[][]): { header: string[]; body: string[][] } {
  const header = rows[0];
  if (!header) throw new Error("CSV has no header row");
  return { header, body: rows.slice(1) };
}

/**
 * Map expected column names to indexes, requiring every expected column.
 * Extra columns are allowed (subway and bus feeds carry different extras);
 * use assertExactHeader in validate when the full header must be pinned.
 */
export function requireColumns(header: string[], expected: string[]): Map<string, number> {
  const missing = expected.filter((name) => !header.includes(name));
  if (missing.length > 0) {
    throw new Error(`CSV header missing columns: ${missing.join(", ")} (got: ${header.join(", ")})`);
  }
  const map = new Map<string, number>();
  for (const name of expected) map.set(name, header.indexOf(name));
  return map;
}

/** Require the header to equal the expected list exactly, in order. */
export function assertExactHeader(file: string, header: string[], expected: string[]): void {
  const same =
    header.length === expected.length && header.every((name, index) => name === expected[index]);
  if (!same) {
    throw new Error(
      `${file} header drift: got [${header.join(", ")}], want [${expected.join(", ")}]`,
    );
  }
}

export function cell(row: string[], columns: Map<string, number>, name: string): string {
  const index = columns.get(name);
  if (index === undefined) throw new Error(`unknown column ${name}`);
  return (row[index] ?? "").trim();
}
