"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadCore, fixture, testConfig } = require("./helpers");

const core = loadCore();
const cfg = testConfig(core);
const NOW = Date.parse("2026-07-01T16:00:00Z"); // Wed 1 Jul 2026 18:00 Madrid

const clientInfo = fixture("client-info.json");
const ownIbans = new Set(clientInfo.accounts.map((a) => core.normalizeIban(a.iban)));
const normalize = (items) => items.map((raw) => core.normalizeTransaction(raw, ownIbans));
const black = normalize(fixture("statement-summer-eur-black.json"));
const white = normalize(fixture("statement-summer-eur-white.json"));
const all = [...black, ...white];
const byDesc = (desc) => black.find((tx) => tx.description === desc);

test("only EUR accounts are selected; accountIds narrows further", () => {
  assert.deepEqual(core.selectAccounts(clientInfo, cfg).map((a) => a.id), ["eurBlackAcc0001", "eurWhiteAcc0002"]);
  const only = testConfig(core, { accountIds: ["eurWhiteAcc0002", "uahBlackAcc0003"] });
  assert.deepEqual(core.selectAccounts(clientInfo, only).map((a) => a.id), ["eurWhiteAcc0002"]);
});

test("normalizeTransaction keeps only needed fields (no counterparty data)", () => {
  const raw = fixture("statement-summer-eur-black.json").find((tx) => tx.description === "Bizum a Ana");
  const tx = core.normalizeTransaction(raw, ownIbans);
  assert.deepEqual(Object.keys(tx).sort(), ["amount", "description", "hold", "id", "mcc", "originalMcc", "own", "time"]);
  assert.equal(tx.own, false);
  assert.equal(core.normalizeTransaction({ id: 1 }, ownIbans), null);
});

test("classification: expenses, refunds, income and exclusions", () => {
  const kind = (desc) => core.classifyTransaction(byDesc(desc), cfg);
  assert.deepEqual(kind("Repsol"), { kind: "expense", category: "fuel" });
  assert.equal(kind("Mercadona").kind, "refund"); // +5.50 from a grocery store
  assert.deepEqual(kind("Переказ на картку"), { kind: "excluded", reason: "own", category: "transfers" }); // own IBAN
  assert.equal(kind("Обмін валюти").reason, "own"); // description pattern, no IBAN
  assert.deepEqual(kind("Salary ACME SL"), { kind: "income", reason: "income", category: "transfers" });
  assert.deepEqual(kind("Bizum a Ana"), { kind: "expense", category: "transfers" }); // money sent to someone else
  assert.equal(kind("Tabacos 123").reason, "description");
  assert.equal(kind("Loteria Nacional").reason, "mcc");
  assert.equal(kind("ATM Santander").category, "cash");
});

test("own transfers are counted when excludeOwnTransfers is false", () => {
  const relaxed = testConfig(core, { excludeOwnTransfers: false });
  assert.equal(core.classifyTransaction(byDesc("Переказ на картку"), relaxed).kind, "expense");
});

test("refunds are ignored when refundsReduceSpending is false", () => {
  const noRefunds = testConfig(core, { refundsReduceSpending: false });
  assert.equal(core.classifyTransaction(byDesc("Mercadona"), noRefunds).kind, "income");
});

test("category overrides win over MCC; custom names create categories", () => {
  assert.equal(core.categoryFor({ description: "MERCADONA S.A.", mcc: 5999 }, cfg), "groceries");
  assert.equal(core.categoryFor(byDesc("Starbucks Gran Via"), cfg), "custom:Кава");
  assert.equal(core.categoryLabel("custom:Кава", "uk"), "Кава");
  assert.equal(core.resolveCategoryName("Продукти"), "groceries");
  assert.equal(core.resolveCategoryName("restaurants & cafés"), "restaurants");
  assert.equal(core.resolveCategoryName("transport"), "transport");
});

