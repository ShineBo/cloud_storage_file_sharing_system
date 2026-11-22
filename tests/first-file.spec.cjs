const { createHash, randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const fixturePath = path.resolve(__dirname, "../fixtures/files/handover-v1.png");

test.beforeAll(async ({ request }) => {
  test.setTimeout(60_000);
  await expect.poll(async () => {
    const response = await request.get("/api/auth/login", { maxRedirects: 0, timeout: 7_000 });
    return response.status() === 302 && Boolean(response.headers().location?.includes("/protocol/openid-connect/auth?"));
  }, { timeout: 45_000, message: "Wait for Keycloak sign-in to be available" }).toBe(true);
});

async function signIn(page, username) {
  const password = process.env.CLASS_FIXTURE_PASSWORD;
  if (!password) throw new Error("Run npm run local:configure before testing the local fixture realm.");

  await page.goto("/");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}

test("an employee can upload and download privately, and sign out", async ({ page, browser, request, baseURL }) => {
  const privateName = "step2-owner.png";
  const bytes = await readFile(fixturePath);

  expect((await request.get("/api/files")).status()).toBe(401);
  await signIn(page, "alice");
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
  await expect(page.locator('input[name="file"]')).toBeEnabled();
  await page.locator('input[name="file"]').setInputFiles({ name: privateName, mimeType: "image/png", buffer: bytes });
  const uploaded = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/files");
  await page.getByRole("button", { name: "Upload file" }).click();
  const uploadResponse = await uploaded;
  expect(uploadResponse.status()).toBe(201);
  const { file } = await uploadResponse.json();

  const downloadLink = page.getByRole("link", { name: `Download ${privateName}` }).and(
    page.locator(`a[href="/api/files/${file.id}/download"]`)
  );
  await expect(downloadLink).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(privateName);
  expect(await readFile(await download.path())).toEqual(bytes);

  const other = await browser.newContext({ baseURL });
  try {
    const peer = await other.newPage();
    await signIn(peer, "casey");
    await expect(peer.getByRole("heading", { name: "My files" })).toBeVisible();
    expect((await other.request.get(`/api/files/${file.id}/download`)).status()).toBe(404);
  } finally {
    await other.close();
  }

  const unsupported = await page.request.post("/api/files", {
    headers: { origin: baseURL },
    multipart: { file: { name: "unsupported.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic test file.") } },
  });
  expect(unsupported.status()).toBe(415);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  expect((await page.request.get("/api/files")).status()).toBe(401);
});

for (const username of ["dana", "eve"]) {
  test(`${username} cannot enter the employee workspace`, async ({ page }) => {
    await signIn(page, username);
    await expect(page).toHaveURL(/\/\?auth=denied$/);
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  });
}

const step3Fixtures = path.join(__dirname, "fixtures");

function sendUpload(request, baseURL, bytes, name, { folderId, size = bytes.length } = {}) {
  const query = new URLSearchParams({ size: String(size) });
  if (folderId) query.set("folderId", folderId);
  return request.post(`/api/files?${query}`, {
    headers: { origin: baseURL },
    multipart: { file: { name, mimeType: "application/octet-stream", buffer: bytes } },
  });
}

async function createFolder(request, origin, name, parentId = null) {
  const response = await request.post("/api/folders", { headers: { origin }, data: { name, parentId } });
  expect(response.status()).toBe(201);
  return (await response.json()).folder;
}

test("invalid identity-provider credentials do not start an application session", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.locator("#username").fill("alice");
  await page.locator("#password").fill(`wrong-${randomUUID()}`);
  await page.locator("#kc-login").click();
  await expect(page.getByText(/invalid username or password/i)).toBeVisible();
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);
});

test("an employee creates folders, renames and moves items, and retrieves intact bytes", async ({ page, baseURL }) => {
  await signIn(page, "alice");
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
  const original = `Planning ${randomUUID().slice(0, 8)}`;
  const renamed = `${original} renamed`;
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByRole("textbox", { name: "Folder name" }).fill(original);
  await page.getByRole("button", { name: "Create folder" }).click();

  await page.getByRole("button", { name: `Rename ${original}`, exact: true }).click();
  await page.getByRole("textbox", { name: "New name" }).fill(renamed);
  await page.getByRole("button", { name: "Save name" }).click();
  await page.getByRole("button", { name: renamed, exact: true }).click();

  const folder = (await (await page.request.get("/api/folders")).json()).folders.find(({ name }) => name === renamed);
  const target = await createFolder(page.request, baseURL, "Archive", folder.id);
  const bytes = await readFile(path.join(step3Fixtures, "sample.pdf"));
  await expect(page.locator('input[name="file"]')).toBeEnabled();
  await page.locator('input[name="file"]').setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: bytes });
  const upload = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/files");
  await page.getByRole("button", { name: "Upload file" }).click();
  const uploadResponse = await upload;
  expect(uploadResponse.status()).toBe(201);
  const { file } = await uploadResponse.json();
  expect(file.folderId).toBe(folder.id);
  expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

  await page.getByRole("button", { name: "Rename report.pdf", exact: true }).click();
  await page.getByRole("textbox", { name: "New name" }).fill("quarterly-report.pdf");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("link", { name: "Download quarterly-report.pdf" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: renamed, exact: true }).click();
  await page.getByRole("button", { name: "Move quarterly-report.pdf", exact: true }).click();
  await page.getByLabel("Destination folder").selectOption(target.id);
  await page.getByRole("button", { name: "Move item" }).click();
  await expect(page.getByRole("link", { name: "Download quarterly-report.pdf" })).toHaveCount(0);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download quarterly-report.pdf" }).click();
  const download = await downloadPromise;
  expect(await readFile(await download.path())).toEqual(bytes);
});

