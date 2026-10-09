"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadCore, fixture, testConfig, createFakeMono, createClock, syncAll } = require("./helpers");

const core = loadCore();
const cfg = testConfig(core);
const SUMMER_NOW = "2026-07-01T16:00:00Z";

function summerMono(clock, overrides) {
  return createFakeMono(core, {
    clock,
    clientInfo: fixture("client-info.json"),
    statements: {
      eurBlackAcc0001: fixture("statement-summer-eur-black.json"),
      eurWhiteAcc0002: fixture("statement-summer-eur-white.json"),
      uahBlackAcc0003: fixture("statement-summer-uah.json"),
      ...overrides,
    },
  });
}

test("full sync from an empty cache respects the rate limit and skips non-EUR accounts", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);

  assert.deepEqual(
    mono.calls.map((c) => c.path.split("/").slice(0, 4).join("/")),
    [
      "/personal/client-info",
      "/personal/statement/eurBlackAcc0001", // live window first
      "/personal/statement/eurWhiteAcc0002",
      "/personal/statement/eurBlackAcc0001", // then history for "vs previous period"
      "/personal/statement/eurWhiteAcc0002",
    ],
  );
  for (let i = 1; i < mono.calls.length; i++) {
    assert.ok(mono.calls[i].at - mono.calls[i - 1].at >= 60 * 1000, "requests at least 60 s apart");
  }
  assert.ok(!mono.calls.some((c) => c.path.includes("uah") || c.path.includes("usd")));
  assert.equal(state.lastError, null);

  const week = core.buildReport(state, "week", clock.now(), cfg);
  assert.equal(week.ready, true);
  assert.equal(week.spent, 26248);
  assert.equal(week.remaining, 20000 - 26248);
  assert.equal(week.status, "danger");
  assert.equal(week.previousSpent, 3000);
  const groceries = week.categories.find((c) => c.category === "groceries");
  assert.equal(groceries.delta, 5220 - 3000);

  const month = core.buildReport(state, "month", clock.now(), cfg);
  assert.equal(month.spent, 16079);
  assert.equal(month.previousSpent, 2000);
  assert.equal(Math.round(month.limit), 88571);
});

test("cache is fresh for cacheMinutes, then only the live window is refreshed", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  const callsAfterSync = mono.calls.length;

  clock.advance(5 * 60 * 1000);
  assert.equal(core.planNextRequest(state, clock.now(), cfg).type, "none");

  clock.advance(15 * 60 * 1000);
  const plan = core.planNextRequest(state, clock.now(), cfg);
  assert.equal(plan.type, "statement");
  assert.equal(plan.mode, "live");
  assert.equal(plan.from, core.liveStartFor(core.computePeriods(clock.now(), cfg)));
  await syncAll(core, state, cfg, mono, clock);
  assert.equal(mono.calls.length, callsAfterSync + 2); // one live request per EUR account
});

test("never two requests within 60 s, even across runs", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await core.syncStep(state, cfg, mono.http, clock.now);
  clock.advance(30 * 1000);
  const plan = await core.syncStep(state, cfg, mono.http, clock.now);
  assert.equal(plan.type, "wait");
  assert.equal(plan.until, state.lastRequestAt + core.RATE_LIMIT_MS);
  assert.equal(mono.calls.length, 1);
});

test("refresh replaces the live window: cancelled holds disappear, settled amounts update", async () => {
  const clock = createClock(SUMMER_NOW);
  const black = fixture("statement-summer-eur-black.json");
  const mono = summerMono(clock, { eurBlackAcc0001: black });
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  const before = core.buildReport(state, "week", clock.now(), cfg).spent;

  // Uber hold cancelled; Repsol settled at a different amount.
  const uberIndex = black.findIndex((tx) => tx.description === "Uber" && tx.hold);
  black.splice(uberIndex, 1);
  black.find((tx) => tx.description === "Repsol").amount = -5500;

  clock.advance(16 * 60 * 1000);
  await syncAll(core, state, cfg, mono, clock);
  const after = core.buildReport(state, "week", clock.now(), cfg).spent;
  assert.equal(after, before - 900 - 500);
});

