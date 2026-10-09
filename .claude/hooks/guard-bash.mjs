#!/usr/bin/env node
// Claude Code PreToolUse hook for Bash/PowerShell commands. A tripwire, not a
// sandbox: it stops the common ways an agent could leak data or skip checks.
// Exit code 2 blocks the command and shows stderr to Claude. Fails closed.
//
//  - Blocks direct calls to the Monobank API (agents must never use a real token).
//  - Blocks skipping or redirecting git hooks/config, force-staging ignored
//    files, force/mirror/prune pushes and remote deletions.
//  - `git commit` / `git push` must be standalone commands (no chaining,
//    pipes, redirects or substitutions), so the checks below see the final state.
//  - Before `git commit`: hooks must be enabled and intact; scans staged + working tree.
//  - Before `git push`: scans the working tree and every commit not yet on origin.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function block(message) {
  process.stderr.write(`Blocked by .claude/hooks/guard-bash.mjs: ${message}\n`);
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function scan(projectDir, args) {
  const scanner = join(projectDir, "scripts", "secret-scan.mjs");
  let out;
  try {
    out = execFileSync(process.execPath, [scanner, ...args], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (error) {
    block(`secret scan (${args.join(" ")}) failed — nothing was committed or pushed.\n${error.stderr || error.stdout || error.message}`);
  }
  if (!/^secret-scan: OK/m.test(out)) block(`secret scan (${args.join(" ")}) did not confirm OK — failing closed.`);
}

function gitOut(projectDir, args) {
  try {
    return execFileSync("git", args, { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    return "";
  }
}

function checkGitHooks(projectDir) {
  if (gitOut(projectDir, ["config", "--get", "core.hooksPath"]) !== ".githooks") {
    block("git hooks are not enabled. Run: git config core.hooksPath .githooks");
  }
  for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
    let text = "";
    try {
      text = readFileSync(join(projectDir, ".githooks", hook), "utf8");
    } catch (e) {
      block(`.githooks/${hook} is missing.`);
    }
    if (!text.includes("scripts/secret-scan.mjs") || !text.includes("secret-scan: OK")) {
      block(`.githooks/${hook} no longer runs the secret scanner.`);
    }
    // Git runs the working-tree hook: it must match the version in the index,
    // so any change to it is staged and visible in the reviewed diff.
    const staged = gitOut(projectDir, ["ls-files", "-s", "--", `.githooks/${hook}`]).split(/\s+/)[1];
    if (staged && gitOut(projectDir, ["hash-object", "--", `.githooks/${hook}`]) !== staged) {
      block(`.githooks/${hook} differs from its staged version — stage and review hook changes before committing or pushing.`);
    }
  }
}

/** Remote named in `git push [options] <remote> …` (default: origin). */
function pushRemote(command) {
  const args = command.replace(/^[\s\S]*?\bpush\b/, "").trim().split(/\s+/).filter(Boolean);
  const remote = args.find((a) => !a.startsWith("-"));
  return remote && /^[\w.-]+$/.test(remote) ? remote : "origin";
}

async function run() {
  const input = JSON.parse((await readStdin()) || "{}");
  const raw = String((input.tool_input && input.tool_input.command) || "");
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  // Quotes, backslashes and backticks must not hide flags: "--no-verify", '-n', \--force, `--force`.
  const command = raw.replace(/["'\\`]/g, "");

  const networkTool = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|http|https|fetch|node|python3?|deno|bun|ruby|perl)\b/i;
  if (/api\.monobank\.ua/i.test(command) && networkTool.test(command)) {
    block("direct requests to api.monobank.ua are not allowed from the agent. Use the fake Monobank API in tests/helpers.js.");
  }

  if (!/\bgit\b/.test(command)) return;
  const segment = "[^\\n|;&]*";
  // The word anywhere in a git command (any global options, quoted paths…), but
  // not as part of a path, file name or option: `.githooks/pre-push`, `--chmod=+x`.
  const subcommand = (name) => new RegExp(String.raw`\bgit\b${segment}(?<![\w./=:-])${name}(?![\w./-])`);
  const gitCommit = subcommand("commit").test(command);
  const gitPush = subcommand("push").test(command);

  // Hook / config bypasses (any git command).
  if (/(^|\s)--no-ver\w*/.test(command)) block("--no-verify (or an abbreviation) skips the secret scan.");
  const enablingHooks = /^\s*git config (--local )?core\.hooksPath \.githooks\s*$/.test(command);
  if (!enablingHooks && /core\.hooksPath|GIT_CONFIG_\w+|\bHUSKY=0\b|include\.path|includeIf|--config-env|\.git\/config|\.git\/hooks/i.test(command)) {
    block("changing hook paths or injecting git config would bypass the secret scan.");
  }
  if (/remote\.[^\s=]*\.(mirror|push)\b/i.test(command)) block("changing remote push/mirror config is not allowed.");
  if (new RegExp(`\\bgit\\b${segment}\\b(add|stage)\\b${segment}(\\s-[a-zA-Z]*f[a-zA-Z]*\\b|\\s--fo\\w*)`).test(command)) {
    block("`git add -f` would stage ignored files (secrets, caches, exports).");
  }
  if (/\bupdate-index\b[^\n]*--add\b/.test(command)) block("`git update-index --add` would stage ignored files.");

  if (gitCommit && new RegExp(`\\bcommit\\b${segment}\\s-[a-zA-Z]*n[a-zA-Z]*\\b`).test(command)) block("`git commit -n` skips the secret scan.");
  if (gitPush && /(\s--fo\w*|\s-[a-zA-Z]*f\b|[\s=]\+[\w/.:-]|\s--mirror\b|\s--delete\b|\s-d\b|\s--prune\b|\s:[\w/.-])/.test(command)) {
    block("force, mirror and prune pushes and remote deletions are not allowed.");
  }

  if (gitCommit || gitPush) {
    // Standalone only: the scans run before the command, so nothing may change in between.
    // Also no `$` (variable/ANSI-C expansion like --no-${x}verify) and no background `&`.
    if (/[&;|\n`<>$]/.test(raw)) {
      block("run `git commit` / `git push` as a standalone command (no &, &&, ;, |, redirects, $ or backticks). For the message use `git commit -F <file>`.");
    }
    checkGitHooks(projectDir);
  }
  if (gitCommit) {
    scan(projectDir, ["--staged"]);
    scan(projectDir, ["--all"]);
  }
  if (gitPush) {
    scan(projectDir, ["--all"]);
    scan(projectDir, ["--history", "HEAD", "--not", `--remotes=${pushRemote(command)}`]);
  }
}

run().then(
  () => process.exit(0),
  (error) => block(`guard hook error (failing closed): ${error && error.message}`),
);
