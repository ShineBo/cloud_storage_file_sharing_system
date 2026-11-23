const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { expect, test } = require("@playwright/test");

const pdfPath = path.join(__dirname, "fixtures", "sample.pdf");
const composeFiles = ["compose.yaml", "compose.integrations.yaml", "compose.app.yaml"];
const exec = promisify(execFile);

test.beforeAll(async ({ request }) => {
  test.setTimeout(60_000);
  await expect.poll(async () => {
    const response = await request.get("/api/auth/login", { maxRedirects: 0, timeout: 7_000 });
    return response.status() === 302 && response.headers().location?.includes("/protocol/openid-connect/auth?");
  }, { timeout: 45_000, message: "Wait for Keycloak sign-in to be available" }).toBe(true);
});

async function signIn(page, username, pathname = "/") {
  const password = process.env.CLASS_FIXTURE_PASSWORD;
  if (!password) throw new Error("Run npm run local:configure before using the local fixture realm.");

  await page.goto(pathname);
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}

async function signInToWorkspace(page, username) {
  await signIn(page, username);
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
}

async function directory(request, baseURL) {
  const response = await request.get("/api/shares/recipients");
  expect(response.status()).toBe(200);
  const { employees, groups } = await response.json();
  expect(employees.map(({ username }) => username)).not.toContain("dana");
  expect(employees.map(({ username }) => username)).not.toContain("eve");
  const bob = employees.find(({ username }) => username === "bob");
  const team = groups.find(({ name }) => name === "Design Team");
  expect(bob).toBeDefined();
  expect(team).toBeDefined();
  return {
    bob,
    team,
    submit: (data) => request.post("/api/shares", { headers: { origin: baseURL }, data }),
  };
}

async function upload(request, origin, { folderId, fixture = pdfPath } = {}) {
  const bytes = await readFile(fixture);
  const name = `Shared ${randomUUID().slice(0, 8)}${path.extname(fixture)}`;
  const query = new URLSearchParams({ size: String(bytes.length) });
  if (folderId) query.set("folderId", folderId);
  const response = await request.post(`/api/files?${query}`, {
    headers: { origin },
    multipart: { file: { name, mimeType: "application/octet-stream", buffer: bytes } },
  });
  expect(response.status()).toBe(201);
  return { file: (await response.json()).file, bytes };
}

async function createFolder(request, origin, name, parentId = null) {
  const response = await request.post("/api/folders", { headers: { origin }, data: { name, parentId } });
  expect(response.status()).toBe(201);
  return (await response.json()).folder;
}

function employeeShare(file, employee, overrides = {}) {
  return {
    itemType: "file",
    itemId: file.id,
    recipientType: "employee",
    recipientId: employee.id,
    permission: "view",
    allowDownload: false,
    requestId: randomUUID(),
    ...overrides,
  };
}

async function granted(response) {
  expect(response.status()).toBe(201);
  const { share } = await response.json();
  expect(share.link).toBe(`/shared/${share.id}`);
  expect(share.revokedAt).toBeNull();
  return share;
}

function actionUrl(share, file, action) {
  return `/api/shared/${share.id}/files/${file.id}/${action}`;
}

function action(request, origin, share, file, name) {
  const url = actionUrl(share, file, name);
  return name === "edit"
    ? request.post(url, { headers: { origin } })
    : request.get(url);
}

async function assertDenied(response, status) {
  expect(response.status()).toBe(status);
  expect(response.headers()["content-disposition"]).toBeUndefined();
  expect(response.headers()["content-type"]).toContain("application/json");
  const body = await response.json();
  expect(body).not.toHaveProperty("item");
  expect(body).not.toHaveProperty("file");
  expect(body).not.toHaveProperty("entries");
}

