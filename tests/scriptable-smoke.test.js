"use strict";
// Runs the Scriptable part of MonoBudget.js (widgets + in-app table) against
// strict API fakes, so runtime errors are caught without an iPhone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadCore, fixture, testConfig, createFakeMono, createClock, syncAll, ROOT } = require("./helpers");
const { createEnvironment } = require("./scriptable-mock");

const core = loadCore();
const SOURCE = fs.readFileSync(path.join(ROOT, "MonoBudget.js"), "utf8");
const TOKEN = "testToken_" + "x".repeat(34); // fake, shape-valid token
const CACHE_FILE = "/lib/MonoBudget/cache.json";

async function runScript(env) {
  const context = vm.createContext({ ...env.globals });
  const fn = new vm.Script(`(async function (module) {\n${SOURCE}\n})`, { filename: "MonoBudget.js" }).runInContext(context);
  await fn({ exports: {} });
}

/** Transactions around the real current time, in Monobank format. */
function recentStatement() {
  const now = Math.floor(Date.now() / 1000);
  const items = [
    [3600, "Mercadona", 5411, -4550],
    [2 * 86400, "Bar Pepe", 5812, -1800],
    [3 * 86400, "Mercadona", 5411, 550],
    [10 * 86400, "Repsol", 5541, -6000],
    [40 * 86400, "Zara", 5651, -4000],
  ];
  return items.map(([ago, description, mcc, amount], i) => ({
    id: `smoke${i}`, time: now - ago, description, mcc, originalMcc: mcc, hold: i === 0, amount,
    operationAmount: amount, currencyCode: 978, commissionRate: 0, cashbackAmount: 0, balance: 0,
  }));
}

function monoResponses(statement, status) {
  const clientInfo = fixture("client-info.json");
  return {
    "/personal/client-info": () => (status ? [status, "{}"] : [200, JSON.stringify(clientInfo)]),
    "/personal/statement/": (p) => {
      if (status) return [status, "{}"];
      const [account, from, to] = p.split("/").slice(-3);
      const items = account === "eurBlackAcc0001" ? statement.filter((tx) => tx.time >= Number(from) && tx.time <= Number(to)) : [];
      return [200, JSON.stringify(items)];
    },
  };
}

/** A fully synced cache, last refreshed 5 minutes ago (so widgets don't fetch). */
async function syncedCache(statement) {
  const clock = createClock(new Date(Date.now() - 5 * 60 * 1000).toISOString());
  const mono = createFakeMono(core, {
    clock,
    clientInfo: fixture("client-info.json"),
    statements: { eurBlackAcc0001: statement, eurWhiteAcc0002: [] },
  });
  const state = core.emptyState();
  const cfg = { ...core.CONFIG };
  await syncAll(core, state, cfg, mono, clock);
  state.lastRequestAt = Date.now() - 5 * 60 * 1000;
  for (const entry of Object.values(state.accounts)) entry.syncedAt = Date.now() - 5 * 60 * 1000;
  return JSON.stringify(state);
}

const FAMILIES = [
  ["small", null], ["small", "month"], ["medium", null], ["medium", "week"], ["large", "both"],
  ["accessoryRectangular", null], ["accessoryCircular", null], ["accessoryCircular", "month"],
  ["accessoryInline", null], ["accessoryInline", "both"],
];

for (const [family, parameter] of FAMILIES) {
  test(`widget renders: ${family}${parameter ? ` (${parameter})` : ""}`, async () => {
    const statement = recentStatement();
    const env = createEnvironment({ widgetFamily: family, widgetParameter: parameter, token: TOKEN, responses: monoResponses(statement) });
    env.files.set(CACHE_FILE, await syncedCache(statement));
    await runScript(env);
    assert.ok(env.widget, "Script.setWidget called");
    assert.equal(Object.prototype.toString.call(env.widget.refreshAfterDate), "[object Date]"); // cross-realm Date
    assert.ok(env.widget.url.startsWith("scriptable:///run?scriptName=Mono%20Budget&period="));
    assert.equal(env.requests.length, 0, "fresh cache: no requests");
    assert.ok(env.completed);
  });
}

test("widget without a token asks to open the app and makes no requests", async () => {
  const env = createEnvironment({ widgetFamily: "medium", responses: monoResponses([]) });
  await runScript(env);
  assert.ok(env.widget);
  assert.equal(env.requests.length, 0);
});

