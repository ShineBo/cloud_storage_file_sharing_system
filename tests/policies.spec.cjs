const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const day = 86_400_000;
const pdfType = "application/pdf";
const pngType = "image/png";
const fixtureProject = process.env.COMPOSE_PROJECT_NAME ?? "";

test.skip(process.env.STEP7_DB_CHECK !== "1" || !/^cloud-step7-[a-z\d-]+$/.test(fixtureProject),
  "Requires STEP7_DB_CHECK=1 and an isolated cloud-step7-* Compose project.");

test.beforeAll(async ({ request }) => {
  test.setTimeout(60_000);
  await expect.poll(async () => {
    const response = await request.get("/api/auth/login", { maxRedirects: 0, timeout: 7_000 });
    return response.status() === 302 && response.headers().location?.includes("/protocol/openid-connect/auth?");
  }, { timeout: 45_000, message: "Wait for local sign-in" }).toBe(true);
});

async function signIn(context, username) {
  const password = process.env.CLASS_FIXTURE_PASSWORD;
  if (!password) throw new Error("Run npm run local:configure before testing the local realm.");
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  const heading = username === "it-admin" ? "Operations console"
    : username === "security-reviewer" ? "Security activity" : "My files";
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  return page;
}

async function policy(request) {
  const response = await request.get("/api/admin/policy");
  expect(response.status()).toBe(200);
  return (await response.json()).policy;
}

async function accounts(request) {
  const response = await request.get("/api/admin/accounts");
  expect(response.status()).toBe(200);
  return (await response.json()).accounts;
}

async function viewer(request) {
  const response = await request.get("/api/auth/me");
  expect(response.status()).toBe(200);
  return (await response.json()).user;
}

function upload(request, headers, bytes, type, endpoint = "/api/files") {
  const name = `Policy fixture ${randomUUID().slice(0, 8)}.${type === pdfType ? "pdf" : "png"}`;
  return request.post(`${endpoint}${endpoint.includes("?") ? "&" : "?"}size=${bytes.length}`, {
    headers, multipart: { file: { name, mimeType: type, buffer: bytes } },
  });
}

