const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { expect, test } = require("@playwright/test");

const exec = promisify(execFile);
const root = path.resolve(__dirname, "..");
const composeFiles = ["compose.yaml", "compose.integrations.yaml", "compose.app.yaml"];
const pending = { status: "pending", sent: 0, total: 1 };
const delivered = { status: "sent", sent: 1, total: 1 };

test.skip(process.env.WORKER_SPLIT_CHECK !== "1", "Requires a dedicated disposable Compose stack.");

async function docker(...args) {
  const { stdout } = await exec("docker", args, { cwd: root, timeout: 20_000 });
  return stdout.trim();
}

function localOrigin(baseURL) {
  const url = new URL(baseURL);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.href !== `${url.origin}/`) {
    throw new Error("Use a local 127.0.0.1 HTTP origin for the disposable app.");
  }
  return url;
}

async function disposableWorker(app, mailPort, workers) {
  const project = process.env.COMPOSE_PROJECT_NAME ?? "";
  const ciProject = process.env.GITHUB_ACTIONS === "true" && project === "cloud-step7-ci";
  if (!ciProject && !/^cloud-step7-worker-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project)) {
    throw new Error("Use a new disposable COMPOSE_PROJECT_NAME starting with cloud-step7-worker-.");
  }
  if (workers !== 1) throw new Error("Run the worker restart regression with --workers=1.");

  const prefix = ["compose", "-p", project, ...composeFiles.flatMap((file) => ["-f", file])];
  const proxy = await docker(...prefix, "port", "proxy", "8080");
  const mailpit = await docker(...prefix, "port", "mailpit", "8025");
  if (proxy !== `127.0.0.1:${app.port || "80"}` || mailpit !== `127.0.0.1:${mailPort}`) {
    throw new Error("The test app and Mailpit ports must match the disposable Compose project.");
  }

  const worker = await docker(...prefix, "ps", "--status", "running", "--quiet", "notification-worker");
  if (!/^[0-9a-f]{12,64}$/.test(worker)) {
    throw new Error("Start exactly one notification-worker in the disposable project before testing.");
  }
  return worker;
}

async function signIn(page, username, destination = "/") {
  const password = process.env.CLASS_FIXTURE_PASSWORD;
  if (!password) throw new Error("Run npm run local:configure for the disposable stack first.");
  await page.goto(destination);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}

async function getJson(request, route) {
  const response = await request.get(route, { maxRedirects: 0, timeout: 5_000 });
  expect(response.status(), route).toBe(200);
  return response.json();
}

test("the API stays ready while the notification worker is stopped and the original link is delivered after restart", async ({
  page, browser, request, baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const app = localOrigin(baseURL);
  const mailPort = Number(process.env.MAILPIT_WEB_HOST_PORT ?? "18025");
  if (!Number.isInteger(mailPort) || mailPort < 1 || mailPort > 65_535) {
    throw new Error("Set MAILPIT_WEB_HOST_PORT to the disposable Mailpit port.");
  }
  const worker = await disposableWorker(app, mailPort, testInfo.config.workers);
  const mailpit = `http://127.0.0.1:${mailPort}/api/v1`;

  await expect.poll(async () => {
    const response = await request.get("/api/auth/login", { maxRedirects: 0, timeout: 7_000 });
    return response.status() === 302 && response.headers().location?.includes("/protocol/openid-connect/auth?");
  }, { timeout: 30_000, message: "Wait for the disposable Keycloak realm" }).toBe(true);
  await signIn(page, "alice");
  await expect(page.getByRole("heading", { name: "My files", exact: true })).toBeVisible();

  const headers = { origin: app.origin };
  const folderResult = await page.request.post("/api/folders", {
    headers, data: { name: `Notification worker check ${randomUUID().slice(0, 8)}` },
  });
  expect(folderResult.status()).toBe(201);
  const { folder } = await folderResult.json();
  const { employees } = await getJson(page.request, "/api/shares/recipients");
  const recipient = employees.find(({ username }) => username === "bob");
  expect(recipient).toBeDefined();

  const recentMessages = async () => (await getJson(request, `${mailpit}/messages?limit=200`)).messages ?? [];
  const seen = new Set((await recentMessages()).map(({ ID }) => ID));
  const listUrl = `/api/shares?itemType=folder&itemId=${folder.id}`;
  const shareList = async () => (await getJson(page.request, listUrl)).shares.map(({ id, delivery }) => ({ id, delivery }));
  const matchingMessages = async (link) => {
    const candidates = (await recentMessages()).filter(({ ID }) => !seen.has(ID));
    const messages = await Promise.all(candidates.map(({ ID }) =>
      getJson(request, `${mailpit}/message/${encodeURIComponent(ID)}`),
    ));
    return messages.filter(({ Text }) => Text?.includes(link)).map(({ To }) => To.map(({ Address }) => Address));
  };

  let original;
  let link;
  try {
    await docker("stop", "--time", "10", worker);
    expect(await docker("inspect", "--format", "{{.State.Running}}", worker)).toBe("false");
    const creation = await page.request.post("/api/shares", {
      headers,
      data: { itemType: "folder", itemId: folder.id, recipientType: "employee", recipientId: recipient.id,
        permission: "view", allowDownload: false, requestId: randomUUID() },
    });
    expect(creation.status()).toBe(201);
    ({ share: original } = await creation.json());
    expect(original.link).toBe(`/shared/${original.id}`);
    expect(original.delivery).toEqual(pending);
    link = new URL(original.link, app.origin).href;

    // A surviving API worker would claim the job during this window.
    const end = Date.now() + 3_000;
    do {
      expect(await getJson(request, "/api/ready")).toEqual({ status: "ready" });
      expect(await shareList()).toEqual([{ id: original.id, delivery: pending }]);
      await delay(500);
    } while (Date.now() < end);
    expect(await matchingMessages(link)).toEqual([]);
  } finally {
    await docker("start", worker);
  }

  await expect.poll(shareList, { timeout: 28_000, message: "The restarted worker sends the original queued share" })
    .toEqual([{ id: original.id, delivery: delivered }]);
  await expect.poll(() => matchingMessages(link), { timeout: 10_000 }).toEqual([["bob@example.test"]]);

  const bob = await browser.newContext({ baseURL: app.origin });
  try {
    const recipientPage = await bob.newPage();
    await signIn(recipientPage, "bob", link);
    await expect(recipientPage).toHaveURL(link);
    await expect(recipientPage.getByRole("heading", { name: folder.name, exact: true })).toBeVisible();
  } finally {
    await bob.close();
  }
});
