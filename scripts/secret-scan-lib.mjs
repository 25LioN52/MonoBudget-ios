// Detection rules for scripts/secret-scan.mjs (zero dependencies).
//
// Detects: private keys, GitHub/AWS/AI/Slack tokens, token-like assignments,
// high-entropy strings (e.g. a Monobank token), IBANs with a valid checksum,
// card numbers (Luhn) and file types that typically hold personal data.
// Test data must use invalid IBANs (check digits "00") and masked card numbers.
//
// A false positive can be allow-listed per rule on its line:
//   `secret-scan:allow <rule-id>` — every such line must be justified in review.
// Findings are always masked; nothing here prints a full secret.

export const ALLOW_MARK = "secret-scan:allow";

export const FORBIDDEN_FILES = [
  { re: /(^|\/)\.env(\..*)?$/i, why: "environment file" },
  { re: /\.(pem|key|p12|pfx|keystore|jks|mobileprovision|cer)$/i, why: "key or certificate" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, why: "SSH key" },
  { re: /(^|\/)cache\.json$/i, why: "MonoBudget cache (real transactions)" },
  { re: /(^|\/)(mono|monobank)[-_]?token/i, why: "token file" },
  { re: /\.(pdf|xls|xlsx|csv|ofx|qif|har)$/i, why: "statement export / HTTP archive" },
  { re: /(^|\/)CLAUDE\.local\.md$/i, why: "personal Claude notes" },
  { re: /^(?!docs\/).*\.(png|jpe?g|heic|heif|gif|webp|mov|mp4)$/i, why: "image/video outside docs/ (screenshots may show real data)" },
];

// Built from pieces so this file does not match its own rules.
const PRIVATE_KEY = new RegExp("-----BEGIN [A-Z ]*" + "PRIVATE KEY-----");

const RULES = [
  { id: "private-key", re: PRIVATE_KEY },
  { id: "github-token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { id: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "ai-api-key", re: /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    id: "token-assignment",
    re: /(x-token|token|secret|api[_-]?key|password|passwd)["']?\s*[:=]\s*["'`]([A-Za-z0-9_\-+/=]{20,})["'`]/i,
    check: (m) => entropy(m[2]) >= 3.5,
  },
  // "Trojan Source" and "ASCII smuggling": literal bidi controls, invisible
  // characters and Unicode tag characters (invisible to people, read by LLMs —
  // relevant because this repo ships CLAUDE.md, agents and skills). Built from
  // code points so this file contains none; write such characters as escapes.
  {
    id: "hidden-unicode",
    re: charClass([
      [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e],
      [0x2060, 0x2069], [0xfeff, 0xfeff], [0xe0000, 0xe007f],
    ]),
  },
];

function charClass(ranges) {
  const ch = (code) => String.fromCodePoint(code);
  const part = ([from, to]) => (from === to ? ch(from) : `${ch(from)}-${ch(to)}`);
  return new RegExp(`[${ranges.map(part).join("")}]`, "u");
}

// IBAN lengths per country (ISO 13616 registry). Only exact lengths are checked,
// which keeps random text from matching the mod-97 checksum by chance.
const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22,
  GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30,
  KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31,
  MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24,
  SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

export function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export function isValidIban(raw) {
  const iban = raw.replace(/[\s\u00A0-]+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function isLuhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function mask(value) {
  const v = String(value);
  return v.length <= 6 ? "*".repeat(v.length) : `${v.slice(0, 4)}…(${v.length} chars)`;
}

/** IBANs in a line: any case, grouped with spaces, NBSP or dashes, followed by any text. */
function findIbans(line) {
  const found = [];
  const starts = /(?<![A-Za-z0-9])([A-Za-z]{2})\d{2}/g;
  for (const m of line.matchAll(starts)) {
    const length = IBAN_LENGTHS[m[1].toUpperCase()];
    if (!length) continue;
    let compact = "";
    let raw = "";
    for (const ch of line.slice(m.index)) {
      if (compact.length === length) break;
      if (/[A-Za-z0-9]/.test(ch)) compact += ch;
      else if (!/[\s\u00A0-]/.test(ch)) break;
      raw += ch;
    }
    if (compact.length === length && isValidIban(compact)) found.push(raw.trim());
  }
  return found;
}

/** Rule ids allow-listed on this line (`secret-scan:allow rule-a rule-b`). */
function allowedRules(line) {
  const at = line.indexOf(ALLOW_MARK);
  if (at === -1) return new Set();
  return new Set(line.slice(at + ALLOW_MARK.length).trim().split(/[\s,]+/).filter((id) => /^[a-z-]+$/.test(id)));
}

/** Scan text; returns [{ line, rule, sample }] with masked samples. */
export function scanText(text) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const allowed = allowedRules(line);
    const add = (rule, value) => {
      if (!allowed.has(rule)) findings.push({ line: index + 1, rule, sample: mask(value) });
    };

    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
      for (const m of line.matchAll(re)) {
        if (!rule.check || rule.check(m)) add(rule.id, m[2] || m[0]);
      }
    }

    // High-entropy strings such as a Monobank token (hex hashes stay below the threshold).
    for (const m of line.matchAll(/[A-Za-z0-9_\-+/]{40,}={0,2}/g)) {
      const s = m[0];
      if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && entropy(s) >= 4.5) add("high-entropy-string", s);
    }

    for (const iban of findIbans(line)) add("iban", iban);

    // Card numbers: 13–19 digits (optionally grouped), known prefixes, valid Luhn.
    for (const m of line.matchAll(/\b[2-6]\d{3}(?:[ \u00A0-]?\d){9,15}\b/g)) {
      const digits = m[0].replace(/[ \u00A0-]/g, "");
      if (digits.length >= 13 && digits.length <= 19 && isLuhn(digits)) add("card-number", m[0]);
    }
  });
  return findings;
}

/** Decode a file buffer: UTF-8, or UTF-16 with a BOM. null = binary. */
export function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

export function forbiddenReason(path) {
  const hit = FORBIDDEN_FILES.find((f) => f.re.test(path));
  return hit ? hit.why : null;
}
