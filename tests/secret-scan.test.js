"use strict";
// Tests for scripts/secret-scan.mjs. Secrets are generated at runtime so this
// file never contains one.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { ROOT } = require("./helpers");

const SCANNER = path.join(ROOT, "scripts", "secret-scan.mjs");
const load = () => import(pathToFileURL(path.join(ROOT, "scripts", "secret-scan-lib.mjs")).href);

function validIban(country, bban) {
  // Real IBAN check digits for a made-up account number.
  const rearranged = bban + country + "00";
  let remainder = 0;
  for (const ch of rearranged) {
    const value = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return country + String(98 - remainder).padStart(2, "0") + bban;
}

function luhnCard(prefix15) {
  for (let d = 0; d <= 9; d++) {
    const candidate = prefix15 + d;
    let sum = 0;
    for (let i = 0; i < candidate.length; i++) {
      let n = Number(candidate[candidate.length - 1 - i]);
      if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error("unreachable");
}

const randomToken = () => crypto.randomBytes(33).toString("base64url"); // 44 chars, like a Monobank token
const UA_IBAN = validIban("UA", "3052990000026007123456789"); // made-up account number, valid checksum

function cli(args, opts) {
  const r = spawnSync(process.execPath, [SCANNER, ...args], { encoding: "utf8", ...opts });
  return { status: r.status, out: r.stdout + r.stderr };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "secret-scan-"));
}

test("detects generated secrets and personal data", async () => {
  const { scanText } = await load();
  const cases = {
    "high-entropy-string": `const t = "${randomToken()}";`,
    "token-assignment": `X-Token: "${crypto.randomBytes(24).toString("base64url")}"`,
    iban: `iban: "${UA_IBAN}"`,
    "card-number": `card ${luhnCard("537541123456789")}`,
    "github-token": `gh${"p"}_${"A1b2C3d4E5".repeat(4)}`,
    "private-key": `-----BEGIN RSA ${"PRIVATE"} KEY-----`,
  };
  for (const [rule, line] of Object.entries(cases)) {
    const findings = scanText(line);
    assert.ok(findings.some((f) => f.rule === rule), `${rule} detected`);
    for (const f of findings) assert.ok(f.sample.length < 24, "findings are masked");
  }
});

test("IBANs are found in any layout", async () => {
  const { scanText } = await load();
  const grouped = UA_IBAN.replace(/(.{4})/g, "$1 ").trim();
  const layouts = [
    `${UA_IBAN} UAH`, // followed by an uppercase word
    `${UA_IBAN} 12345`, // followed by digits
    UA_IBAN.toLowerCase(),
    grouped,
    grouped.replace(/ /g, "\u00A0"),
    UA_IBAN.replace(/(.{4})/g, "$1-"),
    `pay to ${UA_IBAN}. thanks`,
  ];
  for (const text of layouts) assert.ok(scanText(text).some((f) => f.rule === "iban"), `IBAN in: ${text.slice(0, 12)}…`);
  assert.ok(scanText(`${validIban("ES", "21000418450200051332")} and ${UA_IBAN}`).filter((f) => f.rule === "iban").length === 2);
});

test("ignores synthetic fixtures, hashes and per-rule allow-listed lines", async () => {
  const { scanText } = await load();
  assert.deepEqual(scanText(`"iban": "UA00${"0".repeat(24)}1"`), []); // check digits 00 are never valid
  assert.deepEqual(scanText(`"maskedPan": ["000000******0001"]`), []);
  assert.deepEqual(scanText(`uses: actions/checkout@${crypto.randomBytes(20).toString("hex")}`), []);
  assert.deepEqual(scanText(`"time": 1782919800, "ms": 1782919800000`), []);
  assert.deepEqual(scanText(`const t = "${randomToken()}"; // secret-scan:allow high-entropy-string`), []);
  // The marker only silences the named rule.
  const mixed = scanText(`"${randomToken()}" ${UA_IBAN} // secret-scan:allow high-entropy-string`);
  assert.deepEqual(mixed.map((f) => f.rule), ["iban"]);
  assert.ok(scanText(`const t = "${randomToken()}"; // secret-scan:allow`).length > 0, "a bare marker allows nothing");
});

test("IBAN and Luhn helpers", async () => {
  const { isValidIban, isLuhn } = await load();
  const iban = validIban("GB", "WEST12345698765432");
  assert.equal(isValidIban(iban.replace(/(.{4})/g, "$1 ")), true);
  assert.equal(isValidIban(iban.slice(0, -1) + ((Number(iban.slice(-1)) + 1) % 10)), false);
  assert.equal(isValidIban("UA00" + "0".repeat(25)), false);
  const card = luhnCard("411111111111111");
  assert.equal(isLuhn(card), true);
  assert.equal(isLuhn(card.slice(0, -1) + ((Number(card.slice(-1)) + 1) % 10)), false);
});

test("UTF-16 files are decoded, binaries skipped", async () => {
  const { decode, scanText } = await load();
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`token: "${randomToken()}"`, "utf16le")]);
  assert.ok(scanText(decode(utf16)).length > 0);
  assert.equal(decode(Buffer.from([0x89, 0x50, 0x00, 0x01])), null);
});

