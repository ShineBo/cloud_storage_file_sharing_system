import { UnsupportedMediaTypeException } from "@nestjs/common";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { openPromise as openZip, type Entry, type ZipFile } from "yauzl";

type FileType = { mimeType: string; signature: Buffer };
type OfficeType = FileType & { documentPath: string; documentType: string };

const PNG = {
  mimeType: "image/png",
  signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};
const JPEG = {
  mimeType: "image/jpeg",
  signature: Buffer.from([0xff, 0xd8, 0xff]),
};
const PDF = { mimeType: "application/pdf", signature: Buffer.from("%PDF-") };
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OFFICE_MIME = "application/vnd.openxmlformats-officedocument.";
const MANIFEST = "[Content_Types].xml";
const MAX_ZIP_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 512 * 1024;
const approvedTypes = new Map<string, FileType | OfficeType>([
  [".png", PNG],
  [".jpg", JPEG],
  [".jpeg", JPEG],
  [".pdf", PDF],
  [".docx", {
    signature: ZIP,
    mimeType: OFFICE_MIME + "wordprocessingml.document",
    documentPath: "word/document.xml",
    documentType: OFFICE_MIME + "wordprocessingml.document.main+xml",
  }],
  [".xlsx", {
    signature: ZIP,
    mimeType: OFFICE_MIME + "spreadsheetml.sheet",
    documentPath: "xl/workbook.xml",
    documentType: OFFICE_MIME + "spreadsheetml.sheet.main+xml",
  }],
  [".pptx", {
    signature: ZIP,
    mimeType: OFFICE_MIME + "presentationml.presentation",
    documentPath: "ppt/presentation.xml",
    documentType: OFFICE_MIME + "presentationml.presentation.main+xml",
  }],
]);
export const supportedMimeTypes = [...new Set([...approvedTypes.values()].map(({ mimeType }) => mimeType))];
const executableEntry = /(?:^|\/)vbaProject\.bin$|\.(?:exe|dll|msi|com|scr|bat|cmd|ps1|sh|vbs)$/i;

export function expectedFileType(name: string) {
  const type = approvedTypes.get(extname(name).toLowerCase());
  if (!type) {
    throw new UnsupportedMediaTypeException(
      "Upload a PDF, DOCX, XLSX, PPTX, PNG, or JPEG file. Executable and unsupported types are blocked.",
    );
  }
  return type;
}

export async function verifyFileType(path: string, expected: FileType | OfficeType) {
  const handle = await open(path, "r");
  const actual = Buffer.alloc(expected.signature.length);
  const { bytesRead } = await handle
    .read(actual, 0, actual.length, 0)
    .finally(() => handle.close());
  const sameType = bytesRead === actual.length && actual.equals(expected.signature);
  if (!sameType || ("documentPath" in expected && !(await isOfficeDocument(path, expected)))) {
    throw new UnsupportedMediaTypeException(
      "The file content does not match its approved extension or contains blocked executable content.",
    );
  }
}

async function isOfficeDocument(path: string, type: OfficeType) {
  let zip: ZipFile | undefined;
  try {
    zip = await openZip(path, { autoClose: false });
    if (zip.entryCount > MAX_ZIP_ENTRIES) return false;

    let manifest: Entry | undefined;
    let hasDocument = false;
    for await (const entry of zip.eachEntry()) {
      if (executableEntry.test(entry.fileName)) return false;
      if (entry.fileName === MANIFEST) {
        if (manifest) return false;
        manifest = entry;
      }
      if (entry.fileName === type.documentPath) {
        if (hasDocument || entry.uncompressedSize === 0) return false;
        hasDocument = true;
      }
    }
    if (
      !hasDocument ||
      !manifest ||
      manifest.uncompressedSize > MAX_MANIFEST_BYTES ||
      manifest.compressedSize > MAX_MANIFEST_BYTES
    ) return false;

    const stream = await zip.openReadStreamPromise(manifest);
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_MANIFEST_BYTES) return false;
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks).toString("utf8").replace(/<!--[\s\S]*?-->/g, "");
    // Read the declaration without parsing XML entities or opening archived payloads.
    for (const [tag] of data.matchAll(/<(?:[\w-]+:)?Override\s+[^<>]*>/g)) {
      if (
        readAttribute(tag, "PartName") === "/" + type.documentPath &&
        readAttribute(tag, "ContentType") === type.documentType
      ) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    zip?.close();
  }
}

function readAttribute(tag: string, name: string) {
  return new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`).exec(tag)?.[2];
}
