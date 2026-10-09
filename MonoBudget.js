// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: wallet;

/*
 * MonoBudget — weekly & monthly spending budget from Monobank as iOS widgets.
 * https://github.com/25LioN52/MonoBudget-ios  ·  MIT License
 *
 * Paste this whole file into a new Scriptable script. Edit only the CONFIG block.
 *
 * Security notes:
 *  - The Monobank token lives only in the iOS Keychain (Scriptable). It is never
 *    hardcoded, logged, cached to disk or sent anywhere except api.monobank.ua.
 *  - The cache is stored locally in Scriptable's private Library folder
 *    (not iCloud, not visible in the Files app).
 *  - The script makes no network requests other than to api.monobank.ua.
 */

// ============================================================================
// CONFIG — change only this block
// ============================================================================
const CONFIG = {
  // Weekly budget in euros. Monthly limit = weeklyLimit / 7 × days in month.
  weeklyLimit: 200,
  // First day of the week: "monday" … "sunday".
  weekStartsOn: "monday",
  // Time zone used for week/month boundaries (IANA name).
  timezone: "Europe/Madrid",
  // Interface language: "uk", "en" or "auto" (from device settings).
  language: "uk",

  // Monobank account ids to count. Empty = all EUR accounts.
  accountIds: [],

  // Ignore transfers between your own accounts (matched by IBAN from
  // client-info; when Monobank gives no IBAN, by description patterns below).
  excludeOwnTransfers: true,
  ownTransferPatterns: [
    "обмін валют", "конвертація", "купівля валюти", "продаж валюти",
    "між власними рахунками", "між своїми рахунками",
    "з гривневого рахунку", "на гривневий рахунок",
    "поповнення банки", "на банку", "з банки",
    "currency exchange", "between own accounts",
  ],

  // Never count these MCC codes / descriptions (case-insensitive substring).
  excludedMcc: [],
  excludedDescriptions: [],

  // Refunds from merchants reduce spending (income and transfers never do).
  refundsReduceSpending: true,

  // Description substring → category. Wins over the MCC table.
  // Use a built-in category ("Groceries", "Продукти", "groceries"…) or any
  // custom name to create your own category.
  categoryOverrides: {
    mercadona: "Groceries",
  },

  // Progress colors: amber from warnPct %, red from dangerPct % of the limit.
  warnPct: 75,
  dangerPct: 100,
  // Show a tick on progress bars where spending "should" be today.
  showPaceMarker: true,

  // Minutes before cached data is refreshed from Monobank.
  cacheMinutes: 15,

  // Lock screen widgets (and any widget in StandBy) are visible without
  // unlocking the phone. false = lock screen widgets show only percentages.
  lockScreenShowAmounts: true,
};

// ============================================================================
// CORE — pure functions (no Scriptable APIs). Covered by tests in /tests.
// ============================================================================

const MONO_API = "https://api.monobank.ua";
const EUR = 978;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RATE_LIMIT_MS = 61 * SECOND; // Monobank: 1 request per 60 s (+1 s margin)
const MAX_RANGE_MS = 31 * DAY; // Monobank: 31 days + 1 hour; we stay at 31 days
const PAGE_SIZE = 500; // Monobank returns at most 500 items per statement call
const CLIENT_INFO_TTL_MS = 24 * HOUR;
const CACHE_VERSION = 1;

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// ---------------------------------------------------------------------------
// Time zones (Intl only, no libraries)
// ---------------------------------------------------------------------------

const formatterCache = {};

function getFormatter(timeZone) {
  if (!formatterCache[timeZone]) {
    formatterCache[timeZone] = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  }
  return formatterCache[timeZone];
}

/** Wall-clock parts of an instant in a time zone. weekday: 0 = Sunday. */
function zonedParts(ms, timeZone) {
  const parts = {};
  for (const part of getFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute: parts.minute,
    second: parts.second,
    weekday: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
  };
}

/** Offset of the time zone from UTC at the given instant, in ms. */
function tzOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant for a wall-clock time in a time zone. Out-of-range values are
 * normalised (day 0 = last day of previous month, month 13 = next January…).
 */
function zonedToUtc(year, month, day, hour, minute, second, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0);
  const guess = wall - tzOffsetMs(wall, timeZone);
  return wall - tzOffsetMs(guess, timeZone);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Budget periods
// ---------------------------------------------------------------------------

/**
 * Current week and month for `nowMs`, with limits (in cents) and the matching
 * window of the previous period ("same point last week/month").
 */
function computePeriods(nowMs, cfg) {
  const tz = cfg.timezone;
  const p = zonedParts(nowMs, tz);
  const dailyRate = (cfg.weeklyLimit * 100) / 7; // cents per day
  const firstDay = WEEKDAYS[String(cfg.weekStartsOn).toLowerCase()];
  const back = (p.weekday - (firstDay === undefined ? 1 : firstDay) + 7) % 7;

  const weekStart = zonedToUtc(p.year, p.month, p.day - back, 0, 0, 0, tz);
  const weekEnd = zonedToUtc(p.year, p.month, p.day - back + 7, 0, 0, 0, tz);
  const prevWeekStart = zonedToUtc(p.year, p.month, p.day - back - 7, 0, 0, 0, tz);
  const prevWeekEnd = zonedToUtc(p.year, p.month, p.day - 7, p.hour, p.minute, p.second, tz);

  const dim = daysInMonth(p.year, p.month);
  const prevDim = new Date(Date.UTC(p.year, p.month - 1, 0)).getUTCDate();
  const monthStart = zonedToUtc(p.year, p.month, 1, 0, 0, 0, tz);
  const monthEnd = zonedToUtc(p.year, p.month + 1, 1, 0, 0, 0, tz);
  const prevMonthStart = zonedToUtc(p.year, p.month - 1, 1, 0, 0, 0, tz);
  // Same day and time last month; if last month was shorter, its whole length.
  const prevMonthEnd =
    p.day > prevDim ? monthStart : zonedToUtc(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, tz);

  const make = (key, start, end, limit, prevStart, prevEnd, days) => {
    const elapsedFraction = Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
    return { key, start, end, now: nowMs, limit, days, prevStart, prevEnd, elapsedFraction, expected: limit * elapsedFraction };
  };

  return {
    dailyRate,
    week: make("week", weekStart, weekEnd, cfg.weeklyLimit * 100, prevWeekStart, prevWeekEnd, 7),
    month: make("month", monthStart, monthEnd, dailyRate * dim, prevMonthStart, prevMonthEnd, dim),
  };
}

/** Oldest instant whose data is needed: start of the previous week/month. */
function historyStartFor(periods) {
  return Math.min(periods.week.prevStart, periods.month.prevStart);
}

/** Start of the window that is re-fetched on every refresh (holds may change). */
function liveStartFor(periods) {
  return Math.min(periods.week.start, periods.month.start);
}