test("429 and network errors keep the cache and record the error", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  const snapshot = JSON.stringify(state.accounts);

  clock.advance(20 * 60 * 1000);
  await core.syncStep(state, cfg, async () => ({ ok: false, status: 429 }), clock.now);
  assert.equal(state.lastError.kind, "rateLimit");
  assert.equal(JSON.stringify(state.accounts), snapshot);
  assert.equal(core.planNextRequest(state, clock.now(), cfg).type, "wait");

  clock.advance(61 * 1000);
  await core.syncStep(state, cfg, async () => {
    throw new Error("offline");
  }, clock.now);
  assert.equal(state.lastError.kind, "network");
  assert.equal(JSON.stringify(state.accounts), snapshot);

  clock.advance(61 * 1000);
  await core.syncStep(state, cfg, async () => ({ ok: false, status: 401 }), clock.now);
  assert.equal(state.lastError.kind, "auth");
  assert.equal(core.buildReport(state, "week", clock.now(), cfg).spent, 26248);
});

test("pages backwards when a statement returns 500 items", async () => {
  const clock = createClock(SUMMER_NOW);
  const now = Math.floor(clock.now() / 1000);
  const many = Array.from({ length: 1200 }, (_, i) => ({
    id: `bulk${i}`, time: now - 60 - i * 120, description: "Shop", mcc: 5411, originalMcc: 5411,
    hold: false, amount: -100, operationAmount: -100, currencyCode: 978, commissionRate: 0, cashbackAmount: 0, balance: 0,
  }));
  const mono = summerMono(clock, { eurBlackAcc0001: many, eurWhiteAcc0002: [] });
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  assert.equal(state.accounts.eurBlackAcc0001.transactions.length, 1200);
  const blackCalls = mono.calls.filter((c) => c.path.includes("eurBlackAcc0001"));
  assert.ok(blackCalls.length >= 3, "at least three pages");
  assert.equal(core.buildReport(state, "week", clock.now(), cfg).count, 1200);
});

test("long ranges are split into ≤ 31-day requests (October + DST)", async () => {
  const clock = createClock("2026-10-31T22:30:00Z"); // Sat 31 Oct 23:30 CET
  const mono = summerMono(clock, { eurBlackAcc0001: [], eurWhiteAcc0002: [] });
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  for (const call of mono.calls.filter((c) => c.path.includes("statement"))) {
    const [from, to] = call.path.split("/").slice(-2).map(Number);
    assert.ok(to - from <= 31 * 24 * 3600, `range ${to - from}s within 31 days`);
  }
  assert.equal(core.buildReport(state, "month", clock.now(), cfg).ready, true);
  assert.equal(core.hasCoverageFrom(state, cfg, core.computePeriods(clock.now(), cfg).month.prevStart), true);
});

test("a new week after a long pause re-fetches the gap", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  clock.advance(9 * 24 * 3600 * 1000); // next week, next refresh
  await syncAll(core, state, cfg, mono, clock);
  const p = core.computePeriods(clock.now(), cfg);
  assert.equal(core.hasCoverageFrom(state, cfg, core.historyStartFor(p)), true);
  // Previous week (Mon 29 Jun → Fri 3 Jul 18:00) is the whole fixture week, fetched as history.
  assert.equal(core.buildReport(state, "week", clock.now(), cfg).previousSpent, 26248);
});

test("forced refresh re-fetches even when the cache is fresh", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  clock.advance(2 * 60 * 1000);
  state.forceRefreshAt = clock.now();
  const plan = core.planNextRequest(state, clock.now(), cfg);
  assert.equal(plan.type, "statement");
  assert.equal(plan.mode, "live");
});

test("client-info is refreshed daily and accounts no longer selected are dropped", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  assert.ok(state.accounts.eurWhiteAcc0002);
  const narrowed = testConfig(core, { accountIds: ["eurBlackAcc0001"] });
  clock.advance(25 * 3600 * 1000);
  await syncAll(core, state, narrowed, mono, clock);
  assert.ok(mono.calls.filter((c) => c.path === "/personal/client-info").length >= 2);
  assert.equal(state.accounts.eurWhiteAcc0002, undefined);
});

test("cache never stores the token, balances or counterparty IBANs", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  const json = JSON.stringify(state);
  assert.ok(!json.includes("ES00"), "no counterparty IBAN");
  assert.ok(!json.includes("counterName") && !json.includes("counterIban"), "no counterparty fields");
  assert.ok(!json.includes("balance"), "no balances");
  assert.ok(!json.includes("Тестовий Користувач"), "no client name");
  assert.ok(!/token/i.test(json), "no token field");
});

