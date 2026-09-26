import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const target = manifest.exports?.["./tui"];

assert.equal(target, "./dist/recap.js", "./tui must export compiled JavaScript");
assert.equal(manifest.exports?.["."], "./dist/server.js", "package must export the server plugin");
assert.equal(manifest.exports?.["./rpc"], "./dist/rpc.js", "package must export the shared RPC");

const entry = readFileSync(resolve(root, target), "utf8");
assert.doesNotMatch(entry, /<(?:box|text|markdown)\b/, "compiled entry must not contain raw JSX");
assert.doesNotMatch(entry, /from ["'][^"']+\.tsx?["']/, "compiled entry must not import TypeScript");
assert.match(entry, /get when\(\)/, "Solid transform must preserve reactive Show getters");
assert.match(entry, /createElement\("markdown"\)/, "compiled entry must render the recap as markdown");
assert.match(entry, /from ["']@opentui\/core["'];/, "compiled entry must reuse the host's OpenTUI core");;

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  }),
);
const pack = Array.isArray(packed) ? packed[0] : packed[manifest.name] ?? Object.values(packed)[0];
const files = pack.files.map((file) => file.path);

assert.ok(files.includes("dist/recap.js"), "tarball must include the compiled TUI entry");
assert.ok(files.includes("dist/server.js"), "tarball must include the server entry");
assert.ok(files.includes("dist/rpc.js"), "tarball must include the RPC definition");
assert.ok(files.includes("index.js") && files.includes("tui.js"), "installed directory must expose both local entrypoints");
assert.ok(files.includes("dist/recap-model.js"), "tarball must include the compiled model");
assert.ok(files.includes("dist/recap-digest.js"), "tarball must include the compiled digest");
assert.ok(files.includes("dist/recap-state.js"), "tarball must include the compiled state");
assert.ok(!files.some((file) => file.endsWith(".ts") || file.endsWith(".tsx")), "tarball must not include raw sources");

console.log("package artifact: compiled Solid JS only");
