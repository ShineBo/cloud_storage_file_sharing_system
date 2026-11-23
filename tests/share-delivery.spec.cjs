const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const mailAddress = { bob: "bob@example.test", priya: "priya@example.test" };

function mailpitUrl(route) {
  const port = process.env.MAILPIT_WEB_HOST_PORT ?? "18025";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("Set MAILPIT_WEB_HOST_PORT to the local Mailpit UI port.");
  }
  return `http://127.0.0.1:${port}/api/v1/${route}`;
}

async function getMailpit(request, route) {
  const response = await request.get(mailpitUrl(route), { maxRedirects: 0, timeout: 5000 });
  expect(response.status()).toBe(200);
  return response.json();
}

async function setChaos(request, data) {
  const response = await request.put(mailpitUrl("chaos"), { data, maxRedirects: 0, timeout: 5000 });
  expect(response.status()).toBe(200);
}

async function recentMessages(request) {
  const { messages } = await getMailpit(request, "messages?limit=200");
  return messages ?? [];
}

async function knownMessages(request) {
  return new Set((await recentMessages(request)).map(({ ID }) => ID));
}

async function matchingRecipients(request, known, link) {
  const potential = (await recentMessages(request)).filter(({ ID }) => !known.has(ID));
  const messages = await Promise.all(potential.map(({ ID }) =>
    getMailpit(request, `message/${encodeURIComponent(ID)}`),
  ));
  return messages
    .filter(({ Text }) => Text?.includes(link))
    .map(({ To }) => To.map(({ Address }) => Address).sort().join(","))
    .sort();
}

async function signIn(page, username, location = "/") {
  const password = process.env.CLASS_FIXTURE_PASSWORD;
  if (!password) throw new Error("Run npm run local:configure before using the local fixture realm.");
  await page.goto(location);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}

async function signInToWorkspace(page, username) {
  await signIn(page, username);
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
}

async function shareFrom(response, status) {
  expect(response.status()).toBe(status);
  const { share } = await response.json();
  expect(share.link).toBe(`/shared/${share.id}`);
  return share;
}

