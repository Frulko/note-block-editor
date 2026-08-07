import { describe, expect, it } from 'vitest';
import { parseCsv, sniffDelimiter } from '../src/csv';

/**
 * AQ#8's CSV half: reading the files that actually arrive.
 *
 * The parser this replaces knew only the comma and split lines before looking
 * at quotes. Both faults are silent — the first imports one column, the second
 * shifts every column after a multi-line cell.
 */

describe('the delimiter is guessed, not assumed', () => {
  it('commas', () => {
    expect(sniffDelimiter('Nom,Statut\nAlice,Fini')).toBe(',');
  });

  it('semicolons, which is what a French spreadsheet writes', () => {
    // those locales use the comma as a decimal separator, so "CSV" from Excel
    // is routinely not comma-separated
    expect(sniffDelimiter('Nom;Prix\nAlice;1,50\nBob;2,00')).toBe(';');
  });

  it('tabs', () => {
    expect(sniffDelimiter('Nom\tStatut\nAlice\tFini')).toBe('\t');
  });

  it('is not fooled by commas inside semicolon-separated numbers', () => {
    const french = 'Produit;Prix;Note\nPain;1,20;bon, très bon\nLait;0,95;correct, sans plus';
    expect(sniffDelimiter(french)).toBe(';');
    expect(parseCsv(french)[1]).toEqual(['Pain', '1,20', 'bon, très bon']);
  });

  it('falls back to the comma when nothing separates anything', () => {
    expect(sniffDelimiter('une seule colonne\net une ligne')).toBe(',');
  });
});

describe('quotes', () => {
  it('a quoted field may contain the delimiter', () => {
    expect(parseCsv('a,"b,c",d')[0]).toEqual(['a', 'b,c', 'd']);
  });

  it('a quoted field may contain a newline, which Notion writes', () => {
    const text = 'Nom,Note\nAlice,"première ligne\nseconde ligne"\nBob,court';
    const rows = parseCsv(text);
    // the old parser split on newlines first, so this became three broken rows
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(['Alice', 'première ligne\nseconde ligne']);
    expect(rows[2]).toEqual(['Bob', 'court']);
  });

  it('a doubled quote is one quote', () => {
    expect(parseCsv('a,"il a dit ""bonjour""",c')[0]).toEqual(['a', 'il a dit "bonjour"', 'c']);
  });

  it('a quote in the middle of a bare field is just a character', () => {
    expect(parseCsv('a,2" de haut,c')[0]).toEqual(['a', '2" de haut', 'c']);
  });
});

describe('line endings and stray bytes', () => {
  it('CRLF does not leave a carriage return in the last cell', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('a byte-order mark does not become part of the first column name', () => {
    // otherwise a header called "Nom" arrives as "﻿Nom" and nothing matches
    expect(parseCsv('﻿Nom,Prix\nAlice,1')[0]).toEqual(['Nom', 'Prix']);
  });

  it('a trailing newline does not add an empty row', () => {
    expect(parseCsv('a,b\nc,d\n')).toHaveLength(2);
  });

  it('an empty file is no rows, not one empty row', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('empty cells survive', () => {
  it('a missing value in the middle keeps its column', () => {
    expect(parseCsv('a,,c')[0]).toEqual(['a', '', 'c']);
  });

  it('a trailing empty value keeps its column', () => {
    expect(parseCsv('a,b,')[0]).toEqual(['a', 'b', '']);
  });
});
