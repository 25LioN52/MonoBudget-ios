"use strict";
// Test helpers: load the core of MonoBudget.js outside Scriptable and fake the Monobank API.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

/**
 * Scriptable wraps scripts in an async function (top-level await is allowed),
 * so we do the same. Outside Scriptable the script only exports its core.
 */
function loadCore() {
  const file = path.join(ROOT, "MonoBudget.js");
  const source = fs.readFileSync(file, "utf8");
  const wrapper = new vm.Script(`(async function (module) {\n${source}\n})`, { filename: file, lineOffset: -1 });
  const mod = { exports: {} };
  wrapper.runInThisContext()(mod).catch((error) => {
    throw error;
  });
  if (Object.keys(mod.exports).length === 0) throw new Error("MonoBudget.js did not export its core");
  return mod.exports;
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

/** Config used by tests: defaults plus exclusions/overrides exercised by fixtures. */
function testConfig(core, overrides) {
  return {
    ...core.CONFIG,
    weeklyLimit: 200,
    weekStartsOn: "monday",
    timezone: "Europe/Madrid",
    language: "uk",
    accountIds: [],
    excludedMcc: [7995],
    excludedDescriptions: ["tabacos"],
    categoryOverrides: { mercadona: "Groceries", starbucks: "Кава" },
    cacheMinutes: 15,
    ...overrides,
  };
}

/**
 * Fake Monobank API with the real constraints: 1 request per 60 s,
 * statement range ≤ 31 days + 1 hour, ≤ 500 items newest first.
 */
function createFakeMono(core, { clientInfo, statements, clock }) {
  const calls = [];
  async function http(requestPath) {
    const now = clock.now();
    const previous = calls[calls.length - 1];
    calls.push({ path: requestPath, at: now });
    if (previous && now - previous.at < 60 * 1000) return { ok: false, status: 429 };
    if (requestPath === "/personal/client-info") return { ok: true, status: 200, data: clientInfo };
    const match = /^\/personal\/statement\/([^/]+)\/(\d+)\/(\d+)$/.exec(requestPath);
    if (!match) return { ok: false, status: 404 };
    const [, account, from, to] = match;
    if (Number(to) - Number(from) > 31 * 24 * 3600 + 3600) return { ok: false, status: 400 };
    const items = (statements[decodeURIComponent(account)] || [])
      .filter((tx) => tx.time >= Number(from) && tx.time <= Number(to))
      .sort((a, b) => b.time - a.time)
      .slice(0, core.PAGE_SIZE);
    return { ok: true, status: 200, data: JSON.parse(JSON.stringify(items)) };
  }
  return { http, calls };
}

function createClock(iso) {
  let now = Date.parse(iso);
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

/** Run sync steps until nothing is left, waiting out the rate limit on a fake clock. */
async function syncAll(core, state, cfg, mono, clock, maxSteps = 50) {
  for (let i = 0; i < maxSteps; i++) {
    const plan = core.planNextRequest(state, clock.now(), cfg);
    if (plan.type === "none") return i;
    if (plan.type === "wait") {
      clock.advance(plan.until - clock.now());
      continue;
    }
    await core.syncStep(state, cfg, mono.http, clock.now);
  }
  throw new Error("sync did not finish");
}

module.exports = { loadCore, fixture, testConfig, createFakeMono, createClock, syncAll, ROOT };
