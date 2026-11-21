// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Returns exactly what csv-reader 1.0.0 returns for every input {text, header}:
// {columns, rows, errors}. Semantics, from RULES.txt:
// - a U+FEFF at the very start is dropped;
// - a record ends at LF or CRLF; a line left with no characters is no record;
// - outside quotes a CR not followed by LF is dropped (error stray_cr);
// - a field opening with a quote runs to the next quote that is not doubled,
//   "" inside it is one quote, each CRLF or lone CR inside it is read as LF;
//   what follows its closing quote, up to the next comma or line break, is
//   appended as it stands (quote_junk, when the field ends); a quote that
//   never closes is a literal character and the text after it is read again
//   as unquoted (unterminated_quote);
// - a quote inside an unquoted field is a literal character; fields stay
//   strings, never trimmed or converted;
// - columns is the first record when header is true, else null; rows holds
//   the records after it, each padded with "" (short_row, with fields: its
//   field count) or cut (long_row, with extra: the cut fields) to the first
//   record's width;
// - each error is {code, line, row}, in the order met; line is the 1-based
//   line its record starts on (every LF, CRLF and lone CR inside a quoted
//   field counted), row its record's index in rows (null for the header).
//
// Speed: the hot paths never walk the text one character at a time. Unquoted
// fields are found with one native regex scan for the next delimiter; quoted
// fields are found with indexOf for the closing quote and sliced whole, with
// "" collapsed by split/join; only quoted fields that actually hold a line
// break inside them take a segment-wise path. No dependencies, no I/O, pure.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The next delimiter of an unquoted field: comma, LF or CR. */
const DELIM = /[,\n\r]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Outcome of the last field read: how it ended, and (for a quoted field's
  // junk) how many characters the unquoted tail after its closing quote added.
  let ended = END;
  let added = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field; `ended`
  // says how it ended and `added` counts the characters kept here.
  function readUnquoted(value) {
    added = 0;
    while (pos < n) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (pos < n) {
          value += text.slice(pos, n);
          added += n - pos;
          pos = n;
        }
        ended = END;
        return value;
      }
      const idx = m.index;
      const c = text.charCodeAt(idx);
      if (c === 44) {
        // ','
        value += text.slice(pos, idx);
        added += idx - pos;
        pos = idx + 1;
        ended = COMMA;
        return value;
      }
      if (c === 10) {
        // '\n' (a '\r' before it would have matched first, so this is a bare LF)
        value += text.slice(pos, idx);
        added += idx - pos;
        pos = idx + 1;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      // '\r': CRLF ends the field, a lone CR is dropped (stray_cr).
      if (idx + 1 < n && text.charCodeAt(idx + 1) === 10) {
        value += text.slice(pos, idx);
        added += idx - pos;
        pos = idx + 2;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      value += text.slice(pos, idx);
      added += idx - pos;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = idx + 1;
    }
    ended = END;
    return value;
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field;
  // `ended` says how it ended.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote: the first quote not doubled.
    let search = pos + 1;
    let hasEscape = false;
    let close = -1;
    while (true) {
      const q = text.indexOf('"', search);
      if (q === -1) break;
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        hasEscape = true;
        search = q + 2;
        continue;
      }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    let value;
    const nl = text.indexOf('\n', open + 1);
    const hasNL = nl !== -1 && nl < close;
    const cr = text.indexOf('\r', open + 1);
    const hasCR = cr !== -1 && cr < close;
    if (!hasNL && !hasCR) {
      // No line break inside: the content is one slice, "" collapsed.
      value = hasEscape
        ? text.slice(open + 1, close).split('""').join('"')
        : text.slice(open + 1, close);
    } else {
      // A line break inside: walk segment to segment, "" to one quote and
      // each CRLF or lone CR to one LF, counting lines as csv-reader does.
      const parts = [];
      let p = open + 1;
      while (p < close) {
        const q = text.indexOf('"', p);
        const r = text.indexOf('\r', p);
        const l = text.indexOf('\n', p);
        let m = -1;
        let kind = 0; // 0: escaped quote, 1: CR, 2: LF
        if (q !== -1 && q < close) {
          m = q;
          kind = 0;
        }
        if (r !== -1 && r < close && (m === -1 || r < m)) {
          m = r;
          kind = 1;
        }
        if (l !== -1 && l < close && (m === -1 || l < m)) {
          m = l;
          kind = 2;
        }
        if (m === -1) {
          parts.push(text.slice(p, close));
          break;
        }
        if (kind === 0) {
          parts.push(text.slice(p, m), '"');
          p = m + 2;
        } else if (kind === 1) {
          parts.push(text.slice(p, m), '\n');
          line += 1;
          p = m + (m + 1 < n && text.charCodeAt(m + 1) === 10 ? 2 : 1);
        } else {
          parts.push(text.slice(p, m), '\n');
          line += 1;
          p = m + 1;
        }
      }
      value = parts.join('');
    }
    pos = close + 1;
    if (pos >= n) {
      ended = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      ended = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = pos < n && text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
