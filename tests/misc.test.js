"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadCore, testConfig, ROOT } = require("./helpers");

const core = loadCore();
const SOURCE = fs.readFileSync(path.join(ROOT, "MonoBudget.js"), "utf8");

test("formatMoney: uk and en, rounding, signs", () => {
  assert.equal(core.formatMoney(7600, "uk"), "76\u00A0€");
  assert.equal(core.formatMoney(88571.43, "uk", { decimals: true }), "885,71\u00A0€");
  assert.equal(core.formatMoney(123456789, "uk", { decimals: true }), "1\u00A0234\u00A0567,89\u00A0€");
  assert.equal(core.formatMoney(123456789, "en"), "1,234,568\u00A0€");
  assert.equal(core.formatMoney(-2400, "en"), "\u221224\u00A0€");
  assert.equal(core.formatMoney(1200, "en", { sign: true }), "+12\u00A0€");
  assert.equal(core.formatMoney(-20, "en"), "0\u00A0€"); // no "\u22120"
});

test("time and day formatting in the configured zone", () => {
  const ms = Date.parse("2026-06-30T22:30:00Z");
  assert.equal(core.formatTime(ms, "Europe/Madrid"), "00:30");
  assert.equal(core.formatDay(ms, "Europe/Madrid", "uk"), "ср, 1 лип.");
  assert.equal(core.formatDay(ms, "Europe/Madrid", "en"), "Wed, 1 Jul");
  assert.equal(core.formatAgo(ms - 5 * 60000, ms, "uk"), "5 хв тому");
  assert.equal(core.formatAgo(ms - 3 * 3600000, ms, "en"), "3 h ago");
});

test("language resolution", () => {
  assert.equal(core.resolveLanguage("uk", "en"), "uk");
  assert.equal(core.resolveLanguage("auto", "uk"), "uk");
  assert.equal(core.resolveLanguage("auto", "es"), "en");
});

test("all UI strings exist in both languages", () => {
  const keys = (obj) => Object.keys(obj).sort();
  assert.deepEqual(keys(core.STRINGS.uk), keys(core.STRINGS.en));
  assert.deepEqual(keys(core.STRINGS.uk.errors), keys(core.STRINGS.en.errors));
  assert.deepEqual(keys(core.STRINGS.uk.reasons), keys(core.STRINGS.en.reasons));
});

test("validateConfig accepts defaults and reports bad values", () => {
  assert.deepEqual(core.validateConfig(core.CONFIG), []);
  const bad = testConfig(core, { weeklyLimit: -1, timezone: "Mars/Olympus", warnPct: 120, accountIds: ["../x"], language: "de" });
  const errors = core.validateConfig(bad);
  assert.equal(errors.length, 5);
});

test("security: token validation rejects whitespace, newlines and junk", () => {
  const sample = "A".repeat(20) + "b_c-d";
  assert.equal(core.normalizeToken(`  ${sample}\n`), sample);
  assert.equal(core.normalizeToken(`${sample}\r\nX-Evil: 1`), null);
  assert.equal(core.normalizeToken("short"), null);
  assert.equal(core.normalizeToken(""), null);
  assert.equal(core.normalizeToken(undefined), null);
});

test("security: account ids cannot inject into the request path", () => {
  assert.throws(() => core.statementPath({ accountId: "../client-info", from: 0, to: 1000 }));
  assert.throws(() => core.statementPath({ accountId: "a/b", from: 0, to: 1000 }));
  assert.equal(core.statementPath({ accountId: "abc_DEF-123", from: 1000, to: 5999 }), "/personal/statement/abc_DEF-123/1/5");
  const clientInfo = { accounts: [{ id: "ok1", currencyCode: 978 }, { id: "bad/../id", currencyCode: 978 }] };
  assert.deepEqual(core.selectAccounts(clientInfo, testConfig(core)).map((a) => a.id), ["ok1"]);
});

test("security: API text is sanitised before display", () => {
  assert.equal(core.cleanText("Shop\n\u0000Name\t  X"), "Shop Name X");
  assert.equal(core.cleanText("x".repeat(100), 10).length, 10);
});

test("security: only api.monobank.ua is contacted, token is never logged", () => {
  const urls = SOURCE.match(/https?:\/\/[^\s"'`)]+/g) || [];
  for (const url of urls) {
    assert.ok(/^https:\/\/(api\.monobank\.ua|github\.com\/25LioN52\/MonoBudget-ios)/.test(url), `unexpected URL ${url}`);
  }
  assert.equal((SOURCE.match(/new Request\(/g) || []).length, 1, "single network call site");
  assert.ok(!/console\.(log|warn|error)/.test(SOURCE), "no console logging");
  assert.ok(!/\blog(Error|Warning)?\(/.test(SOURCE), "no Scriptable logging");
  assert.ok(!/FileManager\.iCloud/.test(SOURCE), "cache stays local");
  assert.ok(!/WebView/.test(SOURCE), "no HTML rendering of API data");
  assert.ok(!/allowInsecureRequest/.test(SOURCE), "TLS validation not disabled");
});

test("migrateState discards unknown cache versions", () => {
  assert.deepEqual(core.migrateState({ version: 999, accounts: { x: 1 } }), core.emptyState());
  assert.deepEqual(core.migrateState(null), core.emptyState());
});

test("security: redirects are never followed (token would leak to another host)", () => {
  assert.ok(/request\.onRedirect = \(\) => null;/.test(SOURCE));
});

test("security: no literal bidi/invisible characters in the script (Trojan Source)", () => {
  const hidden = (c) => (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) ||
    c === 0xfeff || c === 0xa0 || (c >= 0x80 && c <= 0x9f);
  const found = [...SOURCE].map((ch) => ch.codePointAt(0)).filter(hidden);
  assert.deepEqual(found.map((c) => "U+" + c.toString(16)), [], "use escapes instead of literal characters");
});

test("security: bidi overrides and zero-width characters are stripped", () => {
  assert.equal(core.cleanText("Shop\u202Eevil\u200B\u2066x\uFEFF\u0085y"), "Shop evil x y");
});
