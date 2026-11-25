import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--vm" && argument !== "--logins")
    || new Set(args).size !== args.length) {
  throw new Error("Usage: node scripts/demo-config.mjs [--vm] [--logins]");
}

const vm = args.includes("--vm");
const showLogins = args.includes("--logins");
const filename = vm ? ".env.vm" : ".env.demo";
const webPort = vm ? 3089 : 3088;
const identityPort = vm ? 18089 : 18088;
const mailpitPort = vm ? 18029 : 18028;
const file = new URL(`../${filename}`, import.meta.url);
const realm = new URL("../fixtures/keycloak/northstar-demo-realm.json", import.meta.url);
const { users } = JSON.parse(await readFile(realm, "utf8"));
const accounts = users.map(({ username }) => ({ username, key: `DEMO_${username.toUpperCase()}_PASSWORD` }));
const words = [
  "amber", "apple", "birch", "blue", "cedar", "clover", "coral", "dawn", "dune", "fern", "field", "forest",
  "gold", "hazel", "lake", "lime", "maple", "mint", "oak", "pine", "reed", "river", "sand", "stone",
  "sun", "tide", "trail", "wave", "wind", "wood",
];

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
    `COMPOSE_PROJECT_NAME=cloud-storage-${vm ? "vm" : "demo"}`,
    vm ? "RECOVERY_DATABASE=cloud_storage_vm" : "POSTGRES_PORT=54339",
    `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
    `CLASS_WEB_PORT=${webPort}`,
    `CLASS_APP_ORIGIN=http://localhost:${webPort}`,
    `KEYCLOAK_HOST_PORT=${identityPort}`,
    `CLASS_IDENTITY_ORIGIN=http://localhost:${identityPort}`,
    `CLASS_OIDC_CLIENT_SECRET=${randomBytes(24).toString("hex")}`,
    "# The base Compose file requires this setting. The demo realm uses the per-account values below.",
    `CLASS_FIXTURE_PASSWORD=${randomBytes(24).toString("hex")}`,
    `MAILPIT_WEB_HOST_PORT=${mailpitPort}`,
    ...(!vm ? ["MAILPIT_SMTP_HOST_PORT=11028"] : []),
    ...accountPasswords(),
    "",
  ];
  const draft = new URL(`${filename}.${randomUUID()}`, file);
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
  throw new Error(`Use a regular ${filename} file with owner-only permissions (chmod 600 ${filename}).`);
}
const settings = parseEnv(await readFile(file, "utf8"));
const passwords = accounts.map(({ key }) => settings[key]);
if (passwords.some((password) => !password) || new Set(passwords).size !== accounts.length) {
  throw new Error(`The existing ${filename} must contain a distinct password for each demo account.`);
}

if (showLogins) {
  for (const { username, key } of accounts) console.log(`${username}  ${settings[key]}`);
} else {
  console.log(`Northstar demo settings are ready in ${filename}.`);
}