async function share(request, headers, file, recipientId) {
  const response = await request.post("/api/shares", {
    headers,
    data: { itemType: "file", itemId: file.id, recipientType: "employee", recipientId,
      permission: "view", allowDownload: true, requestId: randomUUID() },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).share;
}

async function trash(request, headers, itemType, itemId) {
  const response = await request.post("/api/trash", { headers, data: { itemType, itemId } });
  expect(response.status()).toBe(201);
  return (await response.json()).item;
}

async function audit(request, itemId) {
  const query = itemId ? `&itemId=${encodeURIComponent(itemId)}` : "";
  const response = await request.get(`/api/audit?limit=200${query}`);
  expect(response.status()).toBe(200);
  return (await response.json()).events;
}

test("IT can save policy in the browser and enforce type, quota, link and retention settings", async ({
  browser, request, baseURL,
}) => {
  test.setTimeout(85_000);
  const [admin, owner, reviewer] = await Promise.all(["it-admin", "casey", "security-reviewer"]
    .map(() => browser.newContext({ baseURL })));
  const headers = { origin: baseURL };
  let original;
  try {
    const [adminPage] = await Promise.all([
      signIn(admin, "it-admin"), signIn(owner, "casey"), signIn(reviewer, "security-reviewer"),
    ]);
    original = await policy(admin.request);
    expect(original.allowedMimeTypes).toContain(pdfType);
    expect(original.allowedMimeTypes).toContain(pngType);
    expect((await request.get("/api/admin/policy")).status()).toBe(401);
    expect((await reviewer.request.get("/api/admin/policy")).status()).toBe(403);
    const denied = await owner.request.patch("/api/admin/policy", {
      headers, data: { version: original.version, linkExpiryDays: 2 },
    });
    expect(denied.status()).toBe(403);
    expect((await admin.request.patch("/api/admin/policy", {
      data: { version: original.version, linkExpiryDays: 2 },
    })).status()).toBe(403);
    expect((await admin.request.patch("/api/admin/policy", {
      headers, data: { version: original.version, allowedMimeTypes: ["application/x-msdownload"] },
    })).status()).toBe(400);

    const pdfBytes = await readFile(path.join(__dirname, "fixtures/sample.pdf"));
    const pngBytes = await readFile(path.join(__dirname, "../fixtures/files/handover-v1.png"));
    const uploaded = await upload(owner.request, headers, pdfBytes, pdfType);
    expect(uploaded.status()).toBe(201);
    const { file } = await uploaded.json();
    const directory = await owner.request.get("/api/shares/recipients");
    const { employees } = await directory.json();
    const bob = employees.find(({ username }) => username === "bob");
    const oldShare = await share(owner.request, headers, file, bob.id);
    const folder = await owner.request.post("/api/folders", {
      headers, data: { name: `Retention ${randomUUID().slice(0, 8)}` },
    });
    expect(folder.status()).toBe(201);
    const oldTrash = await trash(owner.request, headers, "folder", (await folder.json()).folder.id);
    const used = (await (await owner.request.get("/api/files/policy")).json()).usedBytes;
    const quota = used + pdfBytes.length;
    expect(quota).toBeLessThan(original.quotaBytes);

    await adminPage.goto("/admin");
    await adminPage.getByRole("button", { name: "Check now", exact: true }).click();
    await expect(adminPage.getByText("Responding", { exact: true })).toBeVisible();
    await expect(adminPage.getByText("Ready", { exact: true })).toBeVisible();
    const pdf = adminPage.getByRole("checkbox", { name: "PDF", exact: true });
    await expect(pdf).toBeChecked();
    await pdf.uncheck();
    await adminPage.getByLabel("Storage quota in bytes", { exact: true }).fill(String(quota));
    await adminPage.getByLabel("Share link lifetime in days", { exact: true }).fill("9");
    await adminPage.getByLabel("Trash recovery window in days", { exact: true }).fill("7");
    const saved = adminPage.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/admin/policy" && response.request().method() === "PATCH",
    );
    await adminPage.getByRole("button", { name: "Save policy", exact: true }).click();
    const updated = await saved;
    expect(updated.status()).toBe(200);
    const next = (await updated.json()).policy;
    expect(next).toMatchObject({ quotaBytes: quota, linkExpiryDays: 9, retentionDays: 7, version: original.version + 1 });
    expect(next.allowedMimeTypes).not.toContain(pdfType);
    expect((await admin.request.patch("/api/admin/policy", {
      headers, data: { version: original.version, linkExpiryDays: 5 },
    })).status()).toBe(409);

    const oldDownload = await owner.request.get(`/api/files/${file.id}/download`);
    expect(oldDownload.status()).toBe(200);
    expect(await oldDownload.body()).toEqual(pdfBytes);
    expect((await upload(owner.request, headers, pdfBytes, pdfType)).status()).toBe(415);
    expect((await upload(owner.request, headers, pdfBytes, pdfType,
      `/api/files/${file.id}/revisions?baseRevision=1`)).status()).toBe(415);
    const lastPng = await upload(owner.request, headers, pngBytes, pngType);
    expect(lastPng.status()).toBe(201);
    const newTrash = await trash(owner.request, headers, "file", (await lastPng.json()).file.id);
    expect((Date.parse(newTrash.restoreUntil) - Date.parse(newTrash.deletedAt)) / day).toBeCloseTo(7, 4);
    for (let filled = pngBytes.length; filled + pngBytes.length <= pdfBytes.length; filled += pngBytes.length) {
      expect((await upload(owner.request, headers, pngBytes, pngType)).status()).toBe(201);
    }
    expect((await upload(owner.request, headers, pngBytes, pngType)).status()).toBe(409);

    const freshShare = await share(owner.request, headers, file, bob.id);
    expect((Date.parse(freshShare.expiresAt) - Date.now()) / day).toBeCloseTo(9, 2);
    const ownedShares = await owner.request.get(`/api/shares?itemType=file&itemId=${file.id}`);
    expect((await ownedShares.json()).shares.find(({ id }) => id === oldShare.id).expiresAt).toBe(oldShare.expiresAt);
    const trashList = await owner.request.get("/api/trash");
    expect((await trashList.json()).items.find(({ id }) => id === oldTrash.id).restoreUntil).toBe(oldTrash.restoreUntil);

    const operator = await viewer(admin.request);
    const employee = await viewer(owner.request);
    const changes = (await audit(reviewer.request)).filter(({ action }) => action === "policy.update");
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: operator.id, outcome: "success", detail: { changes: {
        allowedMimeTypes: { from: original.allowedMimeTypes, to: next.allowedMimeTypes },
        quotaBytes: { from: original.quotaBytes, to: quota },
        linkExpiryDays: { from: original.linkExpiryDays, to: 9 },
        retentionDays: { from: original.retentionDays, to: 7 },
      } } }),
      expect.objectContaining({ actorId: employee.id, outcome: "denied", status: 403 }),
      expect.objectContaining({ actorId: operator.id, outcome: "denied", status: 409 }),
    ]));
  } finally {
    try {
      if (original) {
        const current = await policy(admin.request);
        if (original.version !== current.version) {
          const { version: _, capacityBytes: _capacity, ...settings } = original;
          const response = await admin.request.patch("/api/admin/policy", {
            headers, data: { ...settings, version: current.version },
          });
          expect(response.status()).toBe(200);
        }
      }
    } finally {
      await Promise.all([admin, owner, reviewer].map((context) => context.close()));
    }
  }
});

