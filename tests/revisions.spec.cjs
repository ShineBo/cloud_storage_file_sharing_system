const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const pngV1 = path.join(__dirname, "../fixtures/files/handover-v1.png");
const pngV2 = path.join(__dirname, "../fixtures/files/handover-v2.png");

test.beforeAll(async ({ request }) => {
  test.setTimeout(60_000);
  await expect.poll(async () => {
    const response = await request.get("/api/auth/login", { maxRedirects: 0, timeout: 7_000 });
    return response.status() === 302 && response.headers().location?.includes("/protocol/openid-connect/auth?");
  }, { timeout: 45_000, message: "Wait for Keycloak sign-in to be available" }).toBe(true);
});

async function signIn(page, username, location = "/") {
  const password = process.env.CLASS_FIXTURE_PASSWORD;
  if (!password) throw new Error("Run npm run local:configure before testing the fixture realm.");
  await page.goto(location);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}

async function openWorkspace(page, username) {
  await signIn(page, username);
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
}

async function initialFile(owner, origin) {
  const bytes = await readFile(pngV1);
  const name = `Handover ${randomUUID().slice(0, 8)}.png`;
  const response = await owner.post(`/api/files?size=${bytes.length}`, {
    headers: { origin },
    multipart: { file: { name, mimeType: "image/png", buffer: bytes } },
  });
  expect(response.status()).toBe(201);
  const { file } = await response.json();
  expect(file.revision).toBe(1);
  return file;
}

async function shareWith(owner, origin, file, username, permission = "edit") {
  const directory = await owner.get("/api/shares/recipients");
  expect(directory.ok()).toBe(true);
  const { employees } = await directory.json();
  const employee = employees.find((candidate) => candidate.username === username);
  expect(employee).toBeDefined();
  const response = await owner.post("/api/shares", {
    headers: { origin },
    data: {
      itemType: "file", itemId: file.id, recipientType: "employee", recipientId: employee.id,
      permission, allowDownload: true, requestId: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).share;
}

function sharedFile(share, file) {
  return `/api/shared/${share.id}/files/${file.id}`;
}

async function publish(request, origin, filePath, baseRevision, fixture = pngV2) {
  const bytes = await readFile(fixture);
  return request.post(`${filePath}/revisions?baseRevision=${baseRevision}&size=${bytes.length}`, {
    headers: { origin },
    multipart: { file: { name: path.basename(fixture), mimeType: "application/octet-stream", buffer: bytes } },
  });
}

async function revoke(owner, origin, share) {
  const response = await owner.post(`/api/shares/${share.id}/revoke`, { headers: { origin } });
  expect(response.status()).toBe(200);
}

function beginPartialRevision(origin, url, cookie, bytes, revision) {
  const boundary = `revision-${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="replacement.png"\r\nContent-Type: image/png\r\n\r\n`),
    bytes,
  ]);
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
  const cancel = new AbortController();
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request(new URL(`${url}/revisions?baseRevision=${revision}&size=${bytes.length}`, origin), {
      method: "POST",
      signal: cancel.signal,
      headers: {
        origin, cookie, "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": payload.length + ending.length,
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.write(payload);
  });
  void result.catch(() => undefined);
  return { finish: () => request.end(ending), result, close: () => cancel.abort() };
}

test("an editor publishes through the same link and a stale browser refreshes before another upload", async ({
  page, browser, baseURL,
}) => {
  test.setTimeout(60_000);
  await openWorkspace(page, "security-reviewer");
  const file = await initialFile(page.request, baseURL);
  const share = await shareWith(page.request, baseURL, file, "bob");
  const editorContext = await browser.newContext({ baseURL });
  const oldContext = await browser.newContext({ baseURL });
  try {
    const editor = await editorContext.newPage();
    const oldEditor = await oldContext.newPage();
    await Promise.all([signIn(editor, "bob", share.link), signIn(oldEditor, "bob", share.link)]);
    for (const tab of [editor, oldEditor]) {
      await expect(tab.getByRole("heading", { name: file.name, exact: true })).toBeVisible();
      await expect(tab.getByText(/^Version 1 · Security Reviewer/)).toBeVisible();
      await tab.getByRole("button", { name: "Publish revision", exact: true }).click();
      await tab.getByRole("dialog", { name: "Publish revision" }).getByLabel("Choose replacement file").setInputFiles(pngV2);
    }

    const publishDialog = (tab) => tab.getByRole("dialog", { name: "Publish revision" });
    await publishDialog(editor).getByRole("button", { name: "Publish revision", exact: true }).click();
    await expect(editor.getByText("Version 2 published.")).toBeVisible();
    await expect(editor.getByText(/^Version 2 · Bob Example/)).toBeVisible();
    await expect(editor).toHaveURL(`${baseURL}${share.link}`);
    const updated = await editor.request.get(`${sharedFile(share, file)}/download`);
    expect(updated.status()).toBe(200);
    expect(await updated.body()).toEqual(await readFile(pngV2));

    await publishDialog(oldEditor).getByRole("button", { name: "Publish revision", exact: true }).click();
    await expect(oldEditor.getByText(/A newer version is available/)).toBeVisible();
    await expect(oldEditor.getByText(/^Version 2 · Bob Example/)).toBeVisible();
    await expect(publishDialog(oldEditor)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(/^Version 2 · Bob Example/)).toBeVisible();
    await expect(page.getByRole("button", { name: `Publish revision for ${file.name}` })).toBeVisible();
  } finally {
    await Promise.all([editorContext.close(), oldContext.close()]);
  }
});