test("owner creates a share in the browser, recipient signs in from the link, and revocation takes effect", async ({
  page, browser, baseURL,
}) => {
  await signInToWorkspace(page, "alice");
  const { file, bytes } = await upload(page.request, baseURL);
  await page.reload();
  await page.getByRole("button", { name: `Share ${file.name}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share item" });
  await dialog.getByLabel("Recipient", { exact: true }).selectOption({ label: "Bob Example (bob)" });
  await dialog.getByRole("checkbox", { name: "Allow download" }).check();
  await dialog.getByRole("button", { name: "Create link", exact: true }).click();
  const linkField = dialog.getByRole("textbox", { name: "Share link for Bob Example" });
  await expect(linkField).toHaveValue(/^https?:\/\/.+\/shared\/[\da-f-]+$/);
  const link = new URL(await linkField.inputValue());
  expect(link.origin).toBe(baseURL);
  await expect(dialog.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();

  const recipient = await browser.newContext({ baseURL });
  try {
    const recipientPage = await recipient.newPage();
    await signIn(recipientPage, "bob", link.pathname);
    await expect(recipientPage).toHaveURL(link.href);
    await expect(recipientPage.getByRole("heading", { name: file.name, exact: true })).toBeVisible();
    const preview = recipientPage.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/files/${file.id}/view`));
    await recipientPage.getByRole("button", { name: "Preview file", exact: true }).click();
    expect((await preview).status()).toBe(200);
    await expect(recipientPage.getByTitle(`Preview of ${file.name}`)).toBeVisible();
    const download = recipientPage.waitForEvent("download");
    await recipientPage.getByRole("link", { name: `Download ${file.name}`, exact: true }).click();
    const downloaded = await download;
    expect(downloaded.suggestedFilename()).toBe(file.name);
    expect(await readFile(await downloaded.path())).toEqual(bytes);

    const revoked = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/revoke"));
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    expect((await revoked).status()).toBe(200);
    const share = { id: link.pathname.split("/").at(-1) };
    await assertDenied(await recipient.request.get(actionUrl(share, file, "download")), 410);
    await recipientPage.reload();
    await expect(recipientPage.getByText(/revoked/i).first()).toBeVisible();
  } finally {
    await recipient.close();
  }
});

test("share creation validates owner, recipient, permission, and replay", async ({ page, browser, request, baseURL }) => {
  await signInToWorkspace(page, "alice");
  const { file } = await upload(page.request, baseURL);
  const { bob, submit } = await directory(page.request, baseURL);
  const body = employeeShare(file, bob);
  const shareList = () => page.request.get(`/api/shares?itemType=file&itemId=${file.id}`);

  await assertDenied(await request.post("/api/shares", { headers: { origin: baseURL }, data: body }), 401);
  await assertDenied(await page.request.post("/api/shares", {
    headers: { origin: "https://other.example.test" }, data: body,
  }), 403);
  for (const update of [
    { recipientId: randomUUID() },
    { recipientId: "eve@example.test" },
    { recipientType: "group", recipientId: randomUUID() },
    { permission: "owner" },
    { allowDownload: "yes" },
  ]) {
    await assertDenied(await submit({ ...body, ...update }), 400);
  }
  expect((await (await shareList()).json()).shares).toHaveLength(0);

  const shares = await Promise.all([submit(body), submit(body)]).then((responses) => Promise.all(responses.map(granted)));
  expect(shares[1].id).toBe(shares[0].id);
  expect(shares[1].expiresAt).toBe(shares[0].expiresAt);
  const lifetimeDays = (Date.parse(shares[0].expiresAt) - Date.now()) / 86_400_000;
  expect(lifetimeDays).toBeGreaterThan(29);
  expect(lifetimeDays).toBeLessThan(31);
  await assertDenied(await submit({ ...body, allowDownload: true }), 409);
  const { shares: listed } = await (await shareList()).json();
  expect(listed.map(({ id }) => id)).toEqual([shares[0].id]);

  const recipient = await browser.newContext({ baseURL });
  try {
    await signInToWorkspace(await recipient.newPage(), "bob");
    await assertDenied(await recipient.request.post("/api/shares", {
      headers: { origin: baseURL }, data: { ...body, requestId: randomUUID() },
    }), 404);
    await assertDenied(await recipient.request.get(`/api/shares?itemType=file&itemId=${file.id}`), 404);
    await assertDenied(await recipient.request.post(`/api/shares/${shares[0].id}/revoke`, {
      headers: { origin: baseURL },
    }), 404);
    expect((await recipient.request.get(`/api/shared/${shares[0].id}`)).status()).toBe(200);
  } finally {
    await recipient.close();
  }
});

