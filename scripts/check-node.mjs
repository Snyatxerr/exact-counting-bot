import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const exe = "node_modules/node/bin/node.exe";
const version = process.version;
const sums = await (
  await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)
).text();
const line = sums.split("\n").find((s) => s.endsWith("win-x64/node.exe"));
const actual = createHash("sha256").update(readFileSync(exe)).digest("hex");
if (!line || actual !== line.split(/\s+/)[0]) throw Error("公式SHA256と不一致");
console.log(
  JSON.stringify({
    version,
    sha256: actual,
    officialMatch: true,
    openssl: process.versions.openssl,
    brotli: process.versions.brotli,
  }),
);
