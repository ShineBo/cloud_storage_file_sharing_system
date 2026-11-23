"use client";

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { fileExtension, formatSize, responseMessage, uploadFileRequest, uploadFormats } from "./file-transfer";

export type Revision = { revision: number; authorName: string; revisedAt: string };
type RevisableFile = Revision & { name: string };
type UploadLimits = { maxFileBytes: number; availableBytes: number; allowedMimeTypes: string[] };

const revisionTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function RevisionDetails({ file }: { file: Revision }) {
  return (
    <span className="file-meta revision-details">
      Version {file.revision}{" · "}{file.authorName}{" · "}
      <time dateTime={file.revisedAt}>{revisionTime.format(new Date(file.revisedAt))}</time>
    </span>
  );
}

export const staleRevisionNotice = "A newer version is available. Review it and choose a replacement again.";

function readErrorCode(body: unknown) {
  if (!body || typeof body !== "object") return;
  return "code" in body ? body.code : undefined;
}

function readPublishedRevision(body: unknown) {
  if (!body || typeof body !== "object" || !("file" in body)) return;
  const file = body.file;
  if (!file || typeof file !== "object" || !("revision" in file)) return;
  return typeof file.revision === "number" ? file.revision : undefined;
}

function rejectionMessage(status: number, limits?: UploadLimits) {
  switch (status) {
    case 400:
      return "The replacement could not be read. Check the file and try again.";
    case 403:
      return "Edit access is required. Ask the owner to check your permission.";
    case 409:
      return "There isn’t enough storage space for this revision. Choose a smaller file.";
    case 413:
      return limits ? `Choose a file no larger than ${formatSize(limits.maxFileBytes)}.`
        : "This file exceeds the upload size limit. Choose a smaller file.";
    case 415:
      return "Choose a replacement with content that matches the original file type.";
    case 429:
      return "Too many requests. Try again in a moment.";
    default:
      return "The update could not be confirmed. Check the current version before trying again.";
  }
}

function checkReplacement(file: File, extensions: string[], limits?: UploadLimits) {
  if (file.size === 0) return "This file is empty. Choose another file.";
  if (/[\\/\u0000-\u001f\u007f]/.test(file.name) || new TextEncoder().encode(file.name).length > 255) {
    return "Choose a file with a name of up to 255 bytes, without slashes or control characters.";
  }
  if (!extensions.includes(fileExtension(file.name))) return "Choose a replacement of the same file type.";
  if (!limits) return;
  if (!uploadFormats(limits.allowedMimeTypes).some(({ extensions }) => extensions.includes(fileExtension(file.name)))) {
    return "This file type is currently blocked for new revisions.";
  }
  if (file.size > limits.maxFileBytes) return rejectionMessage(413, limits);
  if (file.size > limits.availableBytes) return rejectionMessage(409, limits);
}

export function RevisionDialog({
  file, endpoint, limits, onClose, onPublished, onStale, onUnavailable,
}: {
  file: RevisableFile;
  endpoint: string;
  limits?: UploadLimits;
  onClose: () => void;
  onPublished: (version: number) => void;
  onStale: () => void;
  onUnavailable: (status: number) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<File>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<number>();
  const extension = fileExtension(file.name);
  const extensions = [".jpg", ".jpeg"].includes(extension) ? [".jpg", ".jpeg"] : [extension];

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  function chooseReplacement(event: ChangeEvent<HTMLInputElement>) {
    const replacement = event.currentTarget.files?.[0];
    const problem = replacement ? checkReplacement(replacement, extensions, limits) : undefined;
    if (problem) event.currentTarget.value = "";
    setError(problem);
    setSelected(problem ? undefined : replacement);
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !selected) return;
    const problem = checkReplacement(selected, extensions, limits);
    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    setProgress(undefined);
    setError(undefined);
    const query = new URLSearchParams({ baseRevision: String(file.revision), size: String(selected.size) });
    try {
      const { status, body } = await uploadFileRequest(`${endpoint}?${query}`, selected, setProgress);
      if (status === 409 && readErrorCode(body) === "STALE_REVISION") {
        onStale();
        return;
      }
      if (status === 401 || status === 404 || status === 410) {
        onUnavailable(status);
        return;
      }
      if (status >= 200 && status < 300) {
        const version = readPublishedRevision(body);
        if (version !== undefined) {
          onPublished(version);
          return;
        }
      }
      const fallback = rejectionMessage(status, limits);
      setError(status === 415 ? responseMessage(body, fallback) : fallback);
    } catch {
      setError(rejectionMessage(0, limits));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog className="item-dialog revision-dialog" ref={dialogRef} aria-labelledby="revision-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
      <form onSubmit={publish}>
        <h2 id="revision-title">Publish revision</h2>
        <p className="dialog-item-name">{file.name}</p>
        <RevisionDetails file={file} />
        <label htmlFor="replacement-file">Choose replacement file</label>
        <input id="replacement-file" type="file" name="file" accept={extensions.join(",")}
          aria-describedby="replacement-hint" disabled={saving} onChange={chooseReplacement} />
        <p id="replacement-hint" className="panel-description">
          Choose a {extension.slice(1).toUpperCase()} file.
          {limits && ` ${formatSize(limits.availableBytes)} available.`}
        </p>
        {saving && (
          <div className="upload-progress">
            <progress max={100} value={progress} aria-label="Revision upload progress" />
            {progress === 100 && <p role="status">Publishing the revision…</p>}
          </div>
        )}
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button button-secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={saving || !selected}>
            {saving ? "Publishing…" : "Publish revision"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
