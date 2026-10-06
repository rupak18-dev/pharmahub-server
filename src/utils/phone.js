// Phone number helpers supporting Indian mobile (+91) and international E.164 formats.
// Spaces, dashes, dots, and parentheses are tolerated in user input.

const TEN_DIGIT_PATTERN = /^[6-9]\d{9}$/;
const LEADING_ZERO_PATTERN = /^0[6-9]\d{9}$/;
// International format: '+' followed by 1-4 digit country code and 4-14 subscriber digits
const INTERNATIONAL_PATTERN = /^\+[1-9]\d{6,14}$/;

export function normalizePhone(input) {
  if (input == null) return "";
  const cleaned = String(input).replace(/[\s\-().]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) {
    return cleaned;
  }
  if (TEN_DIGIT_PATTERN.test(cleaned)) return `+91${cleaned}`;
  if (LEADING_ZERO_PATTERN.test(cleaned)) return `+91${cleaned.slice(1)}`;
  return cleaned.trim();
}

export function isValidPhone(input) {
  if (input == null || String(input).trim() === "") return false;
  const cleaned = String(input).replace(/[\s\-().]/g, "");
  if (TEN_DIGIT_PATTERN.test(cleaned) || LEADING_ZERO_PATTERN.test(cleaned)) return true;
  return INTERNATIONAL_PATTERN.test(cleaned);
}

// Backwards compatibility aliases
export const normalizeIndianPhone = normalizePhone;
export const isValidIndianPhone = isValidPhone;
