const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const mailChecks = process.env.STEP6_MAIL_CHECK === "1";
const securityAddress = "security-reviewer@example.test";

test.skip(!mailChecks, "Requires the local Mailpit fixture. Set STEP6_MAIL_CHECK=1.");

test.beforeAll(async ({ request }) => {
  test.setTimeout(60_000);
  await expect.poll(async () => {
    const response = await request.get("/api/auth/login", { maxRedirects: 0, timeout: 7_000 });
    return response.status() === 302 && response.headers().location?.includes("/protocol/openid-connect/auth?");
  }, { timeout: 45_000, message: "Wait for local sign-in" }).toBe(true);
});

async function signIn(context, username, location = "/") {
  const password = process.env.CLASS_FIXTURE_PASSWORD;
  if (!password) throw new Error("Run npm run local:configure before testing the local realm.");
  const page = await context.newPage();
  await page.goto(location);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  return page;
}

async function signInToWorkspace(context, username) {
  const page = await signIn(context, username);
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
}

async function mailpit(pathname) {
  const port = Number(process.env.MAILPIT_WEB_HOST_PORT || 18025);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid Mailpit fixture port.");
  const response = await fetch(`http://127.0.0.1:${port}/api/v1${pathname}`, { signal: AbortSignal.timeout(5_000) });
  expect(response.status).toBe(200);
  return response.json();
}

async function securityMessages() {
  const { messages } = await mailpit("/messages?limit=100");
  return Promise.all(messages.filter(({ Subject }) => Subject.startsWith("[Security]"))
    .map(({ ID }) => mailpit(`/message/${encodeURIComponent(ID)}`)));
}

test("configured access risks notify Security, and the owner sees corrective feedback without recipient details", async ({
  browser, baseURL,
}) => {
  test.setTimeout(80_000);
  const contexts = await Promise.all(["it-admin", "bob", "casey", "security-reviewer", "dana"]
    .map(() => browser.newContext({ baseURL })));
  const [owner, recipient, outsider, reviewer, inactive] = contexts;
  try {
    await Promise.all([
      signInToWorkspace(owner, "it-admin"), signInToWorkspace(recipient, "bob"),
      signInToWorkspace(outsider, "casey"), signInToWorkspace(reviewer, "security-reviewer"),
    ]);
    const headers = { origin: baseURL };
    const bytes = await readFile(path.join(__dirname, "fixtures/sample.pdf"));
    const filename = `Private alert fixture ${randomUUID().slice(0, 8)}.pdf`;
    const upload = await owner.request.post(`/api/files?size=${bytes.length}`, {
      headers, multipart: { file: { name: filename, mimeType: "application/pdf", buffer: bytes } },
    });
    expect(upload.status()).toBe(201);
    const { file } = await upload.json();
    const { employees } = await (await owner.request.get("/api/shares/recipients")).json();
    const bob = employees.find(({ username }) => username === "bob");
    const created = await owner.request.post("/api/shares", {
      headers,
      data: { itemType: "file", itemId: file.id, recipientType: "employee", recipientId: bob.id,
        permission: "view", allowDownload: false, requestId: randomUUID() },
    });
    expect(created.status()).toBe(201);
    const { share } = await created.json();
    const retry = `/api/shares/${share.id}/delivery/retry`;
    expect((await outsider.request.post(retry, { headers })).status()).toBe(404);
    expect((await owner.request.post(retry)).status()).toBe(403);
    const shares = () => owner.request.get(`/api/shares?itemType=file&itemId=${file.id}`).then((res) => res.json());
    const view = `/api/shared/${share.id}/files/${file.id}/view`;
    const recent = () => reviewer.request.get(`/api/audit?itemId=${file.id}`).then((res) => res.json());

    expect((await shares()).shares[0].lastAccessFailureAt).toBeNull();
    const allowed = await recipient.request.get(view);
    expect(allowed.status()).toBe(200);
    expect(await allowed.body()).toEqual(bytes);

    const rejected = await outsider.request.get(view);
    expect(rejected.status()).toBe(404);
    expect(rejected.headers()["content-disposition"]).toBeUndefined();
    expect(await rejected.json()).not.toHaveProperty("file");
    const senderState = (await shares()).shares[0];
    expect(Date.parse(senderState.lastAccessFailureAt)).toBeGreaterThan(0);
    expect(JSON.stringify(senderState)).not.toContain("Casey Example");
    expect(JSON.stringify(senderState)).not.toContain("casey@example.test");

    const deniedPage = await signIn(inactive, "dana", share.link);
    await expect(deniedPage).toHaveURL(`${baseURL}${share.link}?auth=denied`);
    await expect(deniedPage.getByRole("main").getByRole("alert")).toContainText(/account could not open|account does not have/i);
    const closed = await owner.request.post(`/api/shares/${share.id}/revoke`, { headers });
    expect(closed.status()).toBe(200);
    const revoked = await recipient.request.get(view);
    expect(revoked.status()).toBe(410);
    expect(revoked.headers()["content-disposition"]).toBeUndefined();
    expect(await revoked.json()).not.toHaveProperty("file");

    const { events } = await recent();
    expect(events.find(({ action, status }) => action === "view" && status === 200).alertRule).toBeNull();
    const alertEvents = events.filter(({ alertRule }) => alertRule !== null);
    expect(alertEvents.map(({ alertRule, status }) => [alertRule, status]).sort()).toEqual([
      ["denied-shared-access", 404], ["inactive-share-access", 410],
    ]);
    for (const event of alertEvents) {
      await expect.poll(async () => {
        return (await securityMessages()).filter(({ Text }) => Text.includes(event.id)).length;
      }, { timeout: 25_000, intervals: [500, 1000], message: `Mailpit receives the ${event.alertRule} alert` }).toBe(1);
      const message = (await securityMessages()).find(({ Text }) => Text.includes(event.id));
      expect(message.To.map(({ Address }) => Address)).toEqual([securityAddress]);
      expect(message.Text).not.toContain(share.id);
      expect(message.Text).not.toContain(filename);
      expect(message.Text).not.toContain("se_session");
    }
    await expect.poll(async () => (await recent()).events.filter(({ alertRule }) => alertRule !== null)
      .map(({ alertStatus }) => alertStatus), { timeout: 12_000 }).toEqual(["sent", "sent"]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