test("an owner can move folders while foreign folders and cyclic moves are rejected", async ({ page, browser, baseURL }) => {
  await signIn(page, "alice");
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
  const prefix = randomUUID().slice(0, 8);
  const left = await createFolder(page.request, baseURL, `Parent ${prefix}`);
  const right = await createFolder(page.request, baseURL, `Destination ${prefix}`);
  const child = await createFolder(page.request, baseURL, "Child", left.id);

  const options = (parentId) => ({ headers: { origin: baseURL }, data: { parentId } });
  expect((await page.request.patch(`/api/folders/${left.id}`, options(child.id))).status()).toBe(400);
  const moved = await page.request.patch(`/api/folders/${child.id}`, options(right.id));
  expect(moved.status()).toBe(200);
  expect((await moved.json()).folder.parentId).toBe(right.id);

  const reciprocal = await Promise.all([
    page.request.patch(`/api/folders/${left.id}`, options(right.id)),
    page.request.patch(`/api/folders/${right.id}`, options(left.id)),
  ]);
  expect(reciprocal.map((response) => response.status()).sort()).toEqual([200, 400]);

  const peerContext = await browser.newContext({ baseURL });
  try {
    const peer = await peerContext.newPage();
    await signIn(peer, "casey");
    await expect(peer.getByRole("heading", { name: "My files" })).toBeVisible();
    const peerFolders = await peerContext.request.get("/api/folders");
    expect((await peerFolders.json()).folders.some(({ id }) => id === right.id)).toBe(false);
    expect((await peerContext.request.get(`/api/files?folderId=${right.id}`)).status()).toBe(404);
    expect((await peerContext.request.patch(`/api/folders/${child.id}`, options(null))).status()).toBe(404);
    expect((await peerContext.request.post("/api/folders", {
      headers: { origin: baseURL },
      data: { name: "Foreign folder", parentId: child.id },
    })).status()).toBe(404);
    const sample = await readFile(path.join(step3Fixtures, "sample.pdf"));
    expect((await sendUpload(peerContext.request, baseURL, sample, "foreign.pdf", { folderId: right.id })).status()).toBe(404);
  } finally {
    await peerContext.close();
  }
});

test("approved file formats are recognized from bytes and blocked files give reasons", async ({ page, baseURL }) => {
  await signIn(page, "bob");
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
  const folder = await createFolder(page.request, baseURL, `Formats ${randomUUID().slice(0, 8)}`);
  for (const name of ["sample.jpg", "sample.pdf", "sample.docx", "sample.xlsx", "sample.pptx"]) {
    const bytes = await readFile(path.join(step3Fixtures, name));
    const upload = await sendUpload(page.request, baseURL, bytes, name, { folderId: folder.id });
    expect(upload.status(), name).toBe(201);
    const { file } = await upload.json();
    const download = await page.request.get(`/api/files/${file.id}/download`);
    expect(download.status(), name).toBe(200);
    expect(await download.body(), name).toEqual(bytes);
  }
  const png = await readFile(fixturePath);
  for (const name of ["blocked.exe", "wrong-content.pdf"]) {
    const upload = await sendUpload(page.request, baseURL, png, name, { folderId: folder.id });
    expect(upload.status()).toBe(415);
    expect((await upload.json()).message).toMatch(/file|upload/i);
  }
  const pdf = await readFile(path.join(step3Fixtures, "sample.pdf"));
  const miscount = await sendUpload(page.request, baseURL, pdf, "incomplete.pdf", { folderId: folder.id, size: pdf.length + 1 });
  expect(miscount.status()).toBe(400);
  const listed = await page.request.get(`/api/files?folderId=${folder.id}`);
  expect((await listed.json()).files).toHaveLength(5);
});

test("configured byte limits and concurrent quota reservations are enforced", async ({ page, baseURL }) => {
  test.skip(process.env.STEP3_VERIFY_LIMITS !== "1", "Requires a disposable stack with the CI-size limits.");
  await signIn(page, "priya");
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
  const policy = async () => (await page.request.get("/api/files/policy")).json();
  const initial = await policy();
  expect(initial.maxFileBytes).toBe(8192);
  expect(initial.quotaBytes).toBe(32768);
  expect(initial.usedBytes).toBe(0);

  const sample = await readFile(path.join(step3Fixtures, "sample.pdf"));
  const padded = (size) => Buffer.concat([sample, Buffer.alloc(size - sample.length, 32)]);
  const atLimit = padded(initial.maxFileBytes);
  const overLimit = padded(initial.maxFileBytes + 1);
  expect((await sendUpload(page.request, baseURL, overLimit, "over-limit.pdf")).status()).toBe(413);
  const actualOverLimit = await page.request.post("/api/files", {
    headers: { origin: baseURL },
    multipart: { file: { name: "stream-over-limit.pdf", mimeType: "application/pdf", buffer: overLimit } },
  });
  expect(actualOverLimit.status()).toBe(413);
  for (let copy = 0; copy < 3; copy++) {
    const response = await sendUpload(page.request, baseURL, atLimit, `exact-${copy}.pdf`);
    expect(response.status()).toBe(201);
  }
  const outcomes = await Promise.all([
    sendUpload(page.request, baseURL, atLimit, "quota-a.pdf"),
    sendUpload(page.request, baseURL, atLimit, "quota-b.pdf"),
  ]);
  expect(outcomes.map((response) => response.status()).sort()).toEqual([201, 409]);
  const final = await policy();
  expect(final.usedBytes).toBe(32768);
  expect(final.availableBytes).toBe(0);
});