test("live recipient and requested action must match the current individual grant", async ({
  page, request, browser, baseURL,
}) => {
  test.setTimeout(45_000);
  await signInToWorkspace(page, "alice");
  const { file, bytes } = await upload(page.request, baseURL);
  const { bob, submit } = await directory(page.request, baseURL);
  const recipient = await browser.newContext({ baseURL });
  const outsider = await browser.newContext({ baseURL });
  try {
    await Promise.all([
      signInToWorkspace(await recipient.newPage(), "bob"),
      signInToWorkspace(await outsider.newPage(), "casey"),
    ]);
    for (const permission of ["view", "edit"]) {
      for (const allowDownload of [false, true]) {
        const share = await granted(await submit(employeeShare(file, bob, { permission, allowDownload })));
        if (permission === "edit") {
          const foreignOrigin = await action(recipient.request, "https://other.example.test", share, file, "edit");
          await assertDenied(foreignOrigin, 403);
        }
        for (const name of ["view", "download", "edit"]) {
          await assertDenied(await action(request, baseURL, share, file, name), 401);
          await assertDenied(await action(outsider.request, baseURL, share, file, name), 404);
          const response = await action(recipient.request, baseURL, share, file, name);
          if (name === "download" && !allowDownload || name === "edit" && permission !== "edit") {
            await assertDenied(response, 403);
          } else {
            expect(response.status()).toBe(200);
            expect(response.headers()["cache-control"]).toContain("no-store");
            if (name === "edit") {
              expect((await response.json()).file.id).toBe(file.id);
            } else {
              expect(response.headers()["content-type"]).toContain("application/pdf");
              expect(response.headers()["content-disposition"]).toMatch(name === "view" ? /^inline/ : /^attachment/);
              expect(await response.body()).toEqual(bytes);
            }
          }
        }
      }
    }
    await assertDenied(await recipient.request.get(`/api/files/${file.id}/download`), 404);
  } finally {
    await Promise.all([recipient.close(), outsider.close()]);
  }
});

