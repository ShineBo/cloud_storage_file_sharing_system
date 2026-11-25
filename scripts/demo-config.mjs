import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const file = new URL("../.env.demo", import.meta.url);
const realm = new URL("../fixtures/keycloak/northstar-demo-realm.json", import.meta.url);
const { users } = JSON.parse(await readFile(realm, "utf8"));
const accounts = users.map(({ username }) => ({ username, key: `DEMO_${username.toUpperCase()}_PASSWORD` }));
const words = [
  "amber", "apple", "birch", "blue", "cedar", "clover", "coral", "dawn", "dune", "fern", "field", "forest",
  "gold", "hazel", "lake", "lime", "maple", "mint", "oak", "pine", "reed", "river", "sand", "stone",
  "sun", "tide", "trail", "wave", "wind", "wood",
];

const showLogins = process.argv[2] === "--logins";
if (process.argv.length > (showLogins ? 3 : 2)) {
  throw new Error("Usage: node scripts/demo-config.mjs [--logins]");
}

function accountPasswords() {
  const issued = new Set();
  const pickWord = () => words[randomInt(words.length)];
  return accounts.map(({ key }) => {
    let password;
    do {
      password = `${pickWord()}-${pickWord()}-${randomInt(10000, 100000)}`;
    } while (issued.has(password));
    issued.add(password);
    return `${key}=${password}`;
  });
}

async function createConfiguration() {
  const configuration = [
    "# Local synthetic Northstar demo. Keep this file with the isolated Keycloak state.",
    "COMPOSE_PROJECT_NAME=cloud-storage-demo",
    "POSTGRES_PORT=54339",
    `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
    "CLASS_WEB_PORT=3088",
    "CLASS_APP_ORIGIN=http://localhost:3088",
    "KEYCLOAK_HOST_PORT=18088",
    "CLASS_IDENTITY_ORIGIN=http://localhost:18088",
    `CLASS_OIDC_CLIENT_SECRET=${randomBytes(24).toString("hex")}`,
    "# The base Compose file requires this setting. The demo realm uses the per-account values below.",
    `CLASS_FIXTURE_PASSWORD=${randomBytes(24).toString("hex")}`,
    "MAILPIT_WEB_HOST_PORT=18028",
    "MAILPIT_SMTP_HOST_PORT=11028",
    ...accountPasswords(),
    "",
  ];
  const draft = new URL(`.env.demo.${randomUUID()}`, file);
  try {
    await writeFile(draft, configuration.join("\n"), { flag: "wx", mode: 0o600 });
    await link(draft, file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await rm(draft, { force: true });
  }
}

try {
  await lstat(file);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await createConfiguration();
}

const stat = await lstat(file);
if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
  throw new Error("Use a regular .env.demo file with owner-only permissions (chmod 600 .env.demo).");
}
const settings = parseEnv(await readFile(file, "utf8"));
const passwords = accounts.map(({ key }) => settings[key]);
if (passwords.some((password) => !password) || new Set(passwords).size !== accounts.length) {
  throw new Error("The existing .env.demo must contain a distinct password for each demo account.");
}

if (showLogins) {
  for (const { username, key } of accounts) console.log(`${username}  ${settings[key]}`);
} else {
  console.log("Northstar demo settings are ready in .env.demo.");
}
