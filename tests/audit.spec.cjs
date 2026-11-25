const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

test.beforeAll(async ({ request }) => {
  test.setTimeout(60_000);
  await expect.poll(async () => {
    const response = await request.get("/api/auth/login", { maxRedirects: 0, timeout: 7_000 });
    return response.status() === 302 && response.headers().location?.includes("/protocol/openid-connect/auth?");
  }, { timeout: 45_000, message: "Wait for Keycloak sign-in to be available" }).toBe(true);
});

async function signIn(context, username) {
  const password = process.env.CLASS_FIXTURE_PASSWORD;
  if (!password) throw new Error("Run npm run local:configure before using the local fixture realm.");

  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  const heading = username === "it-admin" ? "Operations console"
    : username === "security-reviewer" ? "Security activity" : "My files";
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  const response = await context.request.get("/api/auth/me");
  expect(response.status()).toBe(200);
  const { user } = await response.json();
  return user;
}

function signature({ action, actorId, outcome, status, revision }) {
  return JSON.stringify([action, actorId, outcome, status, revision]);
}

async function expectAudit(request, itemType, itemId, users, expected, earliest) {
  const response = await request.get(`/api/audit?itemId=${itemId}&limit=50`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const { events } = await response.json();
  expect(events.map(signature).sort()).toEqual(expected.map(signature).sort());
  expect(new Set(events.map(({ id }) => id)).size).toBe(events.length);

  const actorNames = new Map(users.map(({ id, displayName }) => [id, displayName]));
  for (const event of events) {
    expect(event.itemId).toBe(itemId);
    expect(event.itemType).toBe(itemType);
    expect(event.actorName).toBe(event.actorId === null ? null : actorNames.get(event.actorId));
    expect(Date.parse(event.occurredAt)).toBeGreaterThanOrEqual(earliest - 5_000);
    expect(Date.parse(event.occurredAt)).toBeLessThanOrEqual(Date.now() + 5_000);
  }
  return events;
}

function record(action, actor, outcome, status, revision = null) {
  return { action, actorId: actor?.id ?? null, outcome, status, revision };
}

test("a security reviewer sees one attributable record per workflow action, including denied access and safe retries", async ({
  browser, request, baseURL,
}) => {
  test.setTimeout(75_000);
  const usernames = ["it-admin", "priya", "casey", "security-reviewer"];
  const contexts = await Promise.all(usernames.map(() => browser.newContext({ baseURL })));
  const [ownerContext, editorContext, outsiderContext, reviewerContext] = contexts;
  try {
    const [owner, editor, outsider, reviewer] = await Promise.all(
      contexts.map((context, index) => signIn(context, usernames[index])),
    );
    const users = [owner, editor, outsider, reviewer];
    const origin = { origin: baseURL };
    const earliest = Date.now();

    const folderResponse = await ownerContext.request.post("/api/folders", {
      headers: origin, data: { name: `Audit folder ${randomUUID()}` },
    });
    expect(folderResponse.status()).toBe(201);
    const { folder } = await folderResponse.json();

    const changed = await ownerContext.request.patch(`/api/folders/${folder.id}`, {
      headers: origin, data: { name: `${folder.name} renamed` },
    });
    expect(changed.status()).toBe(200);
    const denied = await outsiderContext.request.patch(`/api/folders/${folder.id}`, {
      headers: origin, data: { name: "Wrong owner" },
    });
    expect(denied.status()).toBe(404);
    const newest = await reviewerContext.request.get(`/api/audit?searchId=${folder.id}&limit=1`);
    expect(newest.status()).toBe(200);
    const { events: firstPage } = await newest.json();
    expect(firstPage).toHaveLength(1);
    const cursor = newest.headers()["x-audit-next-cursor"];
    expect(cursor).toBe(firstPage[0].id);
    const older = await reviewerContext.request.get(`/api/audit?searchId=${folder.id}&limit=1&after=${cursor}`);
    expect(older.status()).toBe(200);
    const { events: secondPage } = await older.json();
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0].id).not.toBe(cursor);
    const activity = reviewerContext.pages()[0];
    await activity.getByRole("searchbox", { name: "Search by ID" }).fill(folder.id);
    await activity.getByLabel("Outcome", { exact: true }).selectOption("denied");
    await activity.getByRole("button", { name: "Apply filters" }).click();
    await expect(activity.getByRole("listitem").filter({ hasText: "Denied" })).toHaveCount(1);


    const fixturePath = (revision) => path.join(__dirname, "..", "fixtures", "files", `handover-v${revision}.png`);
    const [firstBytes, nextBytes] = await Promise.all([readFile(fixturePath(1)), readFile(fixturePath(2))]);
    const filename = `Audit sample ${randomUUID().slice(0, 8)}.png`;
    const transfer = (buffer) => ({ headers: origin, multipart: { file: { name: filename, mimeType: "image/png", buffer } } });
    const uploaded = await ownerContext.request.post(
      `/api/files?folderId=${folder.id}&size=${firstBytes.length}`,
      transfer(firstBytes),
    );
    expect(uploaded.status()).toBe(201);
    const { file } = await uploaded.json();

    const shareRequest = {
      itemType: "file", itemId: file.id, recipientType: "employee", recipientId: editor.id,
      permission: "edit", allowDownload: true, requestId: randomUUID(),
    };
    const createShare = () => ownerContext.request.post("/api/shares", { headers: origin, data: shareRequest });
    const shares = await Promise.all([createShare(), createShare()]);
    for (const response of shares) expect(response.status()).toBe(201);
    const [{ share }, { share: replay }] = await Promise.all(shares.map((response) => response.json()));
    expect(replay.id).toBe(share.id);

    const filePath = `/api/shared/${share.id}/files/${file.id}`;
    const view = await editorContext.request.get(`${filePath}/view`);
    expect(view.status()).toBe(200);
    expect(await view.body()).toEqual(firstBytes);
    expect((await outsiderContext.request.get(`${filePath}/view`)).status()).toBe(404);
    expect((await request.get(`${filePath}/view`)).status()).toBe(401);
    expect((await outsiderContext.request.get(`${filePath}/download`)).status()).toBe(404);

    const editUrl = `${filePath}/revisions?baseRevision=1&size=${nextBytes.length}`;
    expect((await outsiderContext.request.post(editUrl, transfer(nextBytes))).status()).toBe(404);
    const revised = await editorContext.request.post(editUrl, transfer(nextBytes));
    expect(revised.status()).toBe(201);
    expect((await revised.json()).file.revision).toBe(2);
    expect((await editorContext.request.post(editUrl, transfer(nextBytes))).status()).toBe(409);

    const download = await editorContext.request.get(`${filePath}/download`);
    expect(download.status()).toBe(200);
    expect(await download.body()).toEqual(nextBytes);

    const revokeUrl = `/api/shares/${share.id}/revoke`;
    expect((await ownerContext.request.post(revokeUrl, { headers: origin })).status()).toBe(200);
    expect((await ownerContext.request.post(revokeUrl, { headers: origin })).status()).toBe(200);
    expect((await editorContext.request.get(`${filePath}/view`)).status()).toBe(410);

    expect((await ownerContext.request.get(`/api/audit?itemId=${file.id}`)).status()).toBe(403);
    expect((await request.get(`/api/audit?itemId=${file.id}`)).status()).toBe(401);

    const fileEvents = await expectAudit(reviewerContext.request, "file", file.id, users, [
      record("upload", owner, "success", 201, 1),
      record("share.create", owner, "success", 201),
      record("view", editor, "success", 200, 1),
      record("view", outsider, "denied", 404),
      record("view", null, "denied", 401),
      record("download", outsider, "denied", 404),
      record("edit", outsider, "denied", 404, 1),
      record("edit", editor, "success", 201, 2),
      record("edit", editor, "denied", 409, 1),
      record("download", editor, "success", 200, 2),
      record("share.revoke", owner, "success", 200),
      record("view", editor, "denied", 410),
    ], earliest);
    expect(JSON.stringify(fileEvents)).not.toContain(share.id);
    expect(JSON.stringify(fileEvents)).not.toContain(filename);

    await expectAudit(reviewerContext.request, "folder", folder.id, users, [
      record("folder.create", owner, "success", 201),
      record("folder.update", owner, "success", 200),
      record("folder.update", outsider, "denied", 404),
    ], earliest);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
