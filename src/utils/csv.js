// Minimal RFC-4180-ish CSV parser used for the Report Data CSV import.
// Handles quoted fields ("" escapes), commas inside quotes, CRLF and a BOM.
// A single row's values are normalized so numbers survive as strings here;
// type coercion happens in the importing service.

function splitLine(line, delimiter) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

// Splits raw text into logical records, honouring quotes that contain
// newlines (rare but valid in CSV).
function recordsFrom(text) {
  const rows = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      current += ch;
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      }
    } else if (ch === '"') {
      quoted = true;
      current += ch;
    } else if (ch === "\n") {
      rows.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") rows.push(current);
  return rows;
}

export function parseCsv(text = "", delimiter = ",") {
  const source = String(text).replace(/^\uFEFF/, "");
  const rows = recordsFrom(source).filter((r) => r.trim() !== "");
  if (rows.length === 0) return [];
  const header = splitLine(rows[0], delimiter).map((h) => h.trim().toLowerCase());
  const records = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = splitLine(rows[i], delimiter);
    const record = {};
    header.forEach((name, idx) => {
      record[name] = idx < cells.length ? cells[idx].trim() : "";
    });
    records.push(record);
  }
  return records;
}
