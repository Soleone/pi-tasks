// Runs once when the sandbox starts: marks project/ as a git checkout on main and records its files,
// so the git stand-in can tell when the agent changes something.
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const home = path.join(__dirname, "..");
const project = path.join(home, "project");
mkdirSync(path.join(project, ".git"), { recursive: true });
writeFileSync(path.join(project, ".git/HEAD"), "ref: refs/heads/main\n");

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".git") return [];
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? files(file) : [file];
  });
}
const baseline = Object.fromEntries(files(project).map((file) => [path.relative(project, file), createHash("sha1").update(readFileSync(file)).digest("hex")]));
writeFileSync(path.join(__dirname, "baseline.json"), JSON.stringify(baseline));