test("approved group receives only current folder descendants and the grant can be revoked", async ({
  page, browser, baseURL,
}) => {
  test.setTimeout(45_000);
  await signInToWorkspace(page, "alice");
  const root = await createFolder(page.request, baseURL, `Group ${randomUUID().slice(0, 8)}`);
  const nested = await createFolder(page.request, baseURL, "Nested", root.id);
  const sibling = await createFolder(page.request, baseURL, `Outside ${randomUUID().slice(0, 8)}`);
  const { file: inside, bytes } = await upload(page.request, baseURL, { folderId: nested.id });
  const { file: outside } = await upload(page.request, baseURL, { folderId: sibling.id });
  const { team, submit } = await directory(page.request, baseURL);
  const share = await granted(await submit({
    itemType: "folder", itemId: root.id, recipientType: "group", recipientId: team.id,
    permission: "view", allowDownload: true, requestId: randomUUID(),
  }));

  const members = await Promise.all(["bob", "priya"].map(() => browser.newContext({ baseURL })));
  const outsider = await browser.newContext({ baseURL });
  try {
    await Promise.all([
      ...members.map(async (context, index) => signInToWorkspace(await context.newPage(), ["bob", "priya"][index])),
      signInToWorkspace(await outsider.newPage(), "casey"),
    ]);
    await assertDenied(await outsider.request.get(`/api/shared/${share.id}`), 404);
    await assertDenied(await action(outsider.request, baseURL, share, inside, "download"), 404);
    for (const { request } of members) {
      const listing = await request.get(`/api/shared/${share.id}`);
      expect(listing.status()).toBe(200);
      expect((await listing.json()).entries.map(({ id }) => id)).toEqual([nested.id]);
      const child = await request.get(`/api/shared/${share.id}?folderId=${nested.id}`);
      expect(child.status()).toBe(200);
      expect((await child.json()).entries.map(({ id }) => id)).toEqual([inside.id]);
      const download = await action(request, baseURL, share, inside, "download");
      expect(download.status()).toBe(200);
      expect(await download.body()).toEqual(bytes);
      await assertDenied(await request.get(`/api/shared/${share.id}?folderId=${sibling.id}`), 404);
      await assertDenied(await action(request, baseURL, share, outside, "view"), 404);
      await assertDenied(await action(request, baseURL, share, inside, "edit"), 403);
    }

    const memberPage = members[0].pages()[0];
    await memberPage.goto(share.link);
    await memberPage.getByRole("button", { name: "Open Nested", exact: true }).click();
    await memberPage.getByRole("button", { name: `Open ${inside.name}`, exact: true }).click();
    await expect(memberPage.getByRole("heading", { name: inside.name, exact: true })).toBeVisible();

    const moved = await page.request.patch(`/api/files/${inside.id}`, {
      headers: { origin: baseURL }, data: { folderId: sibling.id },
    });
    expect(moved.status()).toBe(200);
    await assertDenied(await action(members[0].request, baseURL, share, inside, "download"), 404);
    const child = await members[0].request.get(`/api/shared/${share.id}?folderId=${nested.id}`);
    expect((await child.json()).entries).toEqual([]);

    const revoke = () => page.request.post(`/api/shares/${share.id}/revoke`, { headers: { origin: baseURL } });
    const first = await revoke();
    const replay = await revoke();
    expect(first.status()).toBe(200);
    expect(replay.status()).toBe(200);
    const { share: revoked } = await first.json();
    expect(revoked.revokedAt).toBeTruthy();
    expect((await replay.json()).share.revokedAt).toBe(revoked.revokedAt);
    await assertDenied(await members[0].request.get(`/api/shared/${share.id}`), 410);
  } finally {
    await Promise.all([...members.map((context) => context.close()), outsider.close()]);
  }
});

test("inactive and external identities do not enter a shared item during sign-in", async ({ page, browser, baseURL }) => {
  await signInToWorkspace(page, "alice");
  const { file } = await upload(page.request, baseURL);
  const { bob, submit } = await directory(page.request, baseURL);
  const share = await granted(await submit(employeeShare(file, bob)));
  for (const username of ["dana", "eve"]) {
    const context = await browser.newContext({ baseURL });
    try {
      const deniedPage = await context.newPage();
      await signIn(deniedPage, username, share.link);
      await expect(deniedPage).toHaveURL(`${baseURL}${share.link}?auth=denied`);
      await assertDenied(await context.request.get(`/api/shared/${share.id}`), 401);
      await assertDenied(await action(context.request, baseURL, share, file, "view"), 401);
    } finally {
      await context.close();
    }
  }
});

test("an Office preview exposes rendered text without issuing a download grant", async ({ page, browser, baseURL }) => {
  await signInToWorkspace(page, "alice");
  const { file } = await upload(page.request, baseURL, { fixture: path.join(__dirname, "fixtures", "sample.docx") });
  const { bob, submit } = await directory(page.request, baseURL);
  const share = await granted(await submit(employeeShare(file, bob)));

  const recipient = await browser.newContext({ baseURL });
  try {
    const recipientPage = await recipient.newPage();
    await signIn(recipientPage, "bob", share.link);
    await expect(recipientPage.getByRole("heading", { name: file.name, exact: true })).toBeVisible();
    await expect(recipientPage.getByRole("link", { name: `Download ${file.name}`, exact: true })).toHaveCount(0);
    const previewResponse = recipientPage.waitForResponse((response) =>
      new URL(response.url()).pathname === actionUrl(share, file, "view"));
    await recipientPage.getByRole("button", { name: "Preview file", exact: true }).click();
    const preview = await previewResponse;
    expect(preview.status()).toBe(200);
    expect(preview.headers()["content-disposition"]).toBeUndefined();
    expect(preview.headers()["content-type"]).toContain("application/json");
    const { sections } = await preview.json();
    expect(sections.join(" ")).toContain("Sample document");
    await expect(recipientPage.getByText("Sample document", { exact: true })).toBeVisible();
    await assertDenied(await action(recipient.request, baseURL, share, file, "download"), 403);
  } finally {
    await recipient.close();
  }
});