test("forbidden file types", async () => {
  const { forbiddenReason } = await load();
  for (const p of [".env", "config/.env.local", "key.pem", "cache.json", "statement.pdf", "export.xlsx",
    "monobank.csv", "session.har", "screenshot.png", "IMG_0001.HEIC", "CLAUDE.local.md"]) {
    assert.ok(forbiddenReason(p), `${p} is forbidden`);
  }
  for (const p of ["MonoBudget.js", "docs/widget.png", "tests/fixtures/client-info.json", "README.md"]) {
    assert.equal(forbiddenReason(p), null, `${p} is allowed`);
  }
});

test("CLI prints the OK line only when clean, and fails on secrets", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "leaky.js"), `const token = "${randomToken()}";\n`);
  fs.writeFileSync(path.join(dir, ".env"), "NOTHING=1\n");
  fs.writeFileSync(path.join(dir, "clean.js"), "const x = 1;\n");
  const leaky = cli([path.join(dir, "leaky.js")]);
  assert.equal(leaky.status, 1);
  assert.ok(!leaky.out.includes("secret-scan: OK"));
  assert.equal(cli([path.join(dir, ".env")]).status, 1);
  const clean = cli([path.join(dir, "clean.js")]);
  assert.equal(clean.status, 0);
  assert.match(clean.out, /^secret-scan: OK/m);
  assert.equal(cli([]).status, 2, "no arguments is an error, not a pass");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI still scans when started through a symlinked directory", (t) => {
  const dir = tempDir();
  const link = path.join(dir, "linked-scripts");
  try {
    fs.symlinkSync(path.join(ROOT, "scripts"), link, "junction");
  } catch (e) {
    t.skip("cannot create symlinks/junctions here");
    return;
  }
  const leaky = path.join(dir, "leaky.js");
  fs.writeFileSync(leaky, `const token = "${randomToken()}";\n`);
  const r = spawnSync(process.execPath, [path.join(link, "secret-scan.mjs"), leaky], { encoding: "utf8" });
  assert.equal(r.status, 1, "fails instead of silently exiting 0");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--history finds a secret that was committed and later removed; --message checks commit messages", () => {
  const dir = tempDir();
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "core.hooksPath", "/nonexistent"); // isolate from any global hooks
  fs.writeFileSync(path.join(dir, "a.js"), `const token = "${randomToken()}";\n`);
  git("add", "a.js");
  git("commit", "-q", "-m", "add");
  fs.writeFileSync(path.join(dir, "a.js"), "const token = null;\n");
  git("commit", "-q", "-am", `remove ${UA_IBAN}`);

  assert.equal(cli(["--all"], { cwd: dir }).status, 0, "working tree is clean");
  const history = cli(["--history", "--all"], { cwd: dir });
  assert.equal(history.status, 1);
  assert.match(history.out, /high-entropy-string/);
  assert.match(history.out, /message:1: iban/);

  const msg = path.join(dir, "MSG");
  fs.writeFileSync(msg, "fix: clean message\n");
  assert.equal(cli(["--message", msg]).status, 0);
  fs.writeFileSync(msg, `fix for ${UA_IBAN}\n`);
  assert.equal(cli(["--message", msg]).status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("git hooks are executable and fail closed", () => {
  for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
    const text = fs.readFileSync(path.join(ROOT, ".githooks", hook), "utf8");
    assert.match(text, /secret-scan: OK/, `${hook} requires the OK line`);
  }
  const modes = execFileSync("git", ["ls-files", "-s", ".githooks"], { cwd: ROOT, encoding: "utf8" });
  if (modes.trim()) {
    for (const line of modes.trim().split("\n")) assert.ok(line.startsWith("100755"), `executable in git: ${line}`);
  }
});

