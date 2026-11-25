import { readFile } from "node:fs/promises";

const fixture = JSON.parse(await readFile(new URL("./se-final-class-realm.json", import.meta.url), "utf8"));
const MAX_SECRET_LENGTH = 8192;

async function main() {
  const [temporaryClient, extra] = process.argv.slice(2);
  if (!temporaryClient || extra || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(temporaryClient)) {
    throw new Error("Pass the temporary Keycloak service client ID and pipe its secret on standard input.");
  }

  const origin = new URL(process.env.CLASS_IDENTITY_ORIGIN || "http://127.0.0.1:18080");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      || !["http:", "https:"].includes(origin.protocol)
      || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("This helper only updates the local Keycloak instance at its loopback origin.");
  }

  if (process.stdin.isTTY) {
    throw new Error("Pipe the temporary client secret on standard input without printing it.");
  }
  let secret = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    secret += chunk;
    if (secret.length > MAX_SECRET_LENGTH) throw new Error("The temporary client secret exceeds the supported size.");
  }
  secret = secret.trim();
  if (!secret) throw new Error("The temporary client secret is missing.");

  const tokenResponse = await fetch(new URL("/realms/master/protocol/openid-connect/token", origin), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials", client_id: temporaryClient, client_secret: secret,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (!tokenResponse.ok) throw new Error(`Keycloak refused the temporary service client (HTTP ${tokenResponse.status}).`);
  const { access_token: token } = await tokenResponse.json();
  if (typeof token !== "string" || !token) throw new Error("Keycloak did not return an admin session token.");

  const realmPath = `/admin/realms/${encodeURIComponent(fixture.realm)}`;
  async function request(path, method = "GET", body, acceptable = []) {
    const response = await fetch(new URL(realmPath + path, origin), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok && !acceptable.includes(response.status)) {
      throw new Error(`Keycloak rejected the ${method} ${path || "realm"} operation (HTTP ${response.status}).`);
    }
    return method === "GET" ? response.json() : undefined;
  }

  const realm = await request("");
  const settings = {
    displayName: fixture.displayName,
    displayNameHtml: fixture.displayNameHtml,
    loginTheme: fixture.loginTheme,
    rememberMe: fixture.rememberMe,
  };
  if (Object.keys(settings).some((key) => realm[key] !== settings[key])) {
    await request("", "PUT", settings);
  }
  console.log("Cloud Storage sign-in branding is configured.");
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
