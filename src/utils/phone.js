// Indian mobile number helpers. A valid Indian mobile is a 10-digit number
// starting with 6, 7, 8 or 9, optionally prefixed with the +91 country code
// or a local-dialling leading zero. Spaces, dashes, dots and parentheses are
// tolerated in user input.

const TEN_DIGIT_PATTERN = /^[6-9]\d{9}$/;
// Local-dialling prefix: 0 followed by the 10-digit number.
const LEADING_ZERO_PATTERN = /^0[6-9]\d{9}$/;

export function normalizeIndianPhone(input) {
  if (input == null) return "";
  const cleaned = String(input).replace(/[\s\-().]/g, "");
  if (TEN_DIGIT_PATTERN.test(cleaned)) return `+91${cleaned}`;
  if (LEADING_ZERO_PATTERN.test(cleaned)) return `+91${cleaned.slice(1)}`;
  if (/^\+91\d{10}$/.test(cleaned)) return cleaned;
  return cleaned.trim();
}

export function isValidIndianPhone(input) {
  if (input == null || String(input).trim() === "") return false;
  // Accepts raw 10-digit and +91-prefixed forms (with tolerated separators);
  // the normalized form is always "+91" + 10 digits.
  return /^\+91\d{10}$/.test(normalizeIndianPhone(input));
}