/** Same semantics as createStore() in MonoBudget.js, backed by a string. */
function memoryStore(initial) {
  let json = JSON.stringify(initial || core.emptyState());
  const read = () => {
    try {
      return core.migrateState(JSON.parse(json));
    } catch (e) {
      return null;
    }
  };
  const load = () => read() || { ...core.emptyState(), unreadable: true };
  return {
    load,
    save: (state) => {
      if (state.unreadable) return false;
      const current = read();
      if (current && current.generation !== state.generation) return false;
      json = JSON.stringify(state);
      return true;
    },
    clear: () => {
      const old = load();
      json = JSON.stringify({ ...core.emptyState(Date.now()), lastRequestAt: old.lastRequestAt || 0 });
    },
    corrupt: () => {
      json = '{"version":1,"accou';
    },
    raw: () => json,
  };
}

test("an unreadable cache is never overwritten and triggers no request", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const store = memoryStore();
  store.corrupt();
  const { step } = await core.syncWithStore(store, cfg, mono.http, clock.now);
  assert.equal(step.unreadable, true);
  assert.equal(mono.calls.length, 0);
  assert.equal(store.raw(), '{"version":1,"accou');
});

test("after a reset the next request still respects the rate limit", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const store = memoryStore();
  await core.syncWithStore(store, cfg, mono.http, clock.now);
  store.clear();
  clock.advance(10 * 1000);
  const { step } = await core.syncWithStore(store, cfg, mono.http, clock.now);
  assert.equal(step.type, "wait");
  assert.equal(mono.calls.length, 1);
});

test("app and widget running at once never call Monobank within 60 s", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const store = memoryStore();
  let release;
  const slow = (p) => new Promise((resolve) => { release = () => resolve(mono.http(p)); });
  const app = core.syncWithStore(store, cfg, slow, clock.now); // claims the slot, waits for the network
  clock.advance(5 * 1000);
  const widget = await core.syncWithStore(store, cfg, mono.http, clock.now); // another process
  assert.equal(widget.step.type, "wait");
  release();
  const done = await app;
  assert.equal(done.step.type, "clientInfo");
  assert.equal(mono.calls.length, 1);
  assert.ok(store.load().clientInfo, "result saved");
});

test("a response that arrives after the cache was deleted is discarded", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const store = memoryStore();
  let release;
  const slow = (p) => new Promise((resolve) => { release = () => resolve(mono.http(p)); });
  const inFlight = core.syncWithStore(store, cfg, slow, clock.now);
  store.clear(); // user tapped "Delete token and cache"
  release();
  const { step } = await inFlight;
  assert.equal(step.discarded, true);
  assert.equal(store.load().clientInfo, null);
});

test("unexpected response shapes keep the cache (no silent data loss)", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  const snapshot = JSON.stringify(state.accounts);

  clock.advance(20 * 60 * 1000);
  await core.syncStep(state, cfg, async () => ({ ok: true, status: 200, data: [{ id: 1, broken: true }] }), clock.now);
  assert.equal(state.lastError.kind, "parse");
  assert.equal(JSON.stringify(state.accounts), snapshot);

  clock.advance(25 * 3600 * 1000);
  state.clientInfo.fetchedAt = 0; // force a client-info refresh
  for (const entry of Object.values(state.accounts)) entry.syncedAt = clock.now();
  await core.syncStep(state, cfg, async () => ({ ok: true, status: 200, data: { accounts: [] } }), clock.now);
  assert.equal(state.lastError.kind, "parse");
  assert.equal(core.selectAccounts(state.clientInfo, cfg).length, 2, "accounts kept");
});

test("timestamps from a wrong (future) clock do not block syncing", async () => {
  const clock = createClock(SUMMER_NOW);
  const mono = summerMono(clock);
  const state = core.emptyState();
  await syncAll(core, state, cfg, mono, clock);
  const future = clock.now() + 30 * 24 * 3600 * 1000;
  state.lastRequestAt = future;
  for (const entry of Object.values(state.accounts)) entry.syncedAt = future;
  state.clientInfo.fetchedAt = future;
  const plan = core.planNextRequest(state, clock.now(), cfg);
  assert.equal(plan.type, "statement");
  assert.equal(plan.mode, "live");
});
