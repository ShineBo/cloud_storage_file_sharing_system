import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../.env", import.meta.url);
let contents;
try {
  contents = await readFile(path, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  contents = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  await writeFile(path, contents, { mode: 0o600, flag: "wx" });
}

const keys = ["CLASS_OIDC_CLIENT_SECRET", "CLASS_FIXTURE_PASSWORD"];
const missing = keys.filter((key) => !new RegExp(String.raw`^\s*(?:export\s+)?${key}\s*=`, "m").test(contents));
if (missing.length > 0) {
  const additions = missing.map((key) => `${key}=${randomBytes(24).toString("hex")}`).join("\n");
  await writeFile(path, `${contents.trimEnd()}\n\n# Credentials for the local synthetic class realm.\n${additions}\n`, { mode: 0o600 });
}

console.log("Local class configuration is ready.");
