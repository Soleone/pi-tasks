#!/usr/bin/env node
// Bundles pi for the browser sandbox (WebContainers), whose module loader cannot link pi's internal
// import cycle. pi's own packages go into one file; other dependencies stay external and the sandbox
// installs them from home/package.json, which this script writes with the versions pi pins.
// Usage: node demo/browser/build.mjs (from the repo root, after pnpm install).
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, ".build/pi-app");
// A package's folder, found through node_modules the way Node would (pi's packages export no package.json).
async function packageDir(name, from) {
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpath(candidate);
    if (dir === path.dirname(dir)) throw new Error(`Cannot find ${name}; run pnpm install first.`);
  }
}
const pi = await packageDir("@earendil-works/pi-coding-agent", fileURLToPath(import.meta.url));
const piPackage = JSON.parse(await readFile(path.join(pi, "package.json"), "utf8"));
// The provider SDKs are swapped for stubs, since the scripted model never calls them.
const stubs = { openai: "openai.js", "@anthropic-ai/sdk": "anthropic.js", "@google/genai": "genai.js" };
// Bedrock's SDK only loads when Bedrock is used, so it stays external and is not installed.
const lazy = ["@aws-sdk/client-bedrock-runtime", "@smithy/node-http-handler"];

// Third-party dependencies of pi and of its @earendil-works packages, at the versions they pin.
const external = {};
const seen = new Set();
async function collect(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  if (seen.has(manifest.name)) return;
  seen.add(manifest.name);
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith("@earendil-works/")) await collect(await packageDir(name, path.join(dir, "package.json")));
    else if (!(name in stubs)) external[name] = version;
  }
}
await collect(pi);

await rm(out, { recursive: true, force: true });
const result = await build({
  entryPoints: [path.join(pi, "dist/cli.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(out, "dist/cli.js"),
  external: [...Object.keys(external), "@mariozechner/clipboard"],
  alias: Object.fromEntries(Object.entries(stubs).map(([name, file]) => [name, path.join(here, "stubs", file)])),
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning",
  write: false,
});

// Extensions get pi's modules the way pi's compiled binary hands them over (virtual modules),
// since a bundle has no package folders for the usual aliases to point at.
const aliases = ": { alias: getAliases() }";
let code = result.outputFiles[0].text;
if (code.split(aliases).length !== 2) throw new Error(`pi ${piPackage.version}: expected one "${aliases}" in the loader to patch; check the extension loader.`);
code = code.replace(aliases, ": { virtualModules: VIRTUAL_MODULES, tryNative: false }");
await mkdir(path.join(out, "dist"), { recursive: true });
await writeFile(path.join(out, "dist/cli.js"), code);

// pi finds its themes and assets by walking up from the script to its package.json.
for (const folder of ["theme", "assets"]) {
  await cp(path.join(pi, "dist/modes/interactive", folder), path.join(out, "dist/modes/interactive", folder), {
    recursive: true,
    filter: (source) => !/\.(js|ts|map)$/.test(source),
  });
}
const { name, version, type, bin, piConfig } = piPackage;
await writeFile(path.join(out, "package.json"), `${JSON.stringify({ name, version, type, bin, piConfig }, null, 2)}\n`);
const sorted = Object.fromEntries(Object.entries(external).filter(([name]) => !lazy.includes(name)).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(path.join(here, "home/package.json"), `${JSON.stringify({ name: "pi-demo", private: true, description: `Dependencies of the bundled pi ${version}, written by demo/browser/build.mjs.`, dependencies: sorted }, null, 2)}\n`);
console.log(`Bundled pi ${version} (${(code.length / 1e6).toFixed(1)} MB) into demo/browser/.build/pi-app, with ${Object.keys(sorted).length} external dependencies.`);
