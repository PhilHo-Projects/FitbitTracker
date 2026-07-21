import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export const ARCHIVE_NULLABLE_TEXT_ENCODING = 'tagged-v1';

export function encodeArchiveNullableText(value) {
  return value === null || value === undefined ? 'N' : `S${value}`;
}

export function decodeArchiveNullableText(value, encoding) {
  if (!encoding) return value === '\\N' ? null : value;
  if (encoding !== ARCHIVE_NULLABLE_TEXT_ENCODING) {
    throw new Error('Unsupported archive nullable text encoding');
  }
  if (value === 'N') return null;
  if (value.startsWith('S')) return value.slice(1);
  throw new Error('Malformed archive nullable text field');
}

export function encodeCsvRow(values) {
  return `${values.map((value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')}\n`;
}
export async function* readCsvRows(filePath) {
  const decoder = new StringDecoder('utf8');
  let field = '';
  let row = [];
  let quoted = false;
  let pendingQuote = false;

  function process(text, rows) {
    for (const character of text) {
      if (quoted) {
        if (pendingQuote) {
          if (character === '"') {
            field += '"';
            pendingQuote = false;
            continue;
          }
          quoted = false;
          pendingQuote = false;
        }
        if (quoted) {
          if (character === '"') pendingQuote = true;
          else field += character;
          continue;
        }
      }
      if (character === '"' && field.length === 0) quoted = true;
      else if (character === ',') {
        row.push(field);
        field = '';
      } else if (character === '\n') {
        if (field.endsWith('\r')) field = field.slice(0, -1);
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += character;
      }
    }
  }

  for await (const chunk of createReadStream(filePath)) {
    const rows = [];
    process(decoder.write(chunk), rows);
    for (const parsed of rows) yield parsed;
  }
  const rows = [];
  process(decoder.end(), rows);
  for (const parsed of rows) yield parsed;
  if (quoted || pendingQuote) {
    if (pendingQuote) quoted = false;
    if (quoted) throw new Error('Malformed CSV: unterminated quoted field');
  }
  if (field.length || row.length) {
    row.push(field);
    yield row;
  }
}