test("hidden Unicode (bidi controls, zero-width) is flagged", async () => {
  const { scanText } = await load();
  for (const code of [0x00ad, 0x061c, 0x200b, 0x200e, 0x2028, 0x202e, 0x2066, 0x2069, 0xfeff, 0xe0041, 0xe007f]) {
    const line = `const ok = "safe${String.fromCodePoint(code)}";`;
    assert.ok(scanText(line).some((f) => f.rule === "hidden-unicode"), `U+${code.toString(16)}`);
  }
  const escape = String.fromCharCode(92) + "u202E";
  assert.deepEqual(scanText(`const ok = '${escape} is an escape, not the character';`), []);
  assert.deepEqual(scanText(`emoji ${String.fromCodePoint(0x2764, 0xfe0f)} and Ukrainian text are fine`), []);
});

function tempRepo() {
  const dir = tempDir();
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", ["core", "hooksPath"].join("."), "/nonexistent"); // isolate from any global hooks
  return { dir, git };
}

test("--history scans content introduced in a merge commit", () => {
  const { dir, git } = tempRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "side");
  fs.writeFileSync(path.join(dir, "b.txt"), "side\n");
  git("add", "b.txt");
  git("commit", "-q", "-m", "side");
  git("switch", "-q", "main");
  fs.writeFileSync(path.join(dir, "c.txt"), "main\n");
  git("add", "c.txt");
  git("commit", "-q", "-m", "main");
  git("merge", "-q", "--no-commit", "side");
  fs.writeFileSync(path.join(dir, "a.txt"), `token = "${randomToken()}"\n`); // only in the merge
  git("add", "a.txt");
  git("commit", "-q", "-m", "merge");
  fs.writeFileSync(path.join(dir, "a.txt"), "clean\n");
  git("commit", "-q", "-am", "clean up");
  const r = cli(["--history", "--all"], { cwd: dir });
  assert.equal(r.status, 1, r.out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--message scans lines starting with # and reads stdin", () => {
  const dir = tempDir();
  const msg = path.join(dir, "MSG");
  fs.writeFileSync(msg, `fix\n# ${UA_IBAN}\n`);
  assert.equal(cli(["--message", msg]).status, 1, "# lines are kept by `git commit -m`");
  const scissors = "# ------------------------ >8 ------------------------";
  fs.writeFileSync(msg, `fix\n${scissors}\n# Do not modify or remove the line above.\n# Everything below it will be ignored.\n+ ${UA_IBAN}\n`);
  assert.equal(cli(["--message", msg]).status, 0, "git's verbose diff below its scissors block is not part of the message");
  fs.writeFileSync(msg, `fix\n${scissors}\n${UA_IBAN}\n`);
  assert.equal(cli(["--message", msg]).status, 1, "a typed scissors line is kept by git, so it is scanned");
  const viaStdin = spawnSync(process.execPath, [SCANNER, "--message", "-"], { input: `tag note ${UA_IBAN}\n`, encoding: "utf8" });
  assert.equal(viaStdin.status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unknown binary files outside docs/ fail the scan", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "data.sqlite"), Buffer.from([0x53, 0x51, 0x00, 0x01, 0x02]));
  assert.equal(cli([path.join(dir, "data.sqlite")]).status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("repository working tree is clean", () => {
  const r = cli(["--all"], { cwd: ROOT });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^secret-scan: OK/m);
});
