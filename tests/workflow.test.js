"use strict";
// Cheap YAML sanity checks for .github (no YAML parser dependency). A plain
// (unquoted) value containing ": " is invalid YAML — it once broke CI and
// Dependabot ("mapping values are not allowed here"). Use `run: |` instead.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./helpers");

function yamlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return yamlFiles(full);
    return /\.ya?ml$/.test(entry.name) ? [full] : [];
  });
}

const FILES = yamlFiles(path.join(ROOT, ".github"));

test("found the GitHub YAML files", () => {
  assert.ok(FILES.some((f) => f.endsWith(path.join("workflows", "ci.yml"))));
});

for (const file of FILES) {
  test(`YAML: no ": " inside plain scalars — ${path.relative(ROOT, file)}`, () => {
    const bad = [];
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
      const m = /^\s*(?:-\s+)?[\w.-]+:\s+(.*)$/.exec(line);
      if (!m) return;
      const value = m[1].replace(/\s+#.*$/, "");
      if (/^["'|>[{&*!]/.test(value)) return; // quoted, block or flow value
      if (/:\s/.test(value)) bad.push(`${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(bad, [], "quote the value or use a block scalar (`run: |`)");
  });

  test(`YAML: no tabs — ${path.relative(ROOT, file)}`, () => {
    assert.ok(!/^\t/m.test(fs.readFileSync(file, "utf8")));
  });
}

test("workflow pins every action to a full commit SHA", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is pinned by SHA`);
  assert.match(text, /permissions:\s*\n\s*contents: read/);
  assert.ok(!/pull_request_target/.test(text));
});
