// Replays golden.json against plugin.js the way `new-api plugin test` does
// for top-level hooks. Run: node test/golden.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

globalThis.utils = { unixNow: () => 1780000000, uuid: () => "uuid" };
const root = path.resolve(import.meta.dirname, "..");
const plugin = await import(pathToFileURL(path.join(root, "plugin.js")).href);
const { cases } = JSON.parse(readFileSync(path.join(root, "golden.json"), "utf8"));

let passed = 0;
for (const c of cases) {
  try {
    if (c.expectedError) assert.throws(() => plugin[c.hook](...c.args), (e) => e.message.includes(c.expectedError));
    else assert.deepEqual(JSON.parse(JSON.stringify(plugin[c.hook](...c.args))), c.expected);
    passed++;
  } catch (error) {
    console.error("FAIL " + c.name + "\n" + error.message);
    process.exitCode = 1;
  }
}
console.log("golden fixture: " + passed + "/" + cases.length + " cases passed");
