import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { fromRandomAccessReaderPromise, RandomAccessReader, type Entry, type ZipFile } from "yauzl";

class PreviewReader extends RandomAccessReader {
  constructor(private readonly handle: FileHandle) { super(); }

  _readStreamForRange(start: number, end: number) {
    return Readable.from(this.readRange(start, end));
  }

  private async *readRange(start: number, end: number) {
    let position = start;
    while (position < end) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
      const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new Error("The Office preview ended before the requested range.");
      position += bytesRead;
      yield chunk.subarray(0, bytesRead);
    }
  }
}

const XML_LIMIT = 1024 * 1024;
const ENTRY_LIMIT = 12;
const MAX_TEXT = 6000;
const TEXT_ELEMENT = /<(?:[\w.-]+:)?t\b[^<>]*>([^<>]*)<\/(?:[\w.-]+:)?t\s*>/g;
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeText(value: string) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity: string, name: string) => {
    if (name[0] !== "#") return entities[name] ?? entity;
    const hex = name[1].toLowerCase() === "x";
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : "\ufffd";
  });
}

function textRuns(xml: string) {
  return Array.from(xml.matchAll(TEXT_ELEMENT), ([, text]) => decodeText(text)).join("");
}

async function readXml(zip: ZipFile, entry: Entry) {
  if (entry.uncompressedSize > XML_LIMIT || entry.compressedSize > XML_LIMIT) return "";
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > XML_LIMIT) return "";
    chunks.push(chunk);
  }
  // Preview uses plain text only and never loads XML declarations or external relationships.
  const xml = Buffer.concat(chunks, length).toString("utf8");
  const parts: string[] = [];
  let position = 0;
  for (let start = xml.indexOf("<!--"); start >= 0; start = xml.indexOf("<!--", position)) {
    parts.push(xml.slice(position, start));
    const end = xml.indexOf("-->", start + 4);
    if (end < 0) return parts.join("");
    position = end + 3;
  }
  parts.push(xml.slice(position));
  return parts.join("");
}

function paragraphs(xml: string) {
  return xml.split(/<\/(?:[\w.-]+:)?p\s*>/g).map(textRuns).filter(Boolean);
}

function sheetPreview(xml: string, strings: string[], maxLength: number) {
  const preview: string[] = [];
  let remaining = maxLength;
  for (const row of xml.split(/<\/(?:[\w.-]+:)?row\s*>/g)) {
    const values: string[] = [];
    for (const cell of row.split(/<\/(?:[\w.-]+:)?c\s*>/g)) {
      const attributes = /<(?:[\w.-]+:)?c\b([^<>]*)>/.exec(cell)?.[1];
      if (attributes === undefined) continue;
      const value = /<(?:[\w.-]+:)?v\b[^<>]*>([^<>]*)<\/(?:[\w.-]+:)?v\s*>/.exec(cell)?.[1];
      const shared = /\st\s*=\s*["']s["']/.test(attributes);
      const text = value === undefined ? textRuns(cell) : shared ? (strings[Number(value)] ?? "") : decodeText(value);
      const part = text.slice(0, remaining);
      values.push(part);
      remaining -= part.length;
      if (!remaining || values.length === 12) break;
    }
    if (values.some(Boolean)) preview.push(values.join("  |  "));
    if (!remaining || preview.length === 20) break;
  }
  return preview.join("\n");
}

export async function officePreview(handle: FileHandle, size: number, mimeType: string) {
  const zip = await fromRandomAccessReaderPromise(new PreviewReader(handle), size, { autoClose: false });
  try {
    const sections: string[] = [];
    let remaining = MAX_TEXT;
    function append(text: string) {
      const section = text.trim().slice(0, remaining);
      if (!section) return;
      sections.push(section);
      remaining -= section.length;
    }

    const word = mimeType.endsWith("wordprocessingml.document");
    const sheet = mimeType.endsWith("spreadsheetml.sheet");
    const pattern = sheet ? /^xl\/worksheets\/sheet(\d+)\.xml$/ : /^ppt\/slides\/slide(\d+)\.xml$/;
    const entries: { entry: Entry; number: number }[] = [];
    let sharedStrings: Entry | undefined;
    for await (const entry of zip.eachEntry()) {
      if (word && entry.fileName === "word/document.xml") {
        append(paragraphs(await readXml(zip, entry)).join("\n"));
        break;
      }
      if (sheet && entry.fileName === "xl/sharedStrings.xml") sharedStrings = entry;
      const match = pattern.exec(entry.fileName);
      if (!word && match) entries.push({ entry, number: Number(match[1]) });
    }

    const stringXml = sharedStrings ? await readXml(zip, sharedStrings) : "";
    const strings = stringXml.split(/<\/(?:[\w.-]+:)?si\s*>/g).map(textRuns);
    for (const { entry, number } of entries.sort((a, b) => a.number - b.number).slice(0, ENTRY_LIMIT)) {
      if (!remaining) break;
      const xml = await readXml(zip, entry);
      const text = sheet ? sheetPreview(xml, strings, remaining) : paragraphs(xml).join("\n");
      if (text) append(`${sheet ? "Sheet" : "Slide"} ${number}\n${text}`);
    }
    return { sections };
  } finally {
    zip.close();
  }
}
