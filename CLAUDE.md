# MonoBudget-ios — guide for Claude

Scriptable (iOS) script showing a weekly/monthly spending budget from Monobank as home/lock screen widgets, plus an in-app category/transaction report. Public repo, MIT. Docs for users are in Ukrainian (README, SECURITY, CONTRIBUTING); code and comments are in English.

## Security is the top priority — always double-check

This project handles a Monobank personal API token and personal financial data. Every change gets **two independent security checks** before it lands:

1. **Automated:** `npm run check` (tests + `scripts/secret-scan.mjs`). Git hooks in `.githooks` (pre-commit, commit-msg, pre-push) run the scanner and fail closed. The PreToolUse hook `.claude/hooks/guard-bash.mjs` also scans before every `git commit`/`git push` (push: whole unpushed history) and blocks hook bypasses (`--no-verify` and abbreviations, `-n`, `core.hooksPath`/`GIT_CONFIG_*` overrides), `git add -f`, force/mirror pushes, remote deletions and direct calls to the Monobank API. It is a tripwire, not a sandbox — don't look for ways around it. Run `git commit -F <message-file>` and `git push …` as **standalone** commands (no `&`, `;`, `|`, `<`, `>`, `$`, backticks); hooks must match their staged versions.
2. **Review:** run the `security-reviewer` subagent on the diff and fix every finding before committing. Use the `/secure-commit` skill, which does all of this in order.

CI repeats both (our scanner + TruffleHog), and `main` only accepts PRs with green CI.

Hard rules:
- Never put a real token, statement, IBAN, card number or name anywhere (code, tests, fixtures, commits, issues, chat output). Fixtures are synthetic: IBANs use check digits `00` (always invalid), cards are masked (`000000******0001`).
- Never call `api.monobank.ua` from the agent; use the fake API in `tests/helpers.js`.
- The script may only make network requests to `https://api.monobank.ua`, token only in the `X-Token` header, read from Keychain, redirects never followed (`request.onRedirect = () => null`). No logging (`console.*`, `log*`), no WebView, no `FileManager.iCloud`, no `allowInsecureRequest`. `tests/misc.test.js` enforces these.
- Cache only the fields reports need (no balances, no counterparty name/IBAN fields; descriptions are kept as the bank shows them). The cache lives in `FileManager.local().libraryDirectory()`. The app and widgets are separate processes: always sync through `syncWithStore` (reload → claim rate-limit slot on disk → request → reload → apply), never hold state across awaits without reloading.
- An unexpected API response shape must never wipe the cache (`parse` error instead).
- The scanner allow marker is per rule (`secret-scan:allow <rule-id>`); avoid it, and justify every use.
- Zero dependencies: no npm packages (settings deny `npm install`). Pin GitHub Actions by commit SHA.
- Validate anything that goes into a URL or header (`isValidAccountId`, `normalizeToken`).

## Layout

- `MonoBudget.js` — the single deliverable users paste into Scriptable. Sections:
  - `CONFIG` — user settings only.
  - `CORE` — pure functions (dates/time zones, budget periods, MCC categories, classification, sync planning, formatting). No Scriptable APIs here. Exported for tests at the bottom.
  - `SCRIPTABLE` — widgets (`buildWidget`), in-app `UITable` report (`render`), Keychain/FileManager/Request glue.
  - Entry point: `if (typeof Script !== "undefined") await main(); else module.exports = {...}`.
- `tests/` — `node:test` suites; `helpers.js` loads the script in a VM (like Scriptable's async wrapper) and fakes Monobank; `scriptable-mock.js` is a **strict** fake of the Scriptable API (unknown members throw) used by `scriptable-smoke.test.js`. If you use a new Scriptable API, add it to the mock exactly as documented at https://docs.scriptable.app/.
- `tests/fixtures/` — synthetic data in Monobank's format.
- `scripts/secret-scan.mjs` (CLI) + `scripts/secret-scan-lib.mjs` (rules) — zero-dependency secret/PII scanner: `--staged`, `--all`, `--history REVS…`, `--message FILE`, files. Prints `secret-scan: OK` only when clean; callers must check for that line.
- `.githooks/` — pre-commit, commit-msg, pre-push (enable with `git config core.hooksPath .githooks`; must stay mode 100755 in git).

## Commands

```bash
npm test          # node --test (unit + Scriptable smoke + hook tests)
npm run scan      # secret scanner over the repo
npm run check     # both
```

## Monobank API constraints (must hold in code and tests)

- `GET /personal/client-info`, `GET /personal/statement/{account}/{from}/{to}` (Unix seconds), header `X-Token`.
- 1 request per 60 s (all endpoints) → `RATE_LIMIT_MS`, persisted `lastRequestAt`; widgets make at most one request per run.
- Statement range ≤ 31 days + 1 hour → we request ≤ 31 days (`MAX_RANGE_MS`).
- ≤ 500 items per response → page backwards with `to` = oldest item time (`state.pending`).
- Amounts are integer minor units; count only EUR accounts (978); include holds; refetch the live window to drop cancelled holds.

## Conventions

- UI strings go in both `STRINGS.uk` and `STRINGS.en` (a test checks parity).
- Keep `CORE` functions pure and covered by tests; add fixtures for new edge cases (DST, month boundaries…).
- Work on a branch and open a PR; never push to `main` directly (ruleset enforces PR + green CI).