function budgetStatus(spent, limit, cfg) {
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  if (pct >= cfg.dangerPct) return "danger";
  if (pct >= cfg.warnPct) return "warn";
  return "ok";
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const CATEGORY_KEYS = [
  "groceries", "restaurants", "transport", "fuel", "shopping", "health", "subscriptions",
  "entertainment", "travel", "bills", "cash", "transfers", "other",
];

// MCC → category. Single codes win over ranges ("a-b"); ranges must not overlap.
const MCC_CATEGORIES = {
  groceries: ["5297", "5298", "5300", "5411", "5422", "5441", "5451", "5462", "5499", "5921"],
  restaurants: ["5811-5814"],
  transport: ["4011", "4111", "4112", "4121", "4131", "4457", "4468", "4784", "4789", "7511", "7523",
    "7531", "7534", "7535", "7538", "7542", "7549"],
  fuel: ["5172", "5541", "5542", "5552", "5983"],
  shopping: ["5013-5199", "5200-5296", "5299", "5309-5399", "5511-5599", "5611-5699", "5712-5735",
    "5931-5999", "7210-7299", "7631", "7641", "7692", "7699"],
  health: ["4119", "5047", "5122", "5292", "5295", "5912", "5975", "5976", "8011", "8021", "8031",
    "8041-8050", "8062", "8071", "8099"],
  subscriptions: ["4816", "4899", "5815-5818", "5968", "7372", "7375"],
  entertainment: ["7832", "7841", "7911", "7922", "7929", "7932", "7933", "7941", "7991-7999"],
  travel: ["3000-3999", "4411", "4511", "4582", "4722", "4723", "7011", "7012", "7032", "7033",
    "7512", "7513", "7519"],
  bills: ["4812", "4814", "4815", "4821", "4900", "6300", "6381", "6399", "6513", "9211", "9222",
    "9223", "9311", "9399", "9402"],
  cash: ["6010", "6011", "6051"],
  transfers: ["4829", "6012", "6536", "6537", "6538", "6540"],
};

const MCC_EXACT = new Map();
const MCC_RANGES = [];
for (const [category, codes] of Object.entries(MCC_CATEGORIES)) {
  for (const code of codes) {
    const [from, to] = code.split("-").map(Number);
    if (to === undefined) MCC_EXACT.set(from, category);
    else MCC_RANGES.push([from, to, category]);
  }
}

// Positive amounts in these categories are income/transfers, never refunds.
const NON_PURCHASE_CATEGORIES = new Set(["cash", "transfers"]);

const CATEGORY_NAMES = {
  uk: {
    groceries: "Продукти", restaurants: "Ресторани й кафе", transport: "Транспорт", fuel: "Пальне",
    shopping: "Покупки", health: "Здоров'я", subscriptions: "Підписки й цифрове", entertainment: "Розваги",
    travel: "Подорожі", bills: "Рахунки й комунальні", cash: "Готівка", transfers: "Перекази", other: "Інше",
  },
  en: {
    groceries: "Groceries", restaurants: "Restaurants & cafés", transport: "Transport", fuel: "Fuel",
    shopping: "Shopping", health: "Health", subscriptions: "Subscriptions & digital", entertainment: "Entertainment",
    travel: "Travel", bills: "Bills & utilities", cash: "Cash", transfers: "Transfers", other: "Other",
  },
};

function categoryForMcc(mcc) {
  const code = Number(mcc);
  if (!Number.isFinite(code) || code <= 0) return null;
  if (MCC_EXACT.has(code)) return MCC_EXACT.get(code);
  for (const [from, to, category] of MCC_RANGES) {
    if (code >= from && code <= to) return category;
  }
  return null;
}

/** Override value → built-in key ("groceries") or custom ("custom:Coffee"). */
function resolveCategoryName(value) {
  const name = String(value).trim();
  const lower = name.toLowerCase();
  if (CATEGORY_KEYS.includes(lower)) return lower;
  for (const names of Object.values(CATEGORY_NAMES)) {
    for (const [key, label] of Object.entries(names)) {
      if (label.toLowerCase() === lower) return key;
    }
  }
  return "custom:" + name;
}

function categoryFor(tx, cfg) {
  const desc = String(tx.description || "").toLowerCase();
  for (const [pattern, category] of Object.entries(cfg.categoryOverrides || {})) {
    if (pattern && desc.includes(pattern.toLowerCase())) return resolveCategoryName(category);
  }
  return categoryForMcc(tx.mcc) || categoryForMcc(tx.originalMcc) || "other";
}

function categoryLabel(key, lang) {
  if (key.startsWith("custom:")) return key.slice("custom:".length);
  return (CATEGORY_NAMES[lang] || CATEGORY_NAMES.en)[key] || key;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

function normalizeIban(iban) {
  return String(iban || "").replace(/\s+/g, "").toUpperCase();
}

/** Strip control, bidi-override and zero-width characters; collapse whitespace in API text. */
function cleanText(value, maxLength) {
  const text = String(value || "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return maxLength && text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

/**
 * Keep only the fields the app needs (data minimisation: balances and the
 * counterName/counterIban fields are dropped; the description is kept as the
 * bank shows it and may contain a name for transfers). `own` marks transfers
 * to/from the user's own IBANs.
 */
function normalizeTransaction(raw, ownIbans) {
  if (!raw || typeof raw.id !== "string" || !Number.isFinite(raw.time) || !Number.isInteger(raw.amount)) {
    return null;
  }
  return {
    id: raw.id,
    time: raw.time,
    description: cleanText(raw.description, 200),
    mcc: Number(raw.mcc) || 0,
    originalMcc: Number(raw.originalMcc) || 0,
    hold: raw.hold === true,
    amount: raw.amount,
    own: Boolean(raw.counterIban) && ownIbans.has(normalizeIban(raw.counterIban)),
  };
}

function matchesAny(lowerText, patterns) {
  return (patterns || []).some((p) => p && lowerText.includes(String(p).toLowerCase()));
}

/**
 * kind: "expense" | "refund" (counted), "excluded" | "income" | "ignored" (not counted).
 */
function classifyTransaction(tx, cfg) {
  const desc = String(tx.description || "").toLowerCase();
  const category = categoryFor(tx, cfg);
  if (tx.amount === 0) return { kind: "ignored", reason: "zero", category };
  if ((cfg.excludedMcc || []).map(Number).includes(Number(tx.mcc))) return { kind: "excluded", reason: "mcc", category };
  if (matchesAny(desc, cfg.excludedDescriptions)) return { kind: "excluded", reason: "description", category };
  if (cfg.excludeOwnTransfers && (tx.own || matchesAny(desc, cfg.ownTransferPatterns))) {
    return { kind: "excluded", reason: "own", category };
  }
  if (tx.amount < 0) return { kind: "expense", category };
  if (cfg.refundsReduceSpending && !NON_PURCHASE_CATEGORIES.has(category)) return { kind: "refund", category };
  return { kind: "income", reason: "income", category };
}

function inRange(tx, from, to) {
  const ms = tx.time * 1000;
  return ms >= from && ms <= to;
}

/**
 * Spending in [from, to]. Amounts are positive cents of spending:
 * spent = expenses - refunds. Categories are sorted by amount, descending.
 */
function summarize(transactions, from, to, cfg) {
  const byCategory = new Map();
  let expenses = 0;
  let refunds = 0;
  let count = 0;
  for (const tx of transactions) {
    if (!inRange(tx, from, to)) continue;
    const { kind, category } = classifyTransaction(tx, cfg);
    if (kind !== "expense" && kind !== "refund") continue;
    if (kind === "expense") expenses += -tx.amount;
    else refunds += tx.amount;
    count += 1;
    const entry = byCategory.get(category) || { category, amount: 0, count: 0 };
    entry.amount += -tx.amount;
    entry.count += 1;
    byCategory.set(category, entry);
  }
  const spent = expenses - refunds;
  const categories = [...byCategory.values()]
    .map((c) => ({ ...c, pct: spent > 0 ? (c.amount / spent) * 100 : 0 }))
    .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));
  return { spent, expenses, refunds, count, categories };
}

/** Transactions in [from, to], newest first, with their classification. */
function listTransactions(transactions, from, to, cfg, opts) {
  const options = opts || {};
  return transactions
    .filter((tx) => inRange(tx, from, to))
    .map((tx) => ({ tx, ...classifyTransaction(tx, cfg) }))
    .filter((item) => {
      const counted = item.kind === "expense" || item.kind === "refund";
      if (options.category) return counted && item.category === options.category;
      return counted || options.includeExcluded;
    })
    .sort((a, b) => b.tx.time - a.tx.time);
}

/** Group listTransactions() output by local calendar day. */
function groupByDay(items, timeZone) {
  const groups = [];
  for (const item of items) {
    const p = zonedParts(item.tx.time * 1000, timeZone);
    const key = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, time: item.tx.time * 1000, items: [item] });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Cache state & sync planning (respects Monobank's rate limit)
// ---------------------------------------------------------------------------

/** `generation` changes when the user deletes the cache, so stale writers can be detected. */
function emptyState(generation) {
  return {
    version: CACHE_VERSION, generation: generation || 0, clientInfo: null, accounts: {},
    lastRequestAt: 0, lastError: null, pending: null, forceRefreshAt: 0,
  };
}

function migrateState(state) {
  if (!state || typeof state !== "object" || state.version !== CACHE_VERSION) return emptyState();
  return { ...emptyState(), ...state };
}

function isValidAccountId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** EUR accounts to count (optionally limited to CONFIG.accountIds). */
function selectAccounts(clientInfo, cfg) {
  if (!clientInfo || !Array.isArray(clientInfo.accounts)) return [];
  const wanted = (cfg.accountIds || []).map(String);
  return clientInfo.accounts.filter(
    (a) => a.currencyCode === EUR && isValidAccountId(a.id) && (wanted.length === 0 || wanted.includes(a.id)),
  );
}

function allTransactions(state, cfg) {
  const seen = new Map();
  for (const account of selectAccounts(state.clientInfo, cfg)) {
    const entry = state.accounts[account.id];
    for (const tx of (entry && entry.transactions) || []) seen.set(tx.id, tx);
  }
  return [...seen.values()];
}

/** True when every counted account has complete data back to `from`. */
function hasCoverageFrom(state, cfg, from) {
  const accounts = selectAccounts(state.clientInfo, cfg);
  if (accounts.length === 0) return false;
  return accounts.every((a) => {
    const entry = state.accounts[a.id];
    return entry && entry.syncedAt > 0 && entry.coveredFrom !== null && entry.coveredFrom <= from;
  });
}

/** Oldest successful refresh across counted accounts (0 = never). */
function lastSyncedAt(state, cfg) {
  const accounts = selectAccounts(state.clientInfo, cfg);
  if (accounts.length === 0) return 0;
  return Math.min(...accounts.map((a) => (state.accounts[a.id] && state.accounts[a.id].syncedAt) || 0));
}

function nextNeededRequest(state, nowMs, cfg) {
  if (state.pending) return { ...state.pending, type: "statement" };
  if (!state.clientInfo) return { type: "clientInfo" };

  const periods = computePeriods(nowMs, cfg);
  const liveStart = liveStartFor(periods);
  const historyStart = historyStartFor(periods);
  const accounts = selectAccounts(state.clientInfo, cfg);
  const maxAge = Math.max(1, cfg.cacheMinutes) * MINUTE;

  // 1. Refresh the live window (current week + month) of the stalest account.
  //    A sync time in the future (clock was wrong) also counts as stale.
  const stale = accounts
    .map((a) => ({ id: a.id, entry: state.accounts[a.id] }))
    .filter(({ entry }) => !entry || !entry.syncedAt || entry.syncedAt > nowMs || nowMs - entry.syncedAt >= maxAge ||
      entry.syncedAt < (state.forceRefreshAt || 0))
    .sort((a, b) => ((a.entry && a.entry.syncedAt) || 0) - ((b.entry && b.entry.syncedAt) || 0));
  if (stale.length > 0) {
    const { id, entry } = stale[0];
    let from = liveStart;
    // Close the gap since the last refresh if it ended before the live window.
    if (entry && entry.coveredTo !== null && entry.coveredTo >= historyStart) from = Math.min(from, entry.coveredTo);
    from = Math.max(from, nowMs - MAX_RANGE_MS);
    return { type: "statement", mode: "live", accountId: id, from, to: nowMs };
  }

  // 2. Accounts list changes rarely: refresh it daily.
  const fetchedAt = state.clientInfo.fetchedAt;
  if (fetchedAt > nowMs || nowMs - fetchedAt >= CLIENT_INFO_TTL_MS) return { type: "clientInfo" };

  // 3. Back-fill history needed for "vs previous period".
  for (const account of accounts) {
    const entry = state.accounts[account.id];
    if (entry.coveredFrom > historyStart) {
      const to = entry.coveredFrom;
      return { type: "statement", mode: "history", accountId: account.id, from: Math.max(historyStart, to - MAX_RANGE_MS), to };
    }
  }
  return null;
}

/**
 * What to do next: { type: "none" } | { type: "wait", until, request } |
 * { type: "clientInfo" } | { type: "statement", mode, accountId, from, to }.
 * Never allows two requests within RATE_LIMIT_MS (persisted across runs).
 */
function planNextRequest(state, nowMs, cfg) {
  const request = nextNeededRequest(state, nowMs, cfg);
  if (!request) return { type: "none" };
  // A timestamp far in the future means the clock was wrong: don't wait for it.
  const last = state.lastRequestAt > nowMs + RATE_LIMIT_MS ? 0 : state.lastRequestAt || 0;
  const readyAt = last + RATE_LIMIT_MS;
  if (last > 0 && nowMs < readyAt) return { type: "wait", until: readyAt, request };
  return request;
}

function statementPath(request) {
  if (!isValidAccountId(request.accountId)) throw new Error("Invalid account id");
  const from = Math.floor(request.from / 1000);
  const to = Math.floor(request.to / 1000);
  return `/personal/statement/${encodeURIComponent(request.accountId)}/${from}/${to}`;
}

function errorKind(status) {
  if (status === 429) return "rateLimit";
  if (status === 401 || status === 403) return "auth";
  if (!status) return "network";
  return "http";
}

/** Update coverage interval [coveredFrom, coveredTo] with a fetched interval. */
function mergeCoverage(entry, from, to) {
  if (entry.coveredFrom === null || entry.coveredTo === null) {
    entry.coveredFrom = from;
    entry.coveredTo = to;
  } else if (to >= entry.coveredFrom && from <= entry.coveredTo) {
    entry.coveredFrom = Math.min(entry.coveredFrom, from);
    entry.coveredTo = Math.max(entry.coveredTo, to);
  } else if (from > entry.coveredTo) {
    // Disjoint and newer: restart coverage here; history back-fill closes the gap.
    entry.coveredFrom = from;
    entry.coveredTo = to;
  }
}

/**
 * Apply an API result to the state (pure, mutates `state`).
 * result: { ok: true, data } | { ok: false, status }.
 */
function applyResponse(state, request, result, startedAt, cfg) {
  // Keep a slightly newer claim made by another process (app vs widget).
  const claimed = state.lastRequestAt || 0;
  state.lastRequestAt = claimed > startedAt && claimed <= startedAt + RATE_LIMIT_MS ? claimed : startedAt;
  if (!result || !result.ok) {
    const status = (result && result.status) || 0;
    state.lastError = { at: startedAt, status, kind: (result && result.kind) || errorKind(status) };
    return state;
  }

  const parseError = () => {
    // Unexpected shape (e.g. API change): keep the cache rather than wiping it.
    state.lastError = { at: startedAt, status: 200, kind: "parse" };
    return state;
  };

  if (request.type === "clientInfo") {
    const accounts = Array.isArray(result.data && result.data.accounts) ? result.data.accounts : [];
    if (accounts.length === 0) return parseError();
    state.clientInfo = {
      fetchedAt: startedAt,
      accounts: accounts
        .filter((a) => a && isValidAccountId(a.id))
        .map((a) => ({ id: a.id, currencyCode: a.currencyCode, iban: normalizeIban(a.iban), type: String(a.type || "") })),
    };
    const keep = new Set(selectAccounts(state.clientInfo, cfg).map((a) => a.id));
    for (const id of Object.keys(state.accounts)) if (!keep.has(id)) delete state.accounts[id];
    state.lastError = null;
    return state;
  }

  if (!Array.isArray(result.data)) return parseError();

  const ownIbans = new Set(((state.clientInfo && state.clientInfo.accounts) || []).map((a) => a.iban).filter(Boolean));
  const items = result.data.map((raw) => normalizeTransaction(raw, ownIbans)).filter(Boolean);
  if (items.length < result.data.length) return parseError();
  const full = result.data.length >= PAGE_SIZE && items.length > 0;
  const oldest = items.length ? Math.min(...items.map((tx) => tx.time)) * 1000 : request.from;
  const pageFrom = full ? Math.max(request.from, oldest) : request.from;

  const entry = state.accounts[request.accountId] || { transactions: [], coveredFrom: null, coveredTo: null, syncedAt: 0 };
  // Replace everything in the fetched window: cancelled holds disappear,
  // settled holds get their final amount.
  const fresh = new Map(items.map((tx) => [tx.id, tx]));
  entry.transactions = entry.transactions
    .filter((tx) => !fresh.has(tx.id) && !inRange(tx, pageFrom, request.to))
    .concat([...fresh.values()]);
  mergeCoverage(entry, pageFrom, request.to);

  if (full && pageFrom > request.from) {
    // Page backwards. If the whole page shares one second, step past it.
    const to = pageFrom >= request.to ? pageFrom - SECOND : pageFrom;
    state.pending = { mode: request.mode, accountId: request.accountId, from: request.from, to };
  } else {
    state.pending = null;
    if (request.mode === "live") entry.syncedAt = startedAt;
  }

  // Drop data older than anything the reports need.
  const keepFrom = historyStartFor(computePeriods(startedAt, cfg)) - DAY;
  entry.transactions = entry.transactions.filter((tx) => tx.time * 1000 >= keepFrom).sort((a, b) => b.time - a.time);
  if (entry.coveredFrom !== null && entry.coveredFrom < keepFrom) entry.coveredFrom = keepFrom;

  state.accounts[request.accountId] = entry;
  state.lastError = null;
  return state;
}

/**
 * Perform at most one Monobank request if the plan allows it.
 * `http(path)` → Promise<{ ok, status, data }> is injected (Scriptable or test fake).
 */
async function callMono(http, plan) {
  const path = plan.type === "clientInfo" ? "/personal/client-info" : statementPath(plan);
  try {
    return await http(path);
  } catch (e) {
    return { ok: false, status: 0, kind: "network" };
  }
}

function stepSummary(plan, result) {
  return { ...plan, result: { ok: Boolean(result && result.ok), status: result && result.status } };
}

/** In-memory variant of syncWithStore (used by tests). Mutates `state`. */
async function syncStep(state, cfg, http, nowFn) {
  const now = nowFn();
  const plan = planNextRequest(state, now, cfg);
  if (plan.type === "none" || plan.type === "wait") return plan;
  const result = await callMono(http, plan);
  applyResponse(state, plan, result, now, cfg);
  return stepSummary(plan, result);
}

/**
 * One sync step that is safe when the app and several widgets run at the same
 * time in separate processes sharing one cache file:
 *  1. reload the cache and plan;
 *  2. claim the rate-limit slot on disk *before* calling Monobank;
 *  3. reload again after the response, apply it and save;
 *  4. discard the response if the cache was deleted in the meantime.
 * store: { load() → state, save(state) }. Returns { state, step }.
 */
async function syncWithStore(store, cfg, http, nowFn) {
  let state = store.load();
  // Unreadable (e.g. mid-write by another process): skip this run, write nothing.
  if (state.unreadable) return { state, step: { type: "none", unreadable: true } };
  const now = nowFn();
  const plan = planNextRequest(state, now, cfg);
  if (plan.type === "none" || plan.type === "wait") return { state, step: plan };
  const generation = state.generation;
  state.lastRequestAt = now;
  if (store.save(state) === false) return { state: store.load(), step: { ...plan, discarded: true } };

  const result = await callMono(http, plan);
  state = store.load();
  if (state.unreadable || state.generation !== generation) return { state, step: { ...plan, discarded: true } };
  applyResponse(state, plan, result, now, cfg);
  store.save(state);
  return { state, step: stepSummary(plan, result) };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Everything the widgets and the app need for one period. */
function buildReport(state, periodKey, nowMs, cfg) {
  const periods = computePeriods(nowMs, cfg);
  const period = periods[periodKey];
  const transactions = allTransactions(state, cfg);
  const current = summarize(transactions, period.start, nowMs, cfg);
  const prevReady = hasCoverageFrom(state, cfg, period.prevStart);
  const previous = prevReady ? summarize(transactions, period.prevStart, period.prevEnd, cfg) : null;
  const prevByCategory = new Map(((previous && previous.categories) || []).map((c) => [c.category, c.amount]));
  return {
    key: periodKey,
    start: period.start,
    end: period.end,
    limit: period.limit,
    spent: current.spent,
    remaining: period.limit - current.spent,
    fraction: period.limit > 0 ? current.spent / period.limit : 0,
    status: budgetStatus(current.spent, period.limit, cfg),
    elapsedFraction: period.elapsedFraction,
    expected: period.expected,
    count: current.count,
    ready: hasCoverageFrom(state, cfg, period.start),
    previousSpent: previous ? previous.spent : null,
    categories: current.categories.map((c) => ({
      ...c,
      delta: previous ? c.amount - (prevByCategory.get(c.category) || 0) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Validation & formatting
// ---------------------------------------------------------------------------

/** Returns a list of problems in CONFIG (empty = OK). */
function validateConfig(cfg) {
  const errors = [];
  if (!(typeof cfg.weeklyLimit === "number" && cfg.weeklyLimit > 0)) errors.push("weeklyLimit must be a positive number");
  if (WEEKDAYS[String(cfg.weekStartsOn).toLowerCase()] === undefined) errors.push("weekStartsOn must be a weekday name");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone }).format(0);
  } catch (e) {
    errors.push("timezone is not a valid IANA time zone");
  }
  if (!["uk", "en", "auto"].includes(cfg.language)) errors.push('language must be "uk", "en" or "auto"');
  if (!Array.isArray(cfg.accountIds) || !cfg.accountIds.every(isValidAccountId)) errors.push("accountIds must be a list of Monobank account ids");
  if (!(cfg.warnPct > 0 && cfg.dangerPct >= cfg.warnPct)) errors.push("warnPct must be > 0 and ≤ dangerPct");
  if (!(typeof cfg.cacheMinutes === "number" && cfg.cacheMinutes >= 1)) errors.push("cacheMinutes must be ≥ 1");
  for (const key of ["excludedMcc", "excludedDescriptions", "ownTransferPatterns"]) {
    if (!Array.isArray(cfg[key])) errors.push(`${key} must be a list`);
  }
  if (!cfg.categoryOverrides || typeof cfg.categoryOverrides !== "object") errors.push("categoryOverrides must be an object");
  return errors;
}

/** Basic shape check for a pasted token; also prevents header injection. */
function normalizeToken(value) {
  const token = String(value || "").trim();
  return /^[A-Za-z0-9_\-+/=]{20,128}$/.test(token) ? token : null;
}

function resolveLanguage(setting, deviceLanguage) {
  if (setting === "uk" || setting === "en") return setting;
  return String(deviceLanguage || "").toLowerCase().startsWith("uk") ? "uk" : "en";
}

/** 12345 → "123 €" or with decimals "123,45 €" (uk) / "123.45 €" (en). */
function formatMoney(cents, lang, opts) {
  const options = opts || {};
  const decimals = options.decimals ? 2 : 0;
  const negative = cents < 0;
  const abs = Math.abs(cents) / 100;
  const fixed = abs.toFixed(decimals);
  const [intPart, fracPart] = fixed.split(".");
  const group = lang === "uk" ? "\u00A0" : ",";
  const decimal = lang === "uk" ? "," : ".";
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const isZero = Number(fixed) === 0;
  const sign = negative && !isZero ? "\u2212" : options.sign && !isZero ? "+" : "";
  return `${sign}${grouped}${fracPart ? decimal + fracPart : ""}\u00A0€`;
}

function formatTime(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function formatDay(ms, timeZone, lang) {
  const p = zonedParts(ms, timeZone);
  const s = STRINGS[lang] || STRINGS.en;
  return `${s.weekdays[p.weekday]}, ${p.day} ${s.monthsShort[p.month - 1]}`;
}

function formatAgo(ms, nowMs, lang) {
  const s = STRINGS[lang] || STRINGS.en;
  const minutes = Math.max(0, Math.round((nowMs - ms) / MINUTE));
  if (minutes < 90) return s.minutesAgo.replace("{n}", minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return s.hoursAgo.replace("{n}", hours);
  return s.daysAgo.replace("{n}", Math.round(hours / 24));
}

function format(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (key in values ? values[key] : `{${key}}`));
}

const STRINGS = {
  uk: {
    week: "Тиждень", month: "Місяць", weekShort: "Тиж.", monthShort: "Міс.",
    left: "залишилось", over: "понад ліміт", of: "з",
    spent: "Витрачено", limit: "Ліміт", remaining: "Залишок", overspent: "Перевищено",
    categories: "Категорії", transactions: "Операції",
    updated: "оновлено {t}", minutesAgo: "{n} хв тому", hoursAgo: "{n} год тому", daysAgo: "{n} дн тому",
    refresh: "↻ Оновити дані", refreshing: "Оновлення з Monobank…",
    waiting: "Наступний запит через {s} с (ліміт Monobank — 1 запит на хвилину)",
    vsPrev_week: "{x} до мин. тижня", vsPrev_month: "{x} до мин. місяця", prevLoading: "мин. період ще завантажується",
    loading: "Завантаження даних…", noData: "Немає витрат за цей період",
    needToken: "Відкрийте MonoBudget у Scriptable, щоб додати токен",
    showExcluded: "Показувати виключені операції", back: "← Усі категорії",
    resetToken: "Видалити токен і кеш з телефону",
    resetConfirm: "Видалити токен Monobank з Keychain і збережені операції з цього телефону?",
    remove: "Видалити", cancel: "Скасувати", save: "Зберегти", ok: "OK",
    tokenTitle: "Токен Monobank",
    tokenMessage: "Вставте персональний токен з api.monobank.ua. Він дає доступ лише на читання і зберігається тільки в Keychain цього пристрою.",
    tokenBad: "Це не схоже на токен Monobank. Скопіюйте його повністю з api.monobank.ua.",
    tokenInvalid: "Monobank не прийняв токен. Створіть новий на api.monobank.ua і введіть його ще раз.",
    paceAhead: "На {x} більше, ніж очікувалось на сьогодні", paceBehind: "На {x} менше, ніж очікувалось на сьогодні",
    preview: "Переглянути віджет", txCount: "{n} оп.", hold: "очікує",
    reasons: { mcc: "виключено (MCC)", description: "виключено (опис)", own: "власний переказ", income: "надходження", zero: "нульова сума" },
    refund: "повернення",
    errors: {
      rateLimit: "Ліміт запитів Monobank — показано збережені дані",
      network: "Немає зв'язку — показано збережені дані",
      auth: "Токен недійсний — відкрийте скрипт",
      http: "Помилка Monobank — показано збережені дані",
      parse: "Неочікувана відповідь Monobank — показано збережені дані",
    },
    configError: "Помилка в CONFIG", noEurAccounts: "Не знайдено EUR-рахунків Monobank",
    inline: "{label}: {x} залишилось", inlineOver: "{label}: перевищено на {x}",
    weekdays: ["нд", "пн", "вт", "ср", "чт", "пт", "сб"],
    monthsShort: ["січ.", "лют.", "бер.", "квіт.", "трав.", "черв.", "лип.", "серп.", "вер.", "жовт.", "лист.", "груд."],
  },
  en: {
    week: "Week", month: "Month", weekShort: "Wk", monthShort: "Mo",
    left: "left", over: "over", of: "of",
    spent: "Spent", limit: "Limit", remaining: "Remaining", overspent: "Overspent",
    categories: "Categories", transactions: "Transactions",
    updated: "updated {t}", minutesAgo: "{n} min ago", hoursAgo: "{n} h ago", daysAgo: "{n} d ago",
    refresh: "↻ Refresh data", refreshing: "Refreshing from Monobank…",
    waiting: "Next request in {s} s (Monobank allows 1 request per minute)",
    vsPrev_week: "{x} vs last week", vsPrev_month: "{x} vs last month", prevLoading: "previous period still loading",
    loading: "Loading data…", noData: "No spending in this period",
    needToken: "Open MonoBudget in Scriptable to add your token",
    showExcluded: "Show excluded transactions", back: "← All categories",
    resetToken: "Delete token and cache from this phone",
    resetConfirm: "Delete the Monobank token from Keychain and cached transactions from this phone?",
    remove: "Delete", cancel: "Cancel", save: "Save", ok: "OK",
    tokenTitle: "Monobank token",
    tokenMessage: "Paste your personal token from api.monobank.ua. It is read-only and stored only in this device's Keychain.",
    tokenBad: "This doesn't look like a Monobank token. Copy the whole token from api.monobank.ua.",
    tokenInvalid: "Monobank rejected the token. Create a new one at api.monobank.ua and enter it again.",
    paceAhead: "{x} more than expected by today", paceBehind: "{x} less than expected by today",
    preview: "Preview widget", txCount: "{n} tx", hold: "pending",
    reasons: { mcc: "excluded (MCC)", description: "excluded (description)", own: "own transfer", income: "income", zero: "zero amount" },
    refund: "refund",
    errors: {
      rateLimit: "Monobank rate limit — showing saved data",
      network: "No connection — showing saved data",
      auth: "Token rejected — open the script",
      http: "Monobank error — showing saved data",
      parse: "Unexpected Monobank response — showing saved data",
    },
    configError: "CONFIG error", noEurAccounts: "No Monobank EUR accounts found",
    inline: "{label}: {x} left", inlineOver: "{label}: {x} over",
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
};

// ============================================================================
// SCRIPTABLE — everything below uses Scriptable APIs (not run in tests)
// ============================================================================

const KEYCHAIN_KEY = "monobudget.monobank-token";
const PALETTE = {
  ok: "#34C759",
  warn: "#FF9F0A",
  danger: "#FF3B30",
  track: "#8E8E93",
};

function dynamic(light, dark) {
  return Color.dynamic(new Color(light), new Color(dark));
}

const COLORS = {
  background: () => dynamic("#FFFFFF", "#1C1C1E"),
  text: () => dynamic("#1C1C1E", "#FFFFFF"),
  secondary: () => dynamic("#6C6C70", "#AEAEB2"),
  ok: () => dynamic("#248A3D", "#30D158"),
  warn: () => dynamic("#C93400", "#FF9F0A"),
  danger: () => dynamic("#D70015", "#FF453A"),
};

// ---------------------------------------------------------------------------
// Storage, token, network
// ---------------------------------------------------------------------------

/**
 * Cache in Scriptable's private Library folder: on this device only, not in
 * iCloud Drive or the Files app. Like all app data it is included in device
 * backups (iCloud backups are encrypted; Finder backups only if enabled).
 */
function createStore() {
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.libraryDirectory(), "MonoBudget");
  const file = fm.joinPath(dir, "cache.json");
  const write = (state) => {
    if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
    fm.writeString(file, JSON.stringify(state));
  };
  const read = () => {
    // Another process may be writing right now: retry once before giving up.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return migrateState(JSON.parse(fm.readString(file)));
      } catch (e) {
        // fall through and retry
      }
    }
    return null;
  };
  const load = () => {
    if (!fm.fileExists(file)) return emptyState();
    return read() || { ...emptyState(), unreadable: true };
  };
  return {
    load,
    /** Returns false (and writes nothing) if the cache was deleted/reset since `state` was loaded. */
    save(state) {
      if (state.unreadable) return false;
      const current = fm.fileExists(file) ? read() : null;
      if (current && current.generation !== state.generation) return false;
      write(state);
      return true;
    },
    /**
     * Wipe all cached data. The new generation stops in-flight runs from writing
     * old data back; the rate-limit claim is kept so the next request still waits.
     */
    clear() {
      const old = load();
      write({ ...emptyState(Date.now()), lastRequestAt: old.unreadable ? Date.now() : old.lastRequestAt || 0 });
    },
  };
}

function readToken() {
  try {
    return Keychain.contains(KEYCHAIN_KEY) ? normalizeToken(Keychain.get(KEYCHAIN_KEY)) : null;
  } catch (e) {
    return null; // Keychain may be unavailable while the phone is locked
  }
}

async function showMessage(title, message) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addAction(t().ok);
  await alert.presentAlert();
}

async function promptForToken(message) {
  const s = t();
  const alert = new Alert();
  alert.title = s.tokenTitle;
  alert.message = message || s.tokenMessage;
  alert.addSecureTextField("X-Token", "");
  alert.addAction(s.save);
  alert.addCancelAction(s.cancel);
  if ((await alert.presentAlert()) === -1) return null;
  const token = normalizeToken(alert.textFieldValue(0));
  if (!token) {
    await showMessage(s.tokenTitle, s.tokenBad);
    return null;
  }
  Keychain.set(KEYCHAIN_KEY, token);
  return token;
}

/** GET from Monobank. Never log the request: its headers contain the token. */
function createHttp(token) {
  return async function http(path) {
    const request = new Request(MONO_API + path);
    request.method = "GET";
    request.headers = { "X-Token": token, Accept: "application/json" };
    request.timeoutInterval = 20;
    // Never follow redirects: the X-Token header would be sent to the new host.
    request.onRedirect = () => null;
    let body;
    try {
      body = await request.loadString();
    } catch (e) {
      return { ok: false, status: 0, kind: "network" };
    }
    const status = (request.response && request.response.statusCode) || 0;
    if (status !== 200) return { ok: false, status };
    try {
      return { ok: true, status, data: JSON.parse(body) };
    } catch (e) {
      return { ok: false, status, kind: "parse" };
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => Timer.schedule(Math.max(0, ms), false, resolve));
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

let LANG = "en";
function t() {
  return STRINGS[LANG];
}

function money(cents, opts) {
  return formatMoney(cents, LANG, opts);
}

function statusColor(status) {
  return COLORS[status]();
}

/** Horizontal progress bar with an optional "expected by today" tick. */
function drawBar(fraction, paceFraction, status, width, height, mono) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const barHeight = paceFraction === null ? height : Math.round(height * 0.6);
  const y = (height - barHeight) / 2;
  const radius = barHeight / 2;

  const track = new Path();
  track.addRoundedRect(new Rect(0, y, width, barHeight), radius, radius);
  ctx.addPath(track);
  ctx.setFillColor(mono ? new Color("#FFFFFF", 0.3) : new Color(PALETTE.track, 0.28));
  ctx.fillPath();

  const fillWidth = Math.min(1, Math.max(0, fraction)) * width;
  if (fillWidth > 0) {
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, y, Math.max(fillWidth, barHeight), barHeight), radius, radius);
    ctx.addPath(fill);
    ctx.setFillColor(mono ? new Color("#FFFFFF") : new Color(PALETTE[status]));
    ctx.fillPath();
  }

  if (paceFraction !== null && paceFraction > 0 && paceFraction < 1) {
    const x = Math.round(paceFraction * width);
    ctx.setFillColor(mono ? new Color("#FFFFFF", 0.8) : new Color(PALETTE.track));
    ctx.fillRect(new Rect(Math.max(0, x - 1), 0, 2, height));
  }
  return ctx.getImage();
}

/** Ring for the circular lock screen widget (Scriptable has no arc API). */
function drawRing(fraction, size, lineWidth) {
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const r = (size - lineWidth) / 2;
  const c = size / 2;
  ctx.setLineWidth(lineWidth);
  ctx.setStrokeColor(new Color("#FFFFFF", 0.3));
  ctx.strokeEllipse(new Rect(lineWidth / 2, lineWidth / 2, size - lineWidth, size - lineWidth));
  const f = Math.min(1, Math.max(0, fraction));
  if (f > 0) {
    const steps = Math.max(2, Math.ceil(f * 120));
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const angle = -Math.PI / 2 + 2 * Math.PI * f * (i / steps);
      points.push(new Point(c + r * Math.cos(angle), c + r * Math.sin(angle)));
    }
    const arc = new Path();
    arc.addLines(points);
    ctx.addPath(arc);
    ctx.setStrokeColor(new Color("#FFFFFF"));
    ctx.strokePath();
  }
  return ctx.getImage();
}

function runUrl(period) {
  return `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}&period=${period}`;
}

function paceOf(report) {
  return CONFIG.showPaceMarker ? report.elapsedFraction : null;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

function addText(stack, text, font, color) {
  const item = stack.addText(text);
  item.font = font;
  if (color) item.textColor = color;
  item.lineLimit = 1;
  item.minimumScaleFactor = 0.6;
  return item;
}

function footerText(state, now) {
  const s = t();
  const synced = lastSyncedAt(state, CONFIG);
  if (state.lastError) {
    const ago = synced ? " · " + formatAgo(synced, now, LANG) : "";
    return `⚠︎ ${s.errors[state.lastError.kind] || s.errors.http}${ago}`;
  }
  if (!synced) return s.loading;
  if (now - synced > 2 * CONFIG.cacheMinutes * MINUTE) return "⚠︎ " + format(s.updated, { t: formatAgo(synced, now, LANG) });
  return format(s.updated, { t: formatTime(synced, CONFIG.timezone) });
}

/** One budget row (medium/large widgets): label, spent of limit, remaining, bar. */
function addBudgetRow(container, report, barWidth, compact) {
  const s = t();
  const row = container.addStack();
  row.layoutVertically();
  row.url = runUrl(report.key);

  const top = row.addStack();
  top.centerAlignContent();
  addText(top, s[report.key].toUpperCase(), Font.semiboldSystemFont(11), COLORS.secondary());
  top.addSpacer();
  addText(top, `${money(report.spent)} ${s.of} ${money(report.limit)}`, Font.systemFont(11), COLORS.secondary());

  row.addSpacer(compact ? 1 : 2);
  const middle = row.addStack();
  middle.bottomAlignContent();
  addText(middle, money(report.remaining), Font.boldRoundedSystemFont(compact ? 20 : 24), statusColor(report.status));
  middle.addSpacer(4);
  addText(middle, report.remaining < 0 ? s.over : s.left, Font.systemFont(11), COLORS.secondary());
  middle.addSpacer();
  addText(middle, `${Math.round(report.fraction * 100)}%`, Font.mediumSystemFont(11), COLORS.secondary());

  row.addSpacer(compact ? 3 : 5);
  const bar = row.addImage(drawBar(report.fraction, paceOf(report), report.status, barWidth * 2, 16));
  bar.imageSize = new Size(barWidth, 8);
}

function messageWidget(text) {
  const widget = new ListWidget();
  widget.backgroundColor = COLORS.background();
  addText(widget, "MonoBudget", Font.semiboldSystemFont(12), COLORS.secondary());
  widget.addSpacer(4);
  const body = widget.addText(text);
  body.font = Font.systemFont(13);
  body.textColor = COLORS.text();
  widget.url = runUrl("week");
  return widget;
}

function accessoryMessage(text) {
  const widget = new ListWidget();
  const item = widget.addText(text);
  item.font = Font.systemFont(11);
  item.minimumScaleFactor = 0.6;
  widget.url = runUrl("week");
  return widget;
}

function buildWidget(state, family, parameter, now) {
  const s = t();
  const param = ["week", "month", "both"].includes(parameter) ? parameter : null;
  const reports = { week: buildReport(state, "week", now, CONFIG), month: buildReport(state, "month", now, CONFIG) };
  const accessory = family.startsWith("accessory");
  const hasAccounts = selectAccounts(state.clientInfo, CONFIG).length > 0;

  if (state.clientInfo && !hasAccounts) return accessory ? accessoryMessage(s.noEurAccounts) : messageWidget(s.noEurAccounts);
  if (!reports.week.ready || !reports.month.ready) {
    const text = state.lastError ? s.errors[state.lastError.kind] || s.loading : s.loading;
    const widget = accessory ? accessoryMessage(text) : messageWidget(text);
    widget.refreshAfterDate = new Date(now + 2 * MINUTE);
    return widget;
  }

  const showAmounts = !accessory || CONFIG.lockScreenShowAmounts;
  const short = (report) => (showAmounts ? money(Math.abs(report.remaining)) : `${Math.round(report.fraction * 100)}%`);
  let widget;

  if (family === "accessoryInline") {
    const period = param === "month" ? "month" : "week";
    widget = new ListWidget();
    const text = (key) => {
      const r = reports[key];
      if (!showAmounts) return `${s[key]}: ${Math.round(r.fraction * 100)}%`;
      return format(r.remaining < 0 ? s.inlineOver : s.inline, { label: s[key], x: short(r) });
    };
    widget.addText(param === "both" ? `${s.weekShort} ${short(reports.week)} · ${s.monthShort} ${short(reports.month)}` : text(period));
    widget.url = runUrl(period);
  } else if (family === "accessoryCircular") {
    const period = param === "month" ? "month" : "week";
    const r = reports[period];
    widget = new ListWidget();
    widget.addAccessoryWidgetBackground = true;
    widget.backgroundImage = drawRing(r.fraction, 76, 7);
    const row = widget.addStack();
    row.addSpacer();
    const column = row.addStack();
    column.layoutVertically();
    column.centerAlignContent();
    const value = showAmounts ? `${r.remaining < 0 ? "\u2212" : ""}${Math.round(Math.abs(r.remaining) / 100)}` : `${Math.round(r.fraction * 100)}%`;
    const valueText = addText(column, value, Font.boldRoundedSystemFont(16));
    valueText.centerAlignText();
    const caption = addText(column, showAmounts ? "€" : s[period === "week" ? "weekShort" : "monthShort"], Font.systemFont(9));
    caption.centerAlignText();
    row.addSpacer();
    widget.url = runUrl(period);
  } else if (family === "accessoryRectangular") {
    widget = new ListWidget();
    const keys = param === "week" || param === "month" ? [param] : ["week", "month"];
    keys.forEach((key, i) => {
      const r = reports[key];
      if (i > 0) widget.addSpacer(4);
      const line = widget.addStack();
      addText(line, s[key], Font.semiboldSystemFont(12));
      line.addSpacer();
      addText(line, `${r.remaining < 0 && showAmounts ? "\u2212" : ""}${short(r)}`, Font.mediumSystemFont(12));
      widget.addSpacer(2);
      const bar = widget.addImage(drawBar(r.fraction, null, r.status, 280, 8, true));
      bar.imageSize = new Size(140, 4);
    });
    widget.url = runUrl(keys[0]);
  } else if (family === "small") {
    const period = param === "month" ? "month" : "week";
    const r = reports[period];
    widget = new ListWidget();
    widget.backgroundColor = COLORS.background();
    widget.setPadding(14, 14, 12, 14);
    addText(widget, s[period].toUpperCase(), Font.semiboldSystemFont(11), COLORS.secondary());
    widget.addSpacer(2);
    addText(widget, money(r.remaining), Font.boldRoundedSystemFont(28), statusColor(r.status));
    addText(widget, r.remaining < 0 ? s.over : s.left, Font.systemFont(11), COLORS.secondary());
    widget.addSpacer();
    addText(widget, `${money(r.spent)} ${s.of} ${money(r.limit)}`, Font.systemFont(11), COLORS.secondary());
    widget.addSpacer(4);
    const bar = widget.addImage(drawBar(r.fraction, paceOf(r), r.status, 224, 16));
    bar.imageSize = new Size(112, 8);
    widget.addSpacer(6);
    addText(widget, footerText(state, now), Font.systemFont(9), COLORS.secondary());
    widget.url = runUrl(period);
  } else {
    // medium, large, extraLarge
    widget = new ListWidget();
    widget.backgroundColor = COLORS.background();
    widget.setPadding(12, 14, 10, 14);
    const keys = param === "week" || param === "month" ? [param] : ["week", "month"];
    const width = family === "medium" ? 280 : 300;
    keys.forEach((key, i) => {
      if (i > 0) widget.addSpacer(family === "medium" ? 8 : 16);
      addBudgetRow(widget, reports[key], width, family === "medium");
    });
    widget.addSpacer();
    const footer = widget.addStack();
    footer.addSpacer();
    addText(footer, footerText(state, now), Font.systemFont(9), COLORS.secondary());
    widget.url = runUrl(keys[0]);
  }

  widget.refreshAfterDate = new Date(now + CONFIG.cacheMinutes * MINUTE);
  return widget;
}

async function runWidget(store) {
  const now = Date.now();
  const family = config.widgetFamily || "medium";
  const errors = validateConfig(CONFIG);
  if (errors.length) {
    Script.setWidget(messageWidget(`${t().configError}: ${errors[0]}`));
    return;
  }
  const token = readToken();
  if (!token) {
    Script.setWidget(family.startsWith("accessory") ? accessoryMessage(t().needToken) : messageWidget(t().needToken));
    return;
  }
  // Widgets get only a few seconds: at most one Monobank request per run.
  const { state } = await syncWithStore(store, CONFIG, createHttp(token), () => Date.now());
  Script.setWidget(buildWidget(state, family, String(args.widgetParameter || "").trim().toLowerCase(), Date.now()));
}

// ---------------------------------------------------------------------------
// In-app report (UITable)
// ---------------------------------------------------------------------------

async function runApp(store, query) {
  const errors = validateConfig(CONFIG);
  if (errors.length) {
    await showMessage(t().configError, errors.join("\n"));
    return;
  }
  let token = readToken() || (await promptForToken());
  if (!token) return;
  // A cache that stays unreadable is useless: the user is here, so start over.
  // Retry first — a widget may be writing it right now.
  let unreadable = store.load().unreadable;
  for (let attempt = 0; unreadable && attempt < 3; attempt++) {
    await sleep(300);
    unreadable = store.load().unreadable;
  }
  if (unreadable) store.clear();

  const ctx = {
    store,
    state: store.load(),
    token,
    ui: {
      period: query.period === "month" ? "month" : "week",
      view: "categories",
      category: null,
      showExcluded: false,
      syncMessage: "",
    },
    table: new UITable(),
    dismissed: false,
    syncing: false,
  };
  ctx.table.showSeparators = true;

  render(ctx);
  const presented = ctx.table.present(false).then(() => {
    ctx.dismissed = true;
  });
  const syncing = syncLoop(ctx);
  await presented;
  await syncing;
}

/** Fetch in the background while the table is open, honouring the rate limit. */
async function syncLoop(ctx) {
  if (ctx.syncing) return;
  ctx.syncing = true;
  const s = t();
  const deadline = Date.now() + 10 * MINUTE;
  try {
    while (!ctx.dismissed && Date.now() < deadline) {
      // Widgets may have synced in the meantime (separate process): always start from disk.
      const fresh = ctx.store.load();
      if (fresh.unreadable) {
        // Probably mid-write by a widget: wait instead of spinning.
        await sleep(2 * SECOND);
        continue;
      }
      ctx.state = fresh;
      const plan = planNextRequest(ctx.state, Date.now(), CONFIG);
      if (plan.type === "none") break;
      if (plan.type === "wait") {
        ctx.ui.syncMessage = format(s.waiting, { s: Math.ceil((plan.until - Date.now()) / 1000) });
        render(ctx);
        await sleep(Math.min(5 * SECOND, plan.until - Date.now()));
        continue;
      }
      ctx.ui.syncMessage = s.refreshing;
      render(ctx);
      const { state, step } = await syncWithStore(ctx.store, CONFIG, createHttp(ctx.token), () => Date.now());
      if (step.unreadable) {
        await sleep(2 * SECOND);
        continue;
      }
      ctx.state = state;
      if (step.discarded) break;
      if (ctx.state.lastError && ctx.state.lastError.kind === "auth") {
        ctx.ui.syncMessage = "";
        render(ctx);
        await showMessage(s.tokenTitle, s.tokenInvalid);
        break;
      }
      // Network, HTTP and unexpected-response errors: stop; only rate limits are retried.
      if (ctx.state.lastError && ctx.state.lastError.kind !== "rateLimit") break;
    }
  } finally {
    ctx.syncing = false;
    ctx.ui.syncMessage = "";
    if (!ctx.dismissed) render(ctx);
  }
}

function addButtonRow(table, items) {
  const row = new UITableRow();
  row.height = 44;
  for (const item of items) {
    const cell = row.addButton(item.selected ? `● ${item.title}` : item.title);
    cell.centerAligned();
    cell.widthWeight = 1;
    cell.dismissOnTap = false;
    cell.onTap = item.onTap;
  }
  table.addRow(row);
}

function addTextRow(table, title, subtitle, opts) {
  const options = opts || {};
  const row = new UITableRow();
  row.height = options.height || 44;
  row.dismissOnSelect = false;
  const cell = row.addText(title, subtitle);
  cell.titleFont = options.font || Font.systemFont(15);
  if (options.color) cell.titleColor = options.color;
  cell.subtitleColor = COLORS.secondary();
  if (options.center) cell.centerAligned();
  if (options.onSelect) row.onSelect = options.onSelect;
  table.addRow(row);
  return row;
}

function render(ctx) {
  const s = t();
  const { table, ui, state } = ctx;
  const now = Date.now();
  const report = buildReport(state, ui.period, now, CONFIG);
  const periods = computePeriods(now, CONFIG);
  const period = periods[ui.period];
  table.removeAllRows();

  const select = (changes) => () => {
    Object.assign(ui, changes);
    render(ctx);
  };
  addButtonRow(table, [
    { title: s.week, selected: ui.period === "week", onTap: select({ period: "week", category: null }) },
    { title: s.month, selected: ui.period === "month", onTap: select({ period: "month", category: null }) },
  ]);
  addButtonRow(table, [
    { title: s.categories, selected: ui.view === "categories", onTap: select({ view: "categories", category: null }) },
    { title: s.transactions, selected: ui.view === "transactions", onTap: select({ view: "transactions", category: null }) },
  ]);

  // Summary header
  const header = new UITableRow();
  header.height = 64;
  const spentCell = header.addText(money(report.spent, { decimals: true }), `${s.spent} · ${s.limit} ${money(report.limit, { decimals: true })}`);
  spentCell.titleFont = Font.boldRoundedSystemFont(22);
  spentCell.subtitleColor = COLORS.secondary();
  spentCell.widthWeight = 55;
  const remainingCell = header.addText(
    money(report.remaining, { decimals: true }),
    report.remaining < 0 ? s.overspent : s.remaining,
  );
  remainingCell.titleFont = Font.boldRoundedSystemFont(22);
  remainingCell.titleColor = statusColor(report.status);
  remainingCell.subtitleColor = COLORS.secondary();
  remainingCell.rightAligned();
  remainingCell.widthWeight = 45;
  table.addRow(header);

  const barRow = new UITableRow();
  barRow.height = 22;
  barRow.addImage(drawBar(report.fraction, paceOf(report), report.status, 700, 24));
  table.addRow(barRow);

  const paceDiff = report.spent - report.expected;
  if (Math.abs(paceDiff) >= 100) {
    addTextRow(table, format(paceDiff > 0 ? s.paceAhead : s.paceBehind, { x: money(Math.abs(paceDiff)) }), null, {
      font: Font.systemFont(13),
      color: paceDiff > 0 ? COLORS.warn() : COLORS.secondary(),
      height: 30,
    });
  }

  if (ui.syncMessage) addTextRow(table, ui.syncMessage, null, { font: Font.systemFont(12), color: COLORS.secondary(), height: 30 });
  else if (state.lastError) addTextRow(table, "⚠︎ " + (s.errors[state.lastError.kind] || s.errors.http), null, { font: Font.systemFont(12), color: COLORS.warn(), height: 30 });

  if (!report.ready) {
    addTextRow(table, s.loading, null, { color: COLORS.secondary() });
  } else if (ui.category) {
    addTextRow(table, s.back, null, { color: COLORS.secondary(), onSelect: select({ category: null }) });
    addTextRow(table, categoryLabel(ui.category, LANG), null, { font: Font.boldSystemFont(17) });
    renderTransactions(table, listTransactions(allTransactions(state, CONFIG), period.start, now, CONFIG, { category: ui.category }));
  } else if (ui.view === "categories") {
    renderCategories(ctx, report, select);
  } else {
    addTextRow(table, `${ui.showExcluded ? "☑︎" : "☐"} ${s.showExcluded}`, null, {
      font: Font.systemFont(14),
      onSelect: select({ showExcluded: !ui.showExcluded }),
    });
    renderTransactions(table, listTransactions(allTransactions(state, CONFIG), period.start, now, CONFIG, { includeExcluded: ui.showExcluded }));
  }

  // Footer
  addTextRow(table, footerText(state, now), null, { font: Font.systemFont(12), color: COLORS.secondary(), height: 30 });
  addTextRow(table, s.refresh, null, {
    color: COLORS.ok(),
    onSelect: () => {
      ctx.state = ctx.store.load();
      ctx.state.forceRefreshAt = Date.now();
      ctx.store.save(ctx.state);
      syncLoop(ctx);
    },
  });
  addTextRow(table, s.preview, null, {
    onSelect: async () => {
      await buildWidget(ctx.state, "medium", "both", Date.now()).presentMedium();
    },
  });
  addTextRow(table, s.resetToken, null, { color: COLORS.danger(), onSelect: () => resetToken(ctx) });
  table.reload();
}

function renderCategories(ctx, report, select) {
  const s = t();
  if (report.categories.length === 0) {
    addTextRow(ctx.table, s.noData, null, { color: COLORS.secondary() });
    return;
  }
  const max = Math.max(...report.categories.map((c) => c.amount), 1);
  for (const c of report.categories) {
    const row = new UITableRow();
    row.height = 58;
    row.dismissOnSelect = false;
    row.onSelect = select({ category: c.category });

    const name = row.addText(categoryLabel(c.category, LANG), `${format(s.txCount, { n: c.count })} · ${Math.round(c.pct)}%`);
    name.titleFont = Font.mediumSystemFont(15);
    name.subtitleColor = COLORS.secondary();
    name.widthWeight = 44;

    const bar = row.addImage(drawBar(c.amount / max, null, "ok", 160, 10));
    bar.widthWeight = 20;

    let deltaText = s.prevLoading;
    if (c.delta !== null) deltaText = format(s["vsPrev_" + report.key], { x: money(c.delta, { sign: true }) });
    const amount = row.addText(money(c.amount, { decimals: true }), deltaText);
    amount.titleFont = Font.semiboldSystemFont(15);
    amount.subtitleColor = c.delta > 0 ? COLORS.warn() : COLORS.secondary();
    amount.rightAligned();
    amount.widthWeight = 36;
    ctx.table.addRow(row);
  }
}

function renderTransactions(table, items) {
  const s = t();
  if (items.length === 0) {
    addTextRow(table, s.noData, null, { color: COLORS.secondary() });
    return;
  }
  for (const group of groupByDay(items, CONFIG.timezone)) {
    const header = new UITableRow();
    header.isHeader = true;
    header.height = 32;
    header.addText(formatDay(group.time, CONFIG.timezone, LANG));
    table.addRow(header);

    for (const { tx, kind, reason, category } of group.items) {
      const counted = kind === "expense" || kind === "refund";
      const details = [categoryLabel(category, LANG), formatTime(tx.time * 1000, CONFIG.timezone)];
      if (tx.hold) details.push(s.hold);
      if (kind === "refund") details.push(s.refund);
      if (!counted) details.push(s.reasons[reason] || reason);

      const row = new UITableRow();
      row.height = 52;
      row.dismissOnSelect = false;
      const desc = row.addText(cleanText(tx.description, 60) || "—", details.join(" · "));
      desc.titleFont = Font.systemFont(15);
      desc.subtitleColor = COLORS.secondary();
      if (!counted) desc.titleColor = COLORS.secondary();
      desc.widthWeight = 70;
      const amount = row.addText(money(tx.amount, { decimals: true, sign: tx.amount > 0 }));
      amount.titleFont = Font.mediumSystemFont(15);
      amount.titleColor = !counted ? COLORS.secondary() : tx.amount > 0 ? COLORS.ok() : COLORS.text();
      amount.rightAligned();
      amount.widthWeight = 30;
      table.addRow(row);
    }
  }
}

async function resetToken(ctx) {
  const s = t();
  const alert = new Alert();
  alert.title = s.resetToken;
  alert.message = s.resetConfirm;
  alert.addDestructiveAction(s.remove);
  alert.addCancelAction(s.cancel);
  if ((await alert.presentAlert()) !== 0) return;
  if (Keychain.contains(KEYCHAIN_KEY)) Keychain.remove(KEYCHAIN_KEY);
  ctx.store.clear();
  ctx.state = ctx.store.load();
  const token = await promptForToken();
  if (token) {
    ctx.token = token;
    render(ctx);
    syncLoop(ctx);
  } else {
    ctx.dismissed = true;
    render(ctx);
  }
}

async function main() {
  LANG = resolveLanguage(CONFIG.language, Device.language());
  const store = createStore();
  if (config.runsInWidget) await runWidget(store);
  else await runApp(store, args.queryParameters || {});
  Script.complete();
}

// ============================================================================
// Entry point: run in Scriptable, export the core for Node tests.
// ============================================================================
if (typeof Script !== "undefined") {
  await main();
} else if (typeof module !== "undefined") {
  module.exports = {
    CONFIG, CATEGORY_KEYS, EUR, MAX_RANGE_MS, PAGE_SIZE, RATE_LIMIT_MS, CLIENT_INFO_TTL_MS, STRINGS,
    zonedParts, zonedToUtc, tzOffsetMs, daysInMonth, computePeriods, historyStartFor, liveStartFor, budgetStatus,
    categoryForMcc, categoryFor, categoryLabel, resolveCategoryName,
    normalizeIban, cleanText, normalizeTransaction, classifyTransaction, summarize, listTransactions, groupByDay,
    emptyState, migrateState, isValidAccountId, selectAccounts, allTransactions, hasCoverageFrom, lastSyncedAt,
    planNextRequest, statementPath, applyResponse, syncStep, syncWithStore, buildReport,
    validateConfig, normalizeToken, resolveLanguage, formatMoney, formatTime, formatDay, formatAgo, format,
  };
}
