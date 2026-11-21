const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

const fixturePath = path.resolve(__dirname, "../fixtures/files/handover-v1.png");

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
