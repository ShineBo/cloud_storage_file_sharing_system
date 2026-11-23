import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const FORMAT = "CSFSREC1";
const MAGIC = Buffer.from(FORMAT);
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES;
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export async function readArchiveKey(keyFile, protectedRoots = []) {
  if (!isAbsolute(keyFile)) {
    throw new Error("The recovery key file must use an absolute path.");
  }

  const keyPath = join(await realpath(dirname(keyFile)), basename(keyFile));
  for (const root of protectedRoots) {
    const fromRoot = relative(await canonicalPath(root), keyPath);
    if (fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(".." + sep))) {
      throw new Error("Store the recovery key outside the backup and file storage directories.");
    }
  }

  return withRegularFile(keyPath, async (file, stats) => {
    if ((stats.mode & 0o077) !== 0) {
      throw new Error("The recovery key file must be accessible only to its owner. Set its permissions to 600.");
    }
    if (stats.size < 64 || stats.size > 66) {
      throw new Error("The recovery key file must contain exactly 64 hexadecimal characters.");
    }
    const buffer = Buffer.alloc(67);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const keyText = buffer.subarray(0, bytesRead).toString("latin1");
    if (bytesRead !== stats.size || !/^[0-9a-fA-F]{64}(?:\r?\n)?$/.test(keyText)) {
      throw new Error("The recovery key file must contain exactly 64 hexadecimal characters.");
    }
    return Buffer.from(keyText.slice(0, 64), "hex");
  });
}

export async function encryptArchive(source, destinationPath, key, snapshotId, purpose, expected) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(snapshotId, purpose));
  const digest = measurePlaintext(expected);

  const encrypt = (input) => withNewFile(destinationPath, async (output) => {
    await writeAll(output, Buffer.concat([MAGIC, nonce]), 0);
    const sink = fileSink(output, HEADER_BYTES);
    await pipeline(input, digest.stream, cipher, sink);
    const result = digest.verify();
    await writeAll(output, cipher.getAuthTag(), HEADER_BYTES + result.size);
    return result;
  });

  if (typeof source !== "string") {
    return encrypt(source);
  }
  return withRegularFile(source, (file) => encrypt(file.createReadStream({ autoClose: false })));
}

export async function decryptArchive(sourcePath, destinationPath, key, snapshotId, purpose, expected) {
  return withRegularFile(sourcePath, async (file, stats) => {
    const { decipher, size } = await openEncryptedFile(file, stats, key, snapshotId, purpose);
    const digest = measurePlaintext(expected);
    if (expected && size !== expected.size) {
      throw new Error("The snapshot object size does not match its recorded size.");
    }

    return withNewFile(destinationPath, async (output) => {
      const input = size === 0
        ? Readable.from([])
        : file.createReadStream({ start: HEADER_BYTES, end: HEADER_BYTES + size - 1, autoClose: false });
      await pipeline(input, decipher, digest.stream, fileSink(output, 0));
      return digest.verify();
    });
  });
}

export async function checkArchiveSize(path, plaintextSize) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.size - HEADER_BYTES - TAG_BYTES !== plaintextSize) {
    throw new Error("The recovery archive object is missing or its stored size is incorrect.");
  }
}

export async function writeManifest(destinationPath, key, snapshotId, manifest) {
  const json = JSON.stringify(manifest);
  if (typeof json !== "string" || Buffer.byteLength(json) > MANIFEST_MAX_BYTES) {
    throw new Error("The snapshot manifest exceeds the supported size.");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(snapshotId, "manifest"));
  const archive = Buffer.concat([MAGIC, nonce, cipher.update(json, "utf8"), cipher.final(), cipher.getAuthTag()]);
  await withNewFile(destinationPath, (file) => writeAll(file, archive, 0));
}

export async function readManifest(sourcePath, key, snapshotId) {
  return withRegularFile(sourcePath, async (file, stats) => {
    if (stats.size > HEADER_BYTES + MANIFEST_MAX_BYTES + TAG_BYTES) {
      throw new Error("The snapshot manifest exceeds the supported size.");
    }
    const { decipher, size } = await openEncryptedFile(file, stats, key, snapshotId, "manifest");
    const ciphertext = await readExactly(file, size, HEADER_BYTES);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  });
}

function associatedData(snapshotId, purpose) {
  if (typeof snapshotId !== "string" || !UUID.test(snapshotId)) {
    throw new Error("Invalid recovery snapshot identifier.");
  }
  if (purpose !== "database" && purpose !== "manifest"
      && !(typeof purpose === "string" && purpose.startsWith("blob:") && UUID.test(purpose.slice(5)))) {
    throw new Error("Invalid recovery object type.");
  }
  return Buffer.from(JSON.stringify([FORMAT, snapshotId, purpose]));
}

async function openEncryptedFile(file, stats, key, snapshotId, purpose) {
  const size = stats.size - HEADER_BYTES - TAG_BYTES;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Invalid recovery archive size.");
  }
  const header = await readExactly(file, HEADER_BYTES, 0);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Unrecognized recovery archive format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length), { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData(snapshotId, purpose));
  decipher.setAuthTag(await readExactly(file, TAG_BYTES, HEADER_BYTES + size));
  return { decipher, size };
}

function measurePlaintext(expected) {
  if (expected && (!Number.isSafeInteger(expected.size) || expected.size < 0
      || typeof expected.sha256 !== "string" || !SHA256.test(expected.sha256))) {
    throw new Error("Invalid size or SHA-256 digest recorded for the snapshot object.");
  }
  const hash = createHash("sha256");
  let size = 0;
  const stream = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (expected && size > expected.size) {
        done(new Error("The snapshot object size does not match its recorded size."));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return {
    stream,
    verify() {
      const sha256 = hash.digest("hex");
      if (expected && (size !== expected.size || sha256 !== expected.sha256)) {
        throw new Error("The snapshot object does not match its recorded size or SHA-256 digest.");
      }
      return { size, sha256 };
    },
  };
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT" || dirname(path) === path) {
      throw error;
    }
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

async function withRegularFile(path, action) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error("Recovery requires regular files.");
    }
    return await action(file, stats);
  } finally {
    await file.close();
  }
}

async function withNewFile(path, action) {
  const file = await open(path, "wx", 0o600);
  try {
    const result = await action(file);
    await file.sync();
    await file.close();
    return result;
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(path);
    throw error;
  }
}

async function readExactly(file, size, position) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(buffer, offset, size - offset, position + offset);
    if (bytesRead === 0) {
      throw new Error("Incomplete recovery archive.");
    }
    offset += bytesRead;
  }
  return buffer;
}

async function writeAll(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten === 0) {
      throw new Error("Unable to write the recovery archive.");
    }
    offset += bytesWritten;
  }
}

function fileSink(file, start) {
  let position = start;
  return new Writable({
    write(chunk, _encoding, done) {
      writeAll(file, chunk, position).then(() => {
        position += chunk.length;
        done();
      }, done);
    },
  });
}
