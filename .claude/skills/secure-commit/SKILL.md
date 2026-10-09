---
name: secure-commit
description: Commit changes in MonoBudget-ios with the mandatory double security check — tests, secret scan, then an independent security-reviewer pass — before anything is committed or pushed. Use whenever the user asks to commit, push, open a PR or "ship" changes in this repo.
---

# Secure commit

Security is the top priority in this repo; every commit is checked twice. Follow these steps in order and stop at the first failure.

1. **Branch.** If on `main`, create a branch first (`git switch -c <type>/<short-name>`). `main` only accepts PRs.
2. **Review the change set.** `git status` and `git diff` (plus `git diff --cached`). Make sure nothing unrelated, generated, or personal is included. Never stage `.env*`, keys, `cache.json`, real statements, or `.claude/settings.local.json`.
3. **Automated check #1.** Run `npm run check` (all tests + `node scripts/secret-scan.mjs --all`). Fix failures; never weaken a test or add `secret-scan:allow` without a written justification.
4. **Independent check #2.** Launch the `security-reviewer` subagent on the staged change set. Fix every CRITICAL/HIGH/MEDIUM finding, re-run step 3, and re-run the reviewer until it returns `APPROVE` or only LOW nits you explicitly mention to the user.
5. **Commit.** Stage specific files (`git add <paths>`, not `git add -A` blindly; hooks with `git add --chmod=+x .githooks/*` so they stay 100755). Write the message to a file in the scratchpad and run `git commit -F <file>` as a **standalone command** — the guard hook rejects commit/push commands containing `&`, `;`, `|`, `<`, `>`, `$` or backticks, so the scans it runs beforehand see the final state. The git hooks scan again; never use `--no-verify`.
6. **Push & PR** (only when the user asked). `git push -u origin <branch>` as a standalone command (the guard scans all unpushed commits, the pre-push hook scans again), then `gh pr create` with the PR template filled in, including the security checklist. CI (`test`, `secret-scan` with history scan + TruffleHog) must be green before merge.
7. **Report** to the user: what changed, test results, scanner result, and the reviewer's verdict (with any remaining nits).