function uuidLiteral(value) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) throw new Error("Expected a fixture UUID.");
  return `'${value}'::uuid`;
}

async function fixtureSql(sql) {
  const project = process.env.COMPOSE_PROJECT_NAME;
  if (!/^cloud-step[4-6]-[a-z\d-]+$/.test(project ?? "")) {
    throw new Error("STEP4_DB_CHECK requires a disposable COMPOSE_PROJECT_NAME starting with cloud-step4-, cloud-step5-, or cloud-step6-.");
  }
  const { stdout } = await exec("docker", [
    "compose", "-p", project, ...composeFiles.flatMap((name) => ["-f", name]),
    "exec", "-T", "db", "psql", "-XqAt", "-v", "ON_ERROR_STOP=1",
    "-U", "cloud_storage", "-d", "cloud_storage", "-c", sql,
  ], { timeout: 8000 });
  return stdout.trim();
}

test("expiry, directory deactivation, and membership removal deny an established session", async ({
  page, browser, baseURL,
}) => {
  test.skip(process.env.STEP4_DB_CHECK !== "1", "Requires a separate disposable Compose project and local PostgreSQL.");
  test.setTimeout(60_000);
  await signInToWorkspace(page, "alice");
  const { file } = await upload(page.request, baseURL);
  const { bob, team, submit } = await directory(page.request, baseURL);
  const employee = uuidLiteral(bob.id);
  const group = uuidLiteral(team.id);
  const direct = await granted(await submit(employeeShare(file, bob, { allowDownload: true })));
  const groupShare = await granted(await submit(employeeShare(file, team, {
    recipientType: "group", allowDownload: true,
  })));
  const recipient = await browser.newContext({ baseURL });
  let membershipRemoved = false;
  let inactive = false;
  try {
    await signInToWorkspace(await recipient.newPage(), "bob");
    expect((await action(recipient.request, baseURL, groupShare, file, "view")).status()).toBe(200);
    const dropped = await fixtureSql(`DELETE FROM internal_group_members WHERE group_id = ${group}
      AND employee_id = ${employee} RETURNING employee_id`);
    membershipRemoved = dropped === bob.id;
    expect(membershipRemoved).toBe(true);
    await assertDenied(await action(recipient.request, baseURL, groupShare, file, "download"), 404);
    expect((await action(recipient.request, baseURL, direct, file, "view")).status()).toBe(200);

    const disabled = await fixtureSql(`UPDATE employees SET active = false WHERE id = ${employee} RETURNING id`);
    inactive = disabled === bob.id;
    expect(inactive).toBe(true);
    await assertDenied(await action(recipient.request, baseURL, direct, file, "view"), 401);
    await assertDenied(await submit(employeeShare(file, bob)), 400);
    await fixtureSql(`UPDATE employees SET active = true WHERE id = ${employee}`);
    inactive = false;

    const expired = await fixtureSql(`UPDATE shares SET created_at = now() - interval '2 minutes',
      expires_at = now() - interval '1 minute' WHERE id = ${uuidLiteral(direct.id)} RETURNING id`);
    expect(expired).toBe(direct.id);
    for (const name of ["view", "download", "edit"]) {
      await assertDenied(await action(recipient.request, baseURL, direct, file, name), 410);
    }
  } finally {
    try {
      if (inactive) await fixtureSql(`UPDATE employees SET active = true WHERE id = ${employee}`);
      if (membershipRemoved) {
        await fixtureSql(`INSERT INTO internal_group_members (group_id, employee_id, issuer)
          SELECT id, ${employee}, issuer FROM internal_groups WHERE id = ${group} ON CONFLICT DO NOTHING`);
      }
    } finally {
      await recipient.close();
    }
  }
});