test("widget with an empty cache makes exactly one request, to Monobank, with the token header", async () => {
  const env = createEnvironment({ widgetFamily: "medium", token: TOKEN, responses: monoResponses(recentStatement()) });
  await runScript(env);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].url, "https://api.monobank.ua/personal/client-info");
  assert.equal(env.requests[0].headers["X-Token"], TOKEN);
  assert.equal(typeof env.requests[0].onRedirect, "function", "redirects are intercepted");
  assert.equal(env.requests[0].onRedirect({ url: "https://evil.example/" }), null, "redirects are never followed");
  const cached = env.files.get(CACHE_FILE);
  assert.ok(cached, "cache written to the private Library folder");
  assert.ok(!cached.includes(TOKEN), "token is never written to the cache");
});

test("widget shows cached data when Monobank rejects the token", async () => {
  const statement = recentStatement();
  const env = createEnvironment({ widgetFamily: "medium", token: TOKEN, responses: monoResponses(statement, 401) });
  const cache = JSON.parse(await syncedCache(statement));
  cache.lastRequestAt = 0;
  for (const entry of Object.values(cache.accounts)) entry.syncedAt = Date.now() - 60 * 60 * 1000;
  env.files.set(CACHE_FILE, JSON.stringify(cache));
  await runScript(env);
  assert.equal(env.requests.length, 1);
  assert.equal(JSON.parse(env.files.get(CACHE_FILE)).lastError.kind, "auth");
  assert.ok(env.widget);
});

test("in-app report renders and every control works", async () => {
  const statement = recentStatement();
  const env = createEnvironment({ token: TOKEN, queryParameters: { period: "month" }, responses: monoResponses(statement) });
  env.files.set(CACHE_FILE, await syncedCache(statement));
  await runScript(env);
  const table = env.tables[0];
  const titles = () => table.rows.flatMap((r) => r.cells.map((c) => c.title || ""));
  assert.ok(titles().some((t) => t.includes("Місяць")));

  const tap = (label) => {
    const cell = table.rows.flatMap((r) => r.cells).find((c) => (c.title || "").includes(label));
    assert.ok(cell, `control "${label}" exists`);
    cell.onTap();
  };
  const select = async (label) => {
    const row = table.rows.find((r) => r.cells.some((c) => (c.title || "").includes(label)));
    assert.ok(row && row.onSelect, `row "${label}" is selectable`);
    await row.onSelect();
  };

  tap("Тиждень");
  tap("Операції");
  await select("Показувати виключені");
  tap("Категорії");
  await select("Продукти"); // open a category
  assert.ok(titles().some((t) => t.includes("Усі категорії")));
  await select("Усі категорії");
  await select("Переглянути віджет");
  await select("Оновити дані");
});

test("first run in the app asks for the token with a secure field and stores it in Keychain", async () => {
  const env = createEnvironment({ responses: monoResponses([]) });
  env.globals.Alert.prototype.textFieldValue = () => ` ${TOKEN} `;
  await runScript(env);
  assert.equal(env.alerts[0].fields.length, 1);
  assert.equal(env.keychain.get("monobudget.monobank-token"), TOKEN);
});

test("app recovers from a cache that is unreadable at start", async () => {
  const env = createEnvironment({ token: TOKEN, responses: monoResponses([]) });
  env.files.set(CACHE_FILE, '{"version":1,"acc');
  await runScript(env);
  assert.ok(env.completed);
  const cache = JSON.parse(env.files.get(CACHE_FILE));
  assert.ok(cache.generation > 0, "cache was reset with a new generation");
});

test("app does not spin when the cache becomes unreadable mid-session", { timeout: 15000 }, async () => {
  const env = createEnvironment({ token: TOKEN, responses: monoResponses([]), dismissAfterMs: 60 });
  const corrupt = setTimeout(() => env.files.set(CACHE_FILE, '{"version":1,"acc'), 15);
  await runScript(env); // would never finish if the sync loop spun on microtasks
  clearTimeout(corrupt);
  assert.ok(env.completed);
  assert.equal(env.requests.length, 1, "no requests while the cache is unreadable");
});

test("invalid config is reported instead of crashing", async () => {
  const env = createEnvironment({ widgetFamily: "small", token: TOKEN, responses: monoResponses([]) });
  const broken = SOURCE.replace("weeklyLimit: 200,", "weeklyLimit: -5,");
  const context = vm.createContext({ ...env.globals });
  await new vm.Script(`(async function (module) {\n${broken}\n})`).runInContext(context)({ exports: {} });
  assert.ok(env.widget);
  assert.equal(env.requests.length, 0);
});

test("testConfig sanity", () => {
  assert.deepEqual(core.validateConfig(testConfig(core)), []);
});