test("MCC table: exact codes, ranges and fallbacks", () => {
  const cases = { 5411: "groceries", 5812: "restaurants", 4121: "transport", 5541: "fuel", 5651: "shopping",
    5912: "health", 4899: "subscriptions", 5968: "subscriptions", 7832: "entertainment", 3001: "travel",
    7011: "travel", 4900: "bills", 6011: "cash", 4829: "transfers", 5983: "fuel", 5921: "groceries" };
  for (const [mcc, category] of Object.entries(cases)) assert.equal(core.categoryForMcc(Number(mcc)), category, `MCC ${mcc}`);
  assert.equal(core.categoryForMcc(0), null);
  assert.equal(core.categoryFor({ description: "x", mcc: 1, originalMcc: 5411 }, cfg), "groceries");
  assert.equal(core.categoryFor({ description: "x", mcc: 1 }, cfg), "other");
  for (const key of core.CATEGORY_KEYS) {
    assert.ok(core.STRINGS && core.categoryLabel(key, "uk") !== key, `uk label for ${key}`);
    assert.ok(core.categoryLabel(key, "en") !== key, `en label for ${key}`);
  }
});

test("week summary across two months with both EUR accounts", () => {
  const p = core.computePeriods(NOW, cfg);
  const s = core.summarize(all, p.week.start, NOW, cfg);
  // 45.50 + 12.20 + 18.00 + 9.00 + 60.00 + 13.99 + 20.00 + 8.50 + 4.80 + 50.00 + 25.99 - 5.50 refund
  assert.equal(s.expenses, 26798);
  assert.equal(s.refunds, 550);
  assert.equal(s.spent, 26248);
  assert.equal(s.count, 12);
  const groceries = s.categories.find((c) => c.category === "groceries");
  assert.deepEqual({ amount: groceries.amount, count: groceries.count }, { amount: 5220, count: 3 });
  assert.equal(s.categories[0].category, "fuel"); // sorted by amount
  const total = s.categories.reduce((sum, c) => sum + c.amount, 0);
  assert.equal(total, s.spent);
});

test("month summary only counts July (pending holds included)", () => {
  const p = core.computePeriods(NOW, cfg);
  const s = core.summarize(all, p.month.start, NOW, cfg);
  assert.equal(s.spent, 16079);
  assert.ok(s.categories.some((c) => c.category === "transport" && c.amount === 900)); // the pending Uber
});

test("previous periods stop at the same point in time", () => {
  const p = core.computePeriods(NOW, cfg);
  assert.equal(core.summarize(all, p.week.prevStart, p.week.prevEnd, cfg).spent, 3000);
  assert.equal(core.summarize(all, p.month.prevStart, p.month.prevEnd, cfg).spent, 2000);
});

test("DST fixture: transactions land in the right weeks", () => {
  const dst = normalize(fixture("statement-dst.json"));
  const spring = core.computePeriods(Date.parse("2026-03-29T10:00:00Z"), cfg);
  assert.equal(core.summarize(dst, spring.week.start, Date.parse("2026-03-29T10:00:00Z"), cfg).spent, 2000 + 1500 + 1200);
  assert.equal(core.summarize(dst, spring.week.prevStart, spring.week.start - 1, cfg).spent, 1000);
  const autumnNow = Date.parse("2026-10-25T20:00:00Z"); // Sun 25 Oct 21:00 CET
  const autumn = core.computePeriods(autumnNow, cfg);
  assert.equal(core.summarize(dst, autumn.week.start, autumnNow, cfg).spent, 800 + 900);
  const nextWeekNow = Date.parse("2026-10-26T08:00:00Z");
  const next = core.computePeriods(nextWeekNow, cfg);
  assert.equal(core.summarize(dst, next.week.start, nextWeekNow, cfg).spent, 3000);
});

test("transaction list: excluded hidden by default, category filter, day groups", () => {
  const p = core.computePeriods(NOW, cfg);
  const counted = core.listTransactions(all, p.week.start, NOW, cfg);
  assert.equal(counted.length, 12);
  assert.ok(counted.every((i) => i.kind === "expense" || i.kind === "refund"));
  assert.ok(counted[0].tx.time >= counted[counted.length - 1].tx.time);
  const withExcluded = core.listTransactions(all, p.week.start, NOW, cfg, { includeExcluded: true });
  assert.equal(withExcluded.length, 17);
  const groceries = core.listTransactions(all, p.week.start, NOW, cfg, { category: "groceries" });
  assert.equal(groceries.length, 3);
  const days = core.groupByDay(counted, cfg.timezone);
  assert.deepEqual(days.map((d) => d.key), ["2026-07-01", "2026-06-30", "2026-06-29"]);
});
