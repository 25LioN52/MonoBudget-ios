"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadCore, testConfig } = require("./helpers");

const core = loadCore();
const cfg = testConfig(core);
const iso = (ms) => new Date(ms).toISOString();
const periodsAt = (when, overrides) => core.computePeriods(Date.parse(when), testConfig(core, overrides));

test("week spanning two months starts on Monday of the previous month", () => {
  // Wed 1 Jul 2026 18:00 in Madrid (CEST, UTC+2)
  const p = periodsAt("2026-07-01T16:00:00Z");
  assert.equal(iso(p.week.start), "2026-06-28T22:00:00.000Z"); // Mon 29 Jun 00:00 CEST
  assert.equal(iso(p.month.start), "2026-06-30T22:00:00.000Z"); // Wed 1 Jul 00:00 CEST
  assert.equal(iso(p.week.prevStart), "2026-06-21T22:00:00.000Z"); // Mon 22 Jun
  assert.equal(iso(p.week.prevEnd), "2026-06-24T16:00:00.000Z"); // Wed 24 Jun 18:00
  assert.equal(iso(p.month.prevStart), "2026-05-31T22:00:00.000Z"); // 1 Jun
  assert.equal(iso(p.month.prevEnd), "2026-06-01T16:00:00.000Z"); // 1 Jun 18:00
  assert.equal(core.liveStartFor(p), p.week.start);
  assert.equal(core.historyStartFor(p), p.month.prevStart);
});

test("weekStartsOn changes the week boundary", () => {
  const p = periodsAt("2026-07-01T16:00:00Z", { weekStartsOn: "sunday" });
  assert.equal(iso(p.week.start), "2026-06-27T22:00:00.000Z"); // Sun 28 Jun 00:00 CEST
});

test("week containing the spring DST change", () => {
  // Sun 29 Mar 2026 12:00 CEST; clocks jumped 02:00 CET → 03:00 CEST that night.
  const p = periodsAt("2026-03-29T10:00:00Z");
  assert.equal(iso(p.week.start), "2026-03-22T23:00:00.000Z"); // Mon 23 Mar 00:00 CET
  assert.equal(iso(p.week.end), "2026-03-29T22:00:00.000Z"); // Mon 30 Mar 00:00 CEST
  assert.equal(p.week.end - p.week.start, 7 * 24 * 3600 * 1000 - 3600 * 1000); // 23-hour Sunday
  assert.equal(iso(p.week.prevEnd), "2026-03-22T11:00:00.000Z"); // Sun 22 Mar 12:00 CET (same wall time)
});

test("week after the spring DST change starts at local midnight CEST", () => {
  const p = periodsAt("2026-03-30T08:00:00Z");
  assert.equal(iso(p.week.start), "2026-03-29T22:00:00.000Z");
  assert.equal(iso(p.week.prevStart), "2026-03-22T23:00:00.000Z");
});

test("autumn DST: October is 31 days + 1 hour long", () => {
  const p = periodsAt("2026-10-31T22:30:00Z"); // Sat 31 Oct 23:30 CET
  assert.equal(iso(p.month.start), "2026-09-30T22:00:00.000Z");
  assert.equal(iso(p.month.end), "2026-10-31T23:00:00.000Z");
  assert.equal(p.month.end - p.month.start, 31 * 24 * 3600 * 1000 + 3600 * 1000);
  assert.equal(iso(p.week.start), "2026-10-25T23:00:00.000Z"); // Mon 26 Oct 00:00 CET
});

test("monthly limit = weeklyLimit / 7 × days in month", () => {
  const limitAt = (when) => Math.round(periodsAt(when).month.limit) / 100;
  assert.equal(limitAt("2026-02-10T12:00:00Z"), 800); // 28 days
  assert.equal(limitAt("2028-02-10T12:00:00Z"), 828.57); // 29 days (leap year)
  assert.equal(limitAt("2026-04-10T12:00:00Z"), 857.14); // 30 days
  assert.equal(limitAt("2026-07-10T12:00:00Z"), 885.71); // 31 days
  assert.equal(periodsAt("2026-07-10T12:00:00Z").week.limit, 20000);
});

test("previous month same point is clamped to the end of a shorter month", () => {
  const p = periodsAt("2026-03-31T10:00:00Z"); // 31 Mar; February has 28 days
  assert.equal(iso(p.month.prevStart), "2026-01-31T23:00:00.000Z"); // 1 Feb 00:00 CET
  assert.equal(p.month.prevEnd, p.month.start); // whole of February
});

test("January compares with December of the previous year", () => {
  const p = periodsAt("2027-01-15T11:00:00Z");
  assert.equal(iso(p.month.prevStart), "2026-11-30T23:00:00.000Z");
  assert.equal(iso(p.month.prevEnd), "2026-12-15T11:00:00.000Z");
});

test("elapsed fraction and expected spending (pace)", () => {
  const p = periodsAt("2026-07-01T16:00:00Z");
  // Week: 2 days 18 hours of 7 days.
  assert.ok(Math.abs(p.week.elapsedFraction - (2 * 24 + 18) / (7 * 24)) < 1e-9);
  assert.ok(Math.abs(p.week.expected - 20000 * p.week.elapsedFraction) < 1e-9);
});

test("zonedToUtc and tzOffsetMs agree with Intl for another zone", () => {
  assert.equal(iso(core.zonedToUtc(2026, 7, 1, 0, 0, 0, "Europe/Kyiv")), "2026-06-30T21:00:00.000Z");
  assert.equal(core.tzOffsetMs(Date.parse("2026-01-15T12:00:00Z"), "Europe/Kyiv"), 2 * 3600 * 1000);
  assert.equal(core.daysInMonth(2026, 2), 28);
  assert.equal(core.daysInMonth(2028, 2), 29);
});

test("budget status uses warn/danger thresholds", () => {
  assert.equal(core.budgetStatus(7400, 10000, cfg), "ok");
  assert.equal(core.budgetStatus(7500, 10000, cfg), "warn");
  assert.equal(core.budgetStatus(10000, 10000, cfg), "danger");
  assert.equal(core.budgetStatus(12000, 10000, cfg), "danger");
});
