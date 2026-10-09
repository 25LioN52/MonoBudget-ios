"use strict";
// The Claude Code guard hook (.claude/hooks/guard-bash.mjs) must keep blocking
// risky commands. Exit code 2 = blocked. Commit/push cases that would run the
// scanner are covered by the "allowed" cases that do not touch git state.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ROOT } = require("./helpers");

const HOOK = path.join(ROOT, ".claude", "hooks", "guard-bash.mjs");
const HOST = ["api", "monobank", "ua"].join(".");

const CASES = [
  [`curl -H "X-Token: x" https://${HOST}/personal/client-info`, 2],
  [`Invoke-RestMethod https://${HOST}/personal/client-info`, 2],
  [`grep -n ${HOST} MonoBudget.js`, 0],
  ['git commit --no-verify -m "x"', 2],
  ['git commit --no-verif -m "x"', 2],
  ['git commit -n -m "x"', 2],
  ['git -c core.hooksPath=/dev/null commit -m "x"', 2],
  ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath git commit -m "x"', 2],
  ["git config core.hooksPath /dev/null", 2],
  ["git config core.hooksPath .githooks", 0],
  ["git add -f .env", 2],
  ['git add --force cache.json && git commit -m "x"', 2],
  ["git push --force origin main", 2],
  ["git push --force-with-lease", 2],
  ["git push origin +main", 2],
  ['git push origin "+refs/heads/main"', 2],
  ["git push --mirror", 2],
  ["git push origin --delete main", 2],
  ["git push origin :main", 2],
  // Quoting / escaping must not hide flags.
  ['git commit "--no-verify" -m x', 2],
  ["git commit '-n' -m x", 2],
  ["git commit \\--no-verify -m x", 2],
  ['git push "--no-verify"', 2],
  ['git push origin "--force"', 2],
  // Config indirection and direct hook tampering.
  ["git -c include.path=/tmp/x.cfg commit -m x", 2],
  ["git -c includeIf.onbranch:main.path=/tmp/x commit -m x", 2],
  ["git --config-env=core.hooksPath=X commit -m x", 2],
  ["printf '[core]\\n\\thooksPath = /tmp\\n' >> .git/config", 2],
  ["echo 'exit 0' > .githooks/pre-commit && git commit -m x", 2],
  // Staging ignored files.
  ["git stage -f .env", 2],
  ["git add --forc .env", 2],
  ["git update-index --add .env", 2],
  // Push variants.
  ["git push --prune origin", 2],
  ["git -c remote.origin.mirror=true push", 2],
  ["git config remote.origin.push +refs/heads/*:refs/heads/*", 2],
  // Commit/push must be standalone so the scan sees the final state.
  ["git commit -am x && git push", 2],
  ['git commit -m "$(cat msg.txt)"', 2],
  ["git commit -F msg.txt; echo done", 2],
  ["git commit --no-${a}verify -m x", 2],
  ["git commit --no-$'v'erify -m x", 2],
  ["git commit -$'n' -m x", 2],
  ["cp /tmp/x README.md & git commit -am x", 2],
  ["git -C /tmp/repo push --force", 2],
  ["git --work-tree . push --no-${a}verify origin main", 2],
  ['git -C "My Dir" push --no-${a}verify origin main', 2],
  ["git --namespace x commit -$'n' -m x", 2],
  // File names and modes must not look like pushes.
  ["git add --chmod=+x .githooks/pre-commit .githooks/commit-msg .githooks/pre-push", 0],
  ["git ls-files -s .githooks/pre-push", 0],
  ["git status", 0],
  ["git diff --cached", 0],
  ["node --test", 0],
];

function runHook(input) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
  });
}

for (const [command, expected] of CASES) {
  test(`hook: ${command.replace(HOST, "<monobank>")} → ${expected === 2 ? "blocked" : "allowed"}`, () => {
    const result = runHook(JSON.stringify({ tool_input: { command } }));
    assert.equal(result.status, expected, result.stderr);
  });
}

test("hook fails closed on malformed input", () => {
  assert.equal(runHook("{not json").status, 2);
});

test("commit is blocked when hooks are disabled or tampered with", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  const commit = () => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_input: { command: "git commit -F msg.txt" } }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });

  let r = commit();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /hooks are not enabled/);

  git("config", "core.hooksPath", ".githooks");
  fs.mkdirSync(path.join(dir, ".githooks"));
  for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
    fs.copyFileSync(path.join(ROOT, ".githooks", hook), path.join(dir, ".githooks", hook));
  }
  git("add", ".githooks");
  // Neutered but still mentioning the expected strings in a comment.
  fs.writeFileSync(path.join(dir, ".githooks", "pre-commit"), "#!/bin/sh\n# scripts/secret-scan.mjs secret-scan: OK\nexit 0\n");
  r = commit();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pre-commit differs from its staged version/);

  fs.writeFileSync(path.join(dir, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  r = commit();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pre-commit no longer runs the secret scanner/);
  fs.rmSync(dir, { recursive: true, force: true });
});