test.describe("share email delivery", () => {
  test.skip(process.env.STEP6_MAIL_CHECK !== "1", "Requires an isolated local Mailpit stack with Chaos enabled.");
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async ({ request }) => {
    test.setTimeout(60_000);
    await expect.poll(async () => {
      const response = await request.get("/api/auth/login", { maxRedirects: 0, timeout: 7000 });
      return response.status() === 302 && response.headers().location?.includes("/protocol/openid-connect/auth?");
    }, { timeout: 45_000, message: "Wait for Keycloak sign-in to be available" }).toBe(true);
  });

  test("shows a rejected email, keeps the copyable link, and retries that original share", async ({
    page, browser, request, baseURL,
  }) => {
    test.setTimeout(80_000);
    await signInToWorkspace(page, "it-admin");
    const bytes = await readFile(path.join(__dirname, "fixtures", "sample.pdf"));
    const name = `Delivery check ${randomUUID().slice(0, 8)}.pdf`;
    const uploaded = await page.request.post(`/api/files?size=${bytes.length}`, {
      headers: { origin: baseURL },
      multipart: { file: { name, mimeType: "application/pdf", buffer: bytes } },
    });
    expect(uploaded.status()).toBe(201);
    const { file } = await uploaded.json();

    await page.reload();
    await page.getByRole("button", { name: `Share ${file.name}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share item" });
    await dialog.getByLabel("Recipient", { exact: true }).selectOption({ label: "Bob Example (bob)" });

    const known = await knownMessages(request);
    const chaos = await getMailpit(request, "chaos");
    let originalShare;
    let link;
    try {
      await setChaos(request, { ...chaos, Recipient: { ErrorCode: 451, Probability: 100 } });
      const createResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/shares" && response.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "Create link", exact: true }).click();
      const created = await createResponse;
      originalShare = await shareFrom(created, 201);
      link = new URL(originalShare.link, baseURL).href;

      await expect(dialog.getByText("Email delivery failed. Retry or copy the link.", { exact: true }))
        .toBeVisible({ timeout: 30_000 });
      const linkInput = dialog.getByRole("textbox", { name: "Share link for Bob Example" });
      await expect(linkInput).toHaveValue(link);
      await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
      await expect(dialog.getByText(/^(Link copied|Copy the link from the selected field)\.$/)).toBeVisible();
      expect(await matchingRecipients(request, known, link)).toEqual([]);

      const replayed = await Promise.all([1, 2].map(() =>
        page.request.post("/api/shares", {
          headers: { origin: baseURL }, data: created.request().postDataJSON(),
        }).then((response) => shareFrom(response, 201)),
      ));
      expect(replayed.map(({ id }) => id)).toEqual([originalShare.id, originalShare.id]);
    } finally {
      await setChaos(request, chaos);
    }

    const retryRoute = `/api/shares/${originalShare.id}/delivery/retry`;
    const retryResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === retryRoute && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Retry email", exact: true }).click();
    const retried = await shareFrom(await retryResponse, 200);
    expect(retried.id).toBe(originalShare.id);
    expect(new URL(retried.link, baseURL).href).toBe(link);

    await expect(dialog.getByText("Email accepted for delivery.", { exact: true })).toBeVisible({ timeout: 30_000 });
    const [first, second] = await Promise.all([1, 2].map(() =>
      page.request.post(retryRoute, { headers: { origin: baseURL } }).then((response) => shareFrom(response, 200)),
    ));
    for (const share of [first, second]) {
      expect(share.id).toBe(originalShare.id);
      expect(share.delivery).toEqual({ status: "sent", sent: 1, total: 1 });
    }
    expect(await matchingRecipients(request, known, link)).toEqual([mailAddress.bob]);

    const listingResponse = await page.request.get(`/api/shares?itemType=file&itemId=${file.id}`);
    expect(listingResponse.status()).toBe(200);
    const { shares } = await listingResponse.json();
    expect(shares.map(({ id }) => id)).toEqual([originalShare.id]);

    const recipient = await browser.newContext({ baseURL });
    try {
      const recipientPage = await recipient.newPage();
      await signIn(recipientPage, "bob", link);
      await expect(recipientPage).toHaveURL(link);
      await expect(recipientPage.getByRole("heading", { name: file.name, exact: true })).toBeVisible();
    } finally {
      await recipient.close();
    }
  });

  test("emails the existing group link once to each current member", async ({ page, request, baseURL }) => {
    test.setTimeout(60_000);
    await signInToWorkspace(page, "security-reviewer");
    const folderResponse = await page.request.post("/api/folders", {
      headers: { origin: baseURL },
      data: { name: `Group delivery ${randomUUID().slice(0, 8)}` },
    });
    expect(folderResponse.status()).toBe(201);
    const { folder } = await folderResponse.json();
    const directoryResponse = await page.request.get("/api/shares/recipients");
    expect(directoryResponse.status()).toBe(200);
    const { groups } = await directoryResponse.json();
    const team = groups.find(({ name }) => name === "Design Team");
    expect(team).toBeDefined();

    const known = await knownMessages(request);
    const shareRequest = {
      itemType: "folder",
      itemId: folder.id,
      recipientType: "group",
      recipientId: team.id,
      permission: "view",
      allowDownload: false,
      requestId: randomUUID(),
    };
    const [first, second] = await Promise.all([1, 2].map(() =>
      page.request.post("/api/shares", {
        headers: { origin: baseURL }, data: shareRequest,
      }).then((response) => shareFrom(response, 201)),
    ));
    expect(second.id).toBe(first.id);

    const listUrl = `/api/shares?itemType=folder&itemId=${folder.id}`;
    await expect.poll(async () => {
      const response = await page.request.get(listUrl);
      expect(response.status()).toBe(200);
      const { shares } = await response.json();
      return shares.map(({ id, delivery }) => ({ id, delivery }));
    }, { timeout: 30_000 }).toEqual([{ id: first.id, delivery: { status: "sent", sent: 2, total: 2 } }]);

    const link = new URL(first.link, baseURL).href;
    const expected = [mailAddress.bob, mailAddress.priya];
    expect(await matchingRecipients(request, known, link)).toEqual(expected);
  });
});
