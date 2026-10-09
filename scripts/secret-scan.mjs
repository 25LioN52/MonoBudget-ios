#!/usr/bin/env node
// Zero-dependency secret & personal-data scanner for this repository.
//
//   node scripts/secret-scan.mjs --staged             files staged for commit (index content)
//   node scripts/secret-scan.mjs --all                all tracked + untracked (non-ignored) files
//   node scripts/secret-scan.mjs --history REVS...    every file version and commit message in
//                                                     `git rev-list REVS` (e.g. `--all`, `HEAD --not --remotes`)
//   node scripts/secret-scan.mjs --message FILE|-     a commit/tag message (file or stdin)
//   node scripts/secret-scan.mjs FILE...              specific files
//
// Prints "secret-scan: OK …" and exits 0 only when nothing was found. Callers
// must check for that line as well as the exit code (fail closed).
// Rules live in secret-scan-lib.mjs. This file always runs main(), so it cannot
// silently skip the scan when started through a symlink or a mapped path.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ALLOW_MARK, decode, forbiddenReason, scanText } from "./secret-scan-lib.mjs";

const MAX_BUFFER = 256 * 1024 * 1024;

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { encoding, maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

function scanBuffer(label, path, buffer, problems) {
  const reason = forbiddenReason(path);
  if (reason) problems.push(`${label}: forbidden file (${reason}) must not be committed`);
  if (!buffer) return;
  const text = decode(buffer);
  if (text === null) {
    // Binaries can't be scanned. Only docs/ may hold them (images reviewed by hand in the PR).
    if (!reason && !path.startsWith("docs/")) problems.push(`${label}: binary file outside docs/ cannot be scanned`);
    return;
  }
  for (const f of scanText(text)) problems.push(`${label}:${f.line}: ${f.rule} ${f.sample}`);
}

/**
 * Commit message text to scan. Only git's own scissors block (`commit -v`
 * editor, recognisable by its fixed explanation line) is cut; a scissors-like
 * line typed into `-m`/`-F` is kept by git, so it is scanned too.
 */
function messageText(raw) {
  const scissors = raw.search(/^# -+ >8 -+\n# Do not modify or remove the line above\./m);
  return scissors === -1 ? raw : raw.slice(0, scissors);
}

function scanFiles(mode, files, problems) {
  for (const file of files) {
    const path = file.replace(/\\/g, "/");
    let buffer = null;
    try {
      buffer = mode === "--staged" ? git(["show", `:${file}`], "buffer") : readFileSync(file);
    } catch (e) {
      buffer = null; // deleted in the working tree
    }
    scanBuffer(path, path, buffer, problems);
  }
  return files.length;
}

function scanHistory(revs, problems) {
  const commits = git(["rev-list", ...revs]).split("\n").filter(Boolean);
  for (const commit of commits) {
    const short = commit.slice(0, 10);
    const message = git(["log", "-1", "--format=%B", commit]);
    for (const f of scanText(message)) problems.push(`commit ${short} message:${f.line}: ${f.rule} ${f.sample}`);
    // -m: merge commits list changes against each parent (content added in a merge is scanned too).
    const changed = new Set(
      git(["diff-tree", "--root", "-m", "--no-commit-id", "-r", "--name-only", "--diff-filter=ACMRT", "-z", commit])
        .split("\0")
        .filter(Boolean),
    );
    for (const path of changed) {
      let buffer = null;
      try {
        buffer = git(["show", `${commit}:${path}`], "buffer");
      } catch (e) {
        buffer = null;
      }
      scanBuffer(`${short}:${path}`, path, buffer, problems);
    }
  }
  return commits.length;
}

function main(argv) {
  const [mode, ...rest] = argv;
  const problems = [];
  let summary;

  if (mode === "--staged") {
    const files = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean);
    summary = `${scanFiles(mode, files, problems)} staged file(s)`;
  } else if (mode === "--all") {
    const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    summary = `${scanFiles(mode, files, problems)} file(s)`;
  } else if (mode === "--history") {
    if (rest.length === 0) throw new Error("--history needs revisions, e.g. --history --all");
    summary = `${scanHistory(rest, problems)} commit(s)`;
  } else if (mode === "--message") {
    if (!rest[0]) throw new Error("--message needs a file (or - for stdin)");
    // Lines starting with "#" are scanned too: `git commit -m "# …"` keeps them.
    const message = messageText(readFileSync(rest[0] === "-" ? 0 : rest[0], "utf8"));
    for (const f of scanText(message)) problems.push(`message:${f.line}: ${f.rule} ${f.sample}`);
    summary = "commit message";
  } else if (mode && !mode.startsWith("--")) {
    summary = `${scanFiles("files", argv, problems)} file(s)`;
  } else {
    console.error("Usage: node scripts/secret-scan.mjs --staged | --all | --history REVS... | --message FILE | FILE...");
    return 2;
  }

  if (problems.length) {
    console.error(`secret-scan: ${problems.length} problem(s) found:\n  ${problems.join("\n  ")}`);
    console.error(`\nRemove the data or use synthetic test values. Only for a false positive, add "${ALLOW_MARK} <rule-id>" to the line.`);
    return 1;
  }
  console.log(`secret-scan: OK (${summary} checked)`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`secret-scan: ERROR ${error.message}`);
  process.exitCode = 2;
}
