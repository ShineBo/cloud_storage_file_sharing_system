const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { expect, test } = require("@playwright/test");

const exec = promisify(execFile);
const fixture = path.resolve(__dirname, "../fixtures/files/handover-v1.png");

test.beforeAll(async ({ request }) => {
  test.setTimeout(60_000);
  await expect.poll(async () => {
    const response = await request.get("/api/auth/login", { maxRedirects: 0, timeout: 7000 });
    return response.status() === 302 && response.headers().location?.includes("/protocol/openid-connect/auth?");
  }, { timeout: 45_000, message: "Wait for local sign-in" }).toBe(true);
});

async function signIn(page, username) {
  const password = process.env.CLASS_FIXTURE_PASSWORD;
  if (!password) throw new Error("Run npm run local:configure before testing the local fixture realm.");
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  const heading = username === "it-admin" ? "Operations console"
    : username === "security-reviewer" ? "Security activity" : "My files";
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

async function createFolder(request, headers, name, parentId = null) {
  const response = await request.post("/api/folders", { headers, data: { name, parentId } });
  expect(response.status()).toBe(201);
  return (await response.json()).folder;
}

async function upload(request, headers, name, bytes, folderId) {
  const query = new URLSearchParams({ size: String(bytes.length) });
  if (folderId) query.set("folderId", folderId);
  const response = await request.post(`/api/files?${query}`, {
    headers, multipart: { file: { name, mimeType: "image/png", buffer: bytes } },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).file;
}

async function share(request, headers, itemType, itemId, recipientId) {
  const response = await request.post("/api/shares", {
    headers,
    data: { itemType, itemId, recipientType: "employee", recipientId, permission: "view",
      allowDownload: true, requestId: randomUUID() },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).share;
}

async function trash(request, headers, itemType, itemId) {
  const response = await request.post("/api/trash", { headers, data: { itemType, itemId } });
  expect(response.status()).toBe(201);
  return (await response.json()).item;
}

async function expectUnavailable(response) {
  expect([404, 410]).toContain(response.status());
  expect(response.headers()["content-disposition"]).toBeUndefined();
  expect(await response.json()).not.toHaveProperty("file");
}

test("trash hides a subtree and both share paths, preserves quota, and restores original bytes", async ({
  page, browser, baseURL,
}) => {
  test.setTimeout(80_000);
  const peer = await browser.newContext({ baseURL });
  const reviewer = await browser.newContext({ baseURL });
  try {
    await Promise.all([
      signIn(page, "alice"),
      signIn(await peer.newPage(), "bob"),
      signIn(await reviewer.newPage(), "security-reviewer"),
    ]);
    const headers = { origin: baseURL };
    const suffix = randomUUID().slice(0, 8);
    const parent = await createFolder(page.request, headers, `Trash example ${suffix}`);
    const child = await createFolder(page.request, headers, `Child ${suffix}`, parent.id);
    const bytes = await readFile(fixture);
    const file = await upload(page.request, headers, `Retained-${suffix}.png`, bytes, child.id);
    const separate = await upload(page.request, headers, `Separate-${suffix}.png`, bytes, child.id);
    const { employees } = await (await page.request.get("/api/shares/recipients")).json();
    const bob = employees.find(({ username }) => username === "bob");
    const folderShare = await share(page.request, headers, "folder", parent.id, bob.id);
    const fileShare = await share(page.request, headers, "file", file.id, bob.id);
    const directDownload = `/api/shared/${fileShare.id}/files/${file.id}/download`;
    const inheritedDownload = `/api/shared/${folderShare.id}/files/${file.id}/download`;
    const usage = async () => (await (await page.request.get("/api/files/policy")).json()).usedBytes;
    const originalUsage = await usage();
    for (const download of [directDownload, inheritedDownload]) {
      const response = await peer.request.get(download);
      expect(response.status()).toBe(200);
      expect(await response.body()).toEqual(bytes);
    }
    const independent = await trash(page.request, headers, "file", separate.id);
    const deniedRemoval = await peer.request.post("/api/trash", {
      headers, data: { itemType: "file", itemId: file.id },
    });
    expect(deniedRemoval.status()).toBe(404);

    await page.reload();
    await page.getByLabel(`More actions for ${parent.name}`, { exact: true }).click();
    await page.getByRole("button", { name: `Move ${parent.name} to trash`, exact: true }).click();
    await page.getByRole("dialog", { name: "Move to trash" }).getByRole("button", { name: "Move to trash" }).click();
    await expect(page.getByRole("button", { name: parent.name, exact: true })).toHaveCount(0);
    const listing = await page.request.get("/api/trash");
    expect(listing.status()).toBe(200);
    const { items } = await listing.json();
    const archived = items.find(({ itemId }) => itemId === parent.id);
    expect(archived).toMatchObject({ itemType: "folder", canRestore: true });
    expect(Date.parse(archived.restoreUntil)).toBeGreaterThan(Date.parse(archived.deletedAt));
    const replay = await trash(page.request, headers, "folder", parent.id);
    expect(replay.id).toBe(archived.id);
    expect(await usage()).toBe(originalUsage);
    const peerTrash = (await (await peer.request.get("/api/trash")).json()).items;
    expect(peerTrash.some(({ id }) => id === archived.id)).toBe(false);
    expect((await peer.request.post(`/api/trash/${archived.id}/restore`, { headers })).status()).toBe(404);
    expect((await page.request.post(`/api/trash/${independent.id}/restore`, { headers })).status()).toBe(409);
    for (const pathname of [directDownload, inheritedDownload, `/api/shared/${folderShare.id}`]) {
      await expectUnavailable(await peer.request.get(pathname));
    }
    await expectUnavailable(await page.request.get(`/api/files/${file.id}/download`));
    const collision = await createFolder(page.request, headers, parent.name);
    const conflict = await page.request.post(`/api/trash/${archived.id}/restore`, { headers });
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).message).toMatch(/name exists/i);
    const renamed = await page.request.patch(`/api/folders/${collision.id}`, {
      headers, data: { name: `Other ${collision.name}` },
    });
    expect(renamed.status()).toBe(200);

    await page.getByRole("link", { name: "Trash", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: parent.name });
    await row.getByRole("button", { name: /^Restore/ }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByText(separate.name, { exact: true })).toBeVisible();
    const downloaded = await peer.request.get(inheritedDownload);
    expect(downloaded.status()).toBe(200);
    expect(await downloaded.body()).toEqual(bytes);
    expect((await peer.request.get(directDownload)).status()).toBe(200);
    await expectUnavailable(await page.request.get(`/api/files/${separate.id}/download`));
    expect(await usage()).toBe(originalUsage);

    const activity = await reviewer.request.get(`/api/audit?itemId=${parent.id}&limit=30`);
    expect(activity.status()).toBe(200);
    const { events } = await activity.json();
    expect(events.filter(({ action }) => action === "item.delete")).toMatchObject([
      { itemId: parent.id, actorName: "Alice Example", outcome: "success", status: 201 },
    ]);
    expect(events.filter(({ action }) => action === "item.restore")).toMatchObject([
      { itemId: parent.id, actorName: "Alice Example", outcome: "success", status: 200 },
      { itemId: parent.id, actorName: "Alice Example", outcome: "denied", status: 409 },
    ]);
  } finally {
    await Promise.all([peer.close(), reviewer.close()]);
  }
});

test("the stored recovery deadline blocks restore and retains the expired item for review", async ({ page, baseURL }) => {
  test.skip(process.env.STEP7_DB_CHECK !== "1", "Requires a separate disposable Compose project and local PostgreSQL.");
  test.setTimeout(50_000);
  const project = process.env.COMPOSE_PROJECT_NAME;
  if (!project || !/^cloud-step7-[a-z0-9-]+$/.test(project)) {
    throw new Error("STEP7_DB_CHECK requires a disposable COMPOSE_PROJECT_NAME starting with cloud-step7-.");
  }
  await signIn(page, "security-reviewer");
  const headers = { origin: baseURL };
  const bytes = await readFile(fixture);
  const file = await upload(page.request, headers, `Expired-${randomUUID().slice(0, 8)}.png`, bytes);
  const deleted = await trash(page.request, headers, "file", file.id);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(deleted.id)) throw new Error("Invalid trash fixture id.");
  const { stdout } = await exec("docker", [
    "compose", "-p", project, "-f", "compose.yaml", "exec", "-T", "db",
    "psql", "-v", "ON_ERROR_STOP=1", "-U", "cloud_storage", "-d", "cloud_storage", "-c",
    `UPDATE trash_entries SET deleted_at = clock_timestamp() - interval '2 days',
      restore_until = clock_timestamp() - interval '1 second' WHERE id = '${deleted.id}'`,
  ], { timeout: 15_000 });
  expect(stdout).toContain("UPDATE 1");
  const expired = await page.request.post(`/api/trash/${deleted.id}/restore`, { headers });
  expect(expired.status()).toBe(410);
  expect((await expired.json()).message).toMatch(/recovery window has ended/i);
  const { items } = await (await page.request.get("/api/trash")).json();
  expect(items.find(({ id }) => id === deleted.id)).toMatchObject({ itemId: file.id, canRestore: false });
  await expectUnavailable(await page.request.get(`/api/files/${file.id}/download`));
  const { events } = await (await page.request.get(`/api/audit?itemId=${file.id}`)).json();
  expect(events.filter(({ action }) => action === "item.restore")).toMatchObject([
    { itemId: file.id, actorName: "Security Reviewer", outcome: "denied", status: 410 },
  ]);
});