test("concurrent publications select one current revision and quota includes retained revisions", async ({
  page, browser, baseURL,
}) => {
  test.setTimeout(60_000);
  await openWorkspace(page, "security-reviewer");
  const owner = page.request;
  const file = await initialFile(owner, baseURL);
  const filePath = `/api/files/${file.id}`;
  const initialUsage = (await (await owner.get("/api/files/policy")).json()).usedBytes;
  const outcomes = await Promise.all([
    publish(owner, baseURL, filePath, 1), publish(owner, baseURL, filePath, 1),
  ]);
  expect(outcomes.map((response) => response.status()).sort()).toEqual([201, 409]);
  const accepted = await outcomes.find((response) => response.status() === 201).json();
  expect(accepted.file.revision).toBe(2);
  expect(accepted.file.authorName).toBe("Security Reviewer");
  expect(Date.parse(accepted.file.revisedAt)).toBeGreaterThanOrEqual(Date.parse(file.revisedAt));
  expect(await outcomes.find((response) => response.status() === 409).json()).toMatchObject({ code: "STALE_REVISION" });
  const replacement = await readFile(pngV2);
  const stored = await owner.get(`${filePath}/download`);
  expect(await stored.body()).toEqual(replacement);
  const usage = await (await owner.get("/api/files/policy")).json();
  expect(usage.usedBytes).toBe(initialUsage + replacement.length);
  const differentType = await publish(owner, baseURL, filePath, 2, path.join(__dirname, "fixtures/sample.pdf"));
  expect(differentType.status()).toBe(415);

  const viewShare = await shareWith(owner, baseURL, file, "casey", "view");
  const context = await browser.newContext({ baseURL });
  try {
    await openWorkspace(await context.newPage(), "casey");
    const denied = await publish(context.request, baseURL, sharedFile(viewShare, file), 2);
    expect(denied.status()).toBe(403);
    expect(await denied.json()).not.toHaveProperty("file");
    expect((await (await context.request.get(`/api/shared/${viewShare.id}`)).json()).item.revision).toBe(2);
  } finally {
    await context.close();
  }
});

test("revocation during a multipart replacement releases reserved bytes and leaves the prior version current", async ({
  page, browser, baseURL,
}) => {
  test.setTimeout(60_000);
  await openWorkspace(page, "security-reviewer");
  const file = await initialFile(page.request, baseURL);
  const share = await shareWith(page.request, baseURL, file, "casey");
  const policy = async () => (await (await page.request.get("/api/files/policy")).json());
  const before = await policy();
  const editor = await browser.newContext({ baseURL });
  const bytes = await readFile(pngV2);
  try {
    await openWorkspace(await editor.newPage(), "casey");
    const url = sharedFile(share, file);
    const cookies = (await editor.cookies(`${baseURL}${url}`)).map(({ name, value }) => `${name}=${value}`).join("; ");
    const upload = beginPartialRevision(baseURL, url, cookies, bytes, 1);
    try {
      await expect.poll(async () => (await policy()).availableBytes).toBe(before.availableBytes - bytes.length);
      await revoke(page.request, baseURL, share);
      upload.finish();
      expect(await upload.result).toBe(410);
    } finally {
      upload.close();
    }
    expect(await policy()).toMatchObject({ usedBytes: before.usedBytes, availableBytes: before.availableBytes });
    const { files } = await (await page.request.get("/api/files")).json();
    expect(files.find(({ id }) => id === file.id).revision).toBe(1);
    const stored = await page.request.get(`/api/files/${file.id}/download`);
    expect(await stored.body()).toEqual(await readFile(pngV1));
  } finally {
    await editor.close();
  }
});
