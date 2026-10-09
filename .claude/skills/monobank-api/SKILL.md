---
name: monobank-api
description: Monobank personal API facts for MonoBudget-ios — endpoints, rate limits, statement range and pagination, transaction fields, and how to build synthetic fixtures safely. Use when changing sync logic, classification, or test fixtures.
---

# Monobank personal API (as used by MonoBudget)

Docs: https://api.monobank.ua/docs/ — the agent must **never** call the live API (the guard hook blocks it); use `createFakeMono` in `tests/helpers.js`, which enforces the same limits.

## Endpoints

- `GET https://api.monobank.ua/personal/client-info` → `{ clientId, name, webHookUrl, permissions, accounts: [...], jars: [...] }`
  - account: `id`, `sendId`, `balance`, `creditLimit`, `type` (black, white, platinum, iron, fop, yellow, eAid…), `currencyCode` (ISO 4217 numeric: 978 EUR, 980 UAH, 840 USD), `cashbackType`, `maskedPan[]`, `iban`.
- `GET https://api.monobank.ua/personal/statement/{account}/{from}/{to}` — `from`/`to` in Unix **seconds**, `to` optional.
  - item: `id`, `time` (s), `description`, `mcc`, `originalMcc`, `hold` (pending), `amount` (account currency, minor units, negative = spending), `operationAmount` (operation currency), `currencyCode` (operation currency), `commissionRate`, `cashbackAmount`, `balance`, `comment`, `receiptId`, `invoiceId`, `counterEdrpou`, `counterIban`, `counterName`.
- Auth header: `X-Token: <personal token>`. Read-only access.

## Limits (enforced in code and in the fake API)

- **1 request per 60 seconds** — treat as global per token. `RATE_LIMIT_MS = 61 s`, persisted `lastRequestAt`.
- Statement range **≤ 31 days + 1 hour** — we never request more than 31 days (`MAX_RANGE_MS`). Note: October in Europe is exactly 31 days + 1 hour long because of DST.
- **≤ 500 items** per response, newest first. If exactly 500, request again with `to` = oldest item's `time` and dedupe by `id`.
- Errors: 429 = rate limited; 401/403 = bad/revoked token. Always fall back to cache.

## Semantics we rely on

- Count only EUR accounts (`currencyCode === 978`) and use `amount` (already EUR).
- Holds (`hold: true`) count. They can later change amount or disappear, so each refresh replaces all cached items in the fetched window.
- Own transfers: `counterIban` matches one of the user's IBANs; otherwise description patterns (currency exchange, jars). Positive amounts are refunds only for purchase categories; transfers/cash are income.

## Synthetic fixtures (never real data)

- IBANs: `UA00` + digits — check digits `00` are never valid, so the secret scanner ignores them. Same for other countries (`ES00…`).
- Cards: masked, e.g. `000000******0001`. Ids: obviously fake (`fakeTx0001`, `eurBlackAcc0001`).
- Names: generic (`Тестовий Користувач`). Never copy a real statement, even partially or "anonymised".
- Compute timestamps from ISO strings in Europe/Madrid and document the local time in a comment.
