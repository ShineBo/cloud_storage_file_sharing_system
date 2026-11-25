import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { chromium } from "@playwright/test";

const origin = "http://localhost:3088";
const assets = new URL("../fixtures/demo/", import.meta.url);
const env = parseEnv(await readFile(new URL("../.env.demo", import.meta.url), "utf8"));
if (env.CLASS_APP_ORIGIN !== origin) throw new Error("Load the local Northstar demo configuration first.");

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
try {
  const owner = await signIn("maya", "/files");
  const actor = owner.request;
  const survey = await ensureFolder(actor, "Riverside Site Survey");
  const archive = await ensureFolder(actor, "Completed Work");
  const brief = await ensureFile(actor, survey, "Survey workspace/Riverside Site Survey Brief.pdf");
  await ensureFile(actor, survey, "Survey workspace/Field Safety Checklist.pdf");

  const directory = await read(actor, "/api/shares/recipients");
  const leo = directory.employees.find(({ username }) => username === "leo");
  const team = directory.groups.find(({ name }) => name === "Riverside Site Team");
  if (!leo || !team) throw new Error("The Northstar demo directory is incomplete.");
  await ensureShare(actor, {
    itemType: "folder", itemId: survey, recipientType: "group", recipientId: team.id,
    permission: "view", allowDownload: false,
  });
  const editable = await ensureShare(actor, {
    itemType: "file", itemId: brief, recipientType: "employee", recipientId: leo.id,
    permission: "edit", allowDownload: true,
  });

  const trash = await read(actor, "/api/trash");
  const archivedName = "Crew Route Handover - archived.pdf";
  if (!trash.items.some(({ name }) => name === archivedName)) {
    const itemId = await ensureFile(actor, archive, "Spare uploads/Route Handover.pdf", archivedName);
    await write(actor, "/api/trash", { itemType: "file", itemId });
  }

  const editor = await signIn("leo", "/files");
  const received = await read(editor.request, "/api/shares/incoming");
  if (!received.shares.some(({ id }) => id === editable.id)) {
    throw new Error("Leo cannot see the pre-seeded revision link.");
  }
  const outsider = await signIn("jordan", "/files");
  const denied = await outsider.request.get(`/api/shared/${editable.id}/files/${brief}/view`);
  if (denied.status() !== 404) throw new Error("Jordan did not receive the expected access denial.");
  await editor.close();
  await outsider.close();
  await owner.close();
  console.log("Riverside folders, sample documents, two share grants, and recoverable Trash are ready.");
} finally {
  await browser.close();
}

async function signIn(username, destination) {
  const password = env[`DEMO_${username.toUpperCase()}_PASSWORD`];
  if (!password) throw new Error(`Demo credentials for ${username} are missing.`);
  const session = await browser.newContext({ baseURL: origin });
  const page = await session.newPage();
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await page.waitForURL(origin + destination);
  return session;
}

async function checked(response, path) {
  if (!response.ok()) throw new Error(`${path} failed with HTTP ${response.status()}.`);
  return response.json();
}

async function read(request, path) {
  return checked(await request.get(path), path);
}

async function write(request, path, data) {
  return checked(await request.post(path, { headers: { origin }, data }), path);
}

async function ensureFolder(request, name) {
  const { folders } = await read(request, "/api/folders");
  const existing = folders.find((folder) => folder.parentId === null && folder.name === name);
  return existing?.id ?? (await write(request, "/api/folders", { name })).folder.id;
}

async function ensureFile(request, folderId, asset, name = asset.split("/").at(-1)) {
  const path = `/api/files?folderId=${encodeURIComponent(folderId)}`;
  const { files } = await read(request, path);
  const existing = files.find((file) => file.name === name);
  if (existing) return existing.id;
  const bytes = await readFile(new URL(asset, assets));
  const response = await request.post(`${path}&size=${bytes.length}`, {
    headers: { origin },
    multipart: { file: { name, mimeType: "application/pdf", buffer: bytes } },
  });
  return (await checked(response, "/api/files")).file.id;
}

async function ensureShare(request, grant) {
  // The existing request key lets a second setup run reuse the original link.
  const hash = createHash("sha256").update(`${grant.itemId}:${grant.recipientId}:${grant.permission}`).digest("hex");
  const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return (await write(request, "/api/shares", { ...grant, requestId })).share;
}
