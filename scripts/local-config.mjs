import { readFileSync } from "node:fs";

export function localConfig() {
  const values = {};
  try {
    for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) values[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...values, ...process.env };
}

export const workerConfig = () => JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
