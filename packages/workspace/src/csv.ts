/**
 * Reading CSV the way it actually arrives (AQ#8).
 *
 * @remarks
 * The parser this replaces had two faults that a real export finds
 * immediately.
 *
 * It only knew the comma. A spreadsheet saving CSV on a French, German or
 * Spanish system writes **semicolons**, because those locales use the comma as
 * the decimal separator — so "CSV" from Excel is routinely not
 * comma-separated. Such a file imported as a single column, silently.
 *
 * And it split the text into lines *before* looking at quotes. A quoted field
 * may contain a newline, and Notion writes them — any multi-line cell became
 * a broken row and shifted every column after it.
 *
 * Both come from the same shortcut: treating CSV as lines of text rather than
 * as a stream with states. This scans characters instead, which is barely more
 * code and is the only way either case works.
 *
 * @category Storage
 */

/** Delimiters worth guessing between. Ordered by how common they are. */
const CANDIDATES = [',', ';', '\t', '|'] as const;

/**
 * Guess the delimiter from the text.
 *
 * @remarks
 * Counts each candidate *outside quotes*, over the first few lines, and takes
 * the one that appears consistently. Consistency rather than frequency: a file
 * of prose separated by semicolons contains plenty of commas, and a header
 * says more than a body does — the delimiter is the character that yields the
 * same field count on every line.
 */
export function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64_000);
  let best = ',';
  let bestScore = -1;

  for (const candidate of CANDIDATES) {
    const rows = parseWith(sample, candidate).slice(0, 20).filter((row) => row.length > 0);
    if (rows.length === 0) continue;
    const columns = rows[0]!.length;
    if (columns < 2) continue; // one column tells us nothing
    const consistent = rows.filter((row) => row.length === columns).length / rows.length;
    // consistency first, then how many columns it explains
    const score = consistent * 100 + Math.min(columns, 40);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * Parse CSV into rows of cells.
 *
 * @param delimiter - Guessed from the text when omitted.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  // a BOM would otherwise become part of the first column's name, so a header
  // called "Nom" arrives as "﻿Nom" and nothing matches it
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return parseWith(cleaned, delimiter ?? sniffDelimiter(cleaned));
}

function parseWith(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // a trailing newline must not produce a row of one empty cell
    if (row.length > 1 || row[0]!.trim() !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"'; // an escaped quote inside a quoted field
        i++;
      } else {
        quoted = false;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\n') {
      endRow();
    } else if (char !== '\r') {
      // CRLF: the carriage return belongs to the line ending, never to a cell
      field += char;
    }
  }
  if (field !== '' || row.length) endRow();
  return rows;
}