test("IT suspension invalidates old sessions and leaves directory eligibility and reviewer access distinct", async ({
  browser, baseURL,
}) => {
  test.setTimeout(75_000);
  const contexts = await Promise.all(["it-admin", "casey", "security-reviewer", "casey"]
    .map(() => browser.newContext({ baseURL })));
  const [admin, employee, reviewer, fresh] = contexts;
  const headers = { origin: baseURL };
  let target;
  let suspended = false;
  const change = (id, active) => admin.request.patch(`/api/admin/accounts/${id}`, { headers, data: { active } });
  try {
    await Promise.all([signIn(admin, "it-admin"), signIn(employee, "casey"), signIn(reviewer, "security-reviewer")]);
    const candidates = await accounts(admin.request);
    target = candidates.find(({ username }) => username === "casey");
    const dana = candidates.find(({ username }) => username === "dana");
    const actor = await viewer(admin.request);
    expect(target).toMatchObject({ active: true, directoryEligible: true });
    expect(dana).toMatchObject({ active: false, directoryEligible: false });
    expect((await reviewer.request.get("/api/admin/accounts")).status()).toBe(403);
    expect((await reviewer.request.patch(`/api/admin/accounts/${target.id}`, {
      headers, data: { active: false },
    })).status()).toBe(403);
    expect((await change(actor.id, false)).status()).toBe(403);
    expect((await change(dana.id, true)).status()).toBe(409);

    const disabled = await change(target.id, false);
    expect(disabled.status()).toBe(200);
    suspended = true;
    expect((await disabled.json()).account.active).toBe(false);
    expect((await employee.request.get("/api/auth/me")).status()).toBe(401);
    expect((await employee.request.get("/api/files")).status()).toBe(401);
    const restored = await change(target.id, true);
    expect(restored.status()).toBe(200);
    suspended = false;
    expect((await restored.json()).account.active).toBe(true);
    expect((await employee.request.get("/api/auth/me")).status()).toBe(401);
    await signIn(fresh, "casey");
    expect((await viewer(fresh.request)).id).toBe(target.id);

    const accountEvents = (await audit(reviewer.request, target.id)).filter(({ action }) => action === "account.update");
    expect(accountEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: actor.id, itemType: "employee", outcome: "success",
        detail: { changes: { active: { from: true, to: false } } } }),
      expect.objectContaining({ actorId: actor.id, itemType: "employee", outcome: "success",
        detail: { changes: { active: { from: false, to: true } } } }),
      expect.objectContaining({ outcome: "denied", status: 403 }),
    ]));
  } finally {
    try {
      if (suspended && target) expect((await change(target.id, true)).status()).toBe(200);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  }
});
