export const fileFormats = [
  { name: "PDF", label: "PDF", mimeType: "application/pdf", extensions: [".pdf"] },
  { name: "DOCX", label: "Word (DOCX)", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extensions: [".docx"] },
  { name: "XLSX", label: "Excel (XLSX)", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extensions: [".xlsx"] },
  { name: "PPTX", label: "PowerPoint (PPTX)", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extensions: [".pptx"] },
  { name: "JPEG", label: "JPEG", mimeType: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  { name: "PNG", label: "PNG", mimeType: "image/png", extensions: [".png"] },
];

export function uploadFormats(allowedMimeTypes?: string[]) {
  return fileFormats.filter(({ mimeType }) => allowedMimeTypes?.includes(mimeType) ?? true);
}

export function responseMessage(body: unknown, fallback: string) {
  return body && typeof body === "object" && "message" in body && typeof body.message === "string"
    ? body.message : fallback;
}

const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatSize(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${sizeFormat.format(bytes / 1000)} kB`;
  if (bytes < 1_000_000_000) return `${sizeFormat.format(bytes / 1_000_000)} MB`;
  return `${sizeFormat.format(bytes / 1_000_000_000)} GB`;
}

export function fileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

export function uploadFileRequest(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.responseType = "json";
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.floor((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => resolve({ status: request.status, body: request.response }));
    request.addEventListener("error", () => reject(new Error("Upload disconnected.")));
    request.addEventListener("abort", () => reject(new Error("Upload interrupted.")));

    const form = new FormData();
    form.set("file", file);
    request.send(form);
  });
}
