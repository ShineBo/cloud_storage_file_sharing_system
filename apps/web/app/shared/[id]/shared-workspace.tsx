"use client";

import { useEffect, useRef, useState } from "react";
import { formatSize } from "../../file-transfer";
import { localDateTime } from "../../local-date-time";
import { RevisionDetails, RevisionDialog, staleRevisionNotice, type Revision } from "../../revision-dialog";
import { Header } from "../../workspace";

type SharedFolder = { id: string; name: string; type: "folder" };
type SharedFile = Revision & { id: string; name: string; type: "file"; size: number; mimeType: string };
type SharedEntry = SharedFolder | SharedFile;

type ShareContents = {
  item: SharedEntry;
  entries: SharedEntry[];
  ancestors: { id: string; name: string }[];
  ownerName: string;
  expiresAt: string;
  permission: "view" | "edit";
  allowDownload: boolean;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: ShareContents }
  | { status: "error"; code: number; message: string; loginFailed?: boolean };

async function accessError(response: Response, loginStatus?: string | null) {
  if (response.status === 401 || response.status === 404) {
    if (loginStatus === "denied") {
      return "This organization account could not open the link. Try an approved account or contact your administrator.";
    }
    if (loginStatus === "unavailable") return "Sign-in is temporarily unavailable. Try again in a moment.";
  }
  switch (response.status) {
    case 401:
      return "Sign in with your organization account to open this link.";
    case 403:
      return "Ask the sender to check your permission for this action.";
    case 404:
      return "This item is unavailable to your account. Ask the sender to check who has access.";
    case 410: {
      const body = await response.json().catch(() => undefined) as { message?: unknown } | undefined;
      return typeof body?.message === "string"
        ? body.message
        : "This link has expired or been revoked. Ask the sender for a new link.";
    }
    default:
      return "The shared item could not be opened. Try again in a moment.";
  }
}

export function SharedWorkspace({ id }: { id: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterNavigation = useRef(false);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionNotice, setRevisionNotice] = useState<{ kind: "success" | "error"; message: string }>();
  const [showPreview, setShowPreview] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sharePath = `/api/shared/${encodeURIComponent(id)}`;
  const loginPath = `/api/auth/login?share=${encodeURIComponent(id)}`;

  useEffect(() => {
    const controller = new AbortController();

    async function loadContents() {
      try {
        const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
        const response = await fetch(`${sharePath}${query}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const loginStatus = new URLSearchParams(window.location.search).get("auth");
          const message = await accessError(response, loginStatus);
          const loginFailed = loginStatus === "denied" || loginStatus === "unavailable";
          if (!controller.signal.aborted) setState({ status: "error", code: response.status, message, loginFailed });
          return;
        }
        const data = await response.json() as ShareContents;
        if (!controller.signal.aborted) setState({ status: "ready", data });
      } catch {
        if (!controller.signal.aborted) {
          setState({ status: "error", code: 0, message: "The shared item could not be opened. Check your connection and try again." });
        }
      }
    }

    void loadContents();
    return () => controller.abort();
  }, [folderId, attempt, sharePath]);

  useEffect(() => {
    if (state.status !== "loading" && focusAfterNavigation.current) {
      focusAfterNavigation.current = false;
      if (document.activeElement === document.body) headingRef.current?.focus();
    }
  }, [state, selectedId]);

  function openFolder(nextFolder: string | null) {
    focusAfterNavigation.current = nextFolder !== folderId || selectedId !== undefined;
    setSelectedId(undefined);
    setRevisionNotice(undefined);
    setShowPreview(false);
    if (nextFolder !== folderId) {
      setState({ status: "loading" });
      setFolderId(nextFolder);
    }
  }

  function reload() {
    focusAfterNavigation.current = true;
    setRevisionOpen(false);
    setShowPreview(false);
    setState({ status: "loading" });
    setAttempt((previous) => previous + 1);
  }

  if (state.status !== "ready") {
    const signedOut = state.status === "error" && state.code === 401;
    return (
      <>
        <Header />
        <main className="entry">
          <section className="entry-card" aria-labelledby="shared-title">
            <div className="entry-icon" aria-hidden="true"><span className="folder-icon" /></div>
            <h1 id="shared-title" ref={headingRef} tabIndex={-1}>{signedOut ? "Open shared item" : "Shared item"}</h1>
            {state.status === "loading" && <p className="entry-status" role="status">Opening link…</p>}
            {state.status === "error" && (
              <>
                {signedOut && !state.loginFailed ? <p className="entry-description">{state.message}</p>
                  : <p className="notice notice-error" role="alert">{state.message}</p>}
                <div className="shared-error-actions">
                  {signedOut && <a className="button button-primary" href={loginPath}>Sign in</a>}
                  {state.code === 404 && <a className="button button-secondary" href={loginPath}>Switch account</a>}
                  {(state.code === 0 || state.code >= 500) && (
                    <button className="button button-secondary" type="button" onClick={reload}>Try again</button>
                  )}
                  <a className="button button-secondary" href="/">My files</a>
                </div>
              </>
            )}
          </section>
        </main>
      </>
    );
  }

  const { data } = state;
  const selected = data.entries.find((entry) => entry.type === "file" && entry.id === selectedId);
  const current = selected ?? data.item;
  const expiry = localDateTime.format(new Date(data.expiresAt));

  return (
    <>
      <Header />
      <main className="workspace shared-workspace">
        <a className="shared-back" href="/">My files</a>
        <div className="workspace-heading shared-heading">
          <h1 ref={headingRef} tabIndex={-1}>{current.name}</h1>
          <p>
            Shared by {data.ownerName}
            {" · "}
            {data.permission === "edit" ? "Edit access" : "View access"}
            {" · Expires "}
            <time dateTime={data.expiresAt}>{expiry}</time>
          </p>
        </div>
        {revisionNotice && (
          <p className={`notice notice-${revisionNotice.kind} shared-revision-notice`}
            role={revisionNotice.kind === "error" ? "alert" : "status"}>
            {revisionNotice.message}
          </p>
        )}
        {(data.ancestors.length > 0 || selected) && (
          <nav className="breadcrumbs" aria-label="Shared folder path">
            <ol>
              {data.ancestors.map((folder, index) => (
                <li key={folder.id}>
                  {index > 0 && <span aria-hidden="true" className="breadcrumb-separator">/</span>}
                  <button type="button" onClick={() => openFolder(index === 0 ? null : folder.id)}>
                    {folder.name}
                  </button>
                </li>
              ))}
              {selected && (
                <li>
                  {data.ancestors.length > 0 && <span aria-hidden="true" className="breadcrumb-separator">/</span>}
                  <button type="button" onClick={() => openFolder(folderId)}>{data.item.name}</button>
                </li>
              )}
              <li>
                <span aria-hidden="true" className="breadcrumb-separator">/</span>
                <span aria-current="location">{current.name}</span>
              </li>
            </ol>
          </nav>
        )}
        {current.type === "folder" ? (
          <section className="panel files-panel" aria-labelledby="shared-items">
            <div className="files-heading"><h2 id="shared-items">Folder contents</h2></div>
            {data.entries.length === 0 ? <p className="files-status">This folder is empty.</p> : (
              <ul className="file-list">
                {data.entries.map((entry) => (
                  <li className="file-row shared-file-row" key={entry.id}>
                    <div className="file-type" aria-hidden="true">
                      {entry.type === "folder" ? <span className="folder-icon" />
                        : entry.name.split(".").pop()?.toUpperCase()}
                    </div>
                    <div className="file-info">
                      <button
                        className="folder-link"
                        type="button"
                        aria-label={`Open ${entry.name}`}
                        onClick={() => {
                          if (entry.type === "folder") openFolder(entry.id);
                          else {
                            focusAfterNavigation.current = true;
                            setSelectedId(entry.id);
                            setRevisionNotice(undefined);
                          }
                        }}
                      >
                        {entry.name}
                      </button>
                      <p className="file-meta">{entry.type === "folder" ? "Folder" : formatSize(entry.size)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <section className="panel shared-file-panel" aria-labelledby="shared-file-actions">
            <div className="shared-file-toolbar">
              <div>
                <h2 id="shared-file-actions">File access</h2>
                <p className="file-meta">{formatSize(current.size)}</p>
                <RevisionDetails file={current} />
              </div>
              <div className="item-actions">
                <button className="button button-primary" type="button"
                  aria-expanded={showPreview} aria-controls="shared-preview"
                  onClick={() => setShowPreview((previous) => !previous)}>
                  {showPreview ? "Close preview" : "Preview file"}
                </button>
                {data.permission === "edit" && (
                  <button className="button button-secondary" type="button" onClick={() => setRevisionOpen(true)}>
                    Publish revision
                  </button>
                )}
                {data.allowDownload && (
                  <a className="button button-secondary" download aria-label={`Download ${current.name}`}
                    href={`${sharePath}/files/${encodeURIComponent(current.id)}/download`}>
                    Download
                  </a>
                )}
              </div>
            </div>
            <div id="shared-preview" hidden={!showPreview}>
              {showPreview && (
                <FilePreview
                  key={`${current.id}:${current.revision}`}
                  file={current}
                  url={`${sharePath}/files/${encodeURIComponent(current.id)}/view`}
                  onReload={reload}
                />
              )}
            </div>
          </section>
        )}
      </main>
      {revisionOpen && current.type === "file" && data.permission === "edit" && (
        <RevisionDialog file={current} endpoint={`${sharePath}/files/${encodeURIComponent(current.id)}/revisions`}
          onClose={() => setRevisionOpen(false)}
          onPublished={(version) => {
            setRevisionNotice({ kind: "success", message: `Version ${version} published.` });
            reload();
          }}
          onStale={() => {
            setRevisionNotice({ kind: "error", message: staleRevisionNotice });
            reload();
          }}
          onUnavailable={(status) => {
            if (status === 404) setRevisionNotice({ kind: "error", message: "This file is unavailable through the link." });
            reload();
          }} />
      )}
    </>
  );
}

function FilePreview({ file, url, onReload }: { file: SharedFile; url: string; onReload: () => void }) {
  const isPdf = file.mimeType === "application/pdf";
  const isImage = file.mimeType === "image/jpeg" || file.mimeType === "image/png";
  const [sections, setSections] = useState<string[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (isImage || isPdf) return;
    const controller = new AbortController();

    async function loadPreview() {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const message = await accessError(response);
          if (!controller.signal.aborted) setError(message);
          return;
        }
        const preview = await response.json() as { sections: string[] };
        if (!controller.signal.aborted) setSections(preview.sections);
      } catch {
        if (!controller.signal.aborted) setError("The preview could not be loaded. Try again in a moment.");
      }
    }

    void loadPreview();
    return () => controller.abort();
  }, [isImage, isPdf, url]);

  if (error) {
    return (
      <div className="shared-preview">
        <p className="notice notice-error" role="alert">{error}</p>
        <button className="button button-secondary share-retry" type="button" onClick={onReload}>Check link access</button>
      </div>
    );
  }

  if (isPdf) {
    return <iframe className="shared-pdf" src={`${url}#toolbar=0&navpanes=0`}
      title={`Preview of ${file.name}`} referrerPolicy="no-referrer" />;
  }

  if (isImage) {
    return <div className="shared-preview">
      <img src={url} alt={`Preview of ${file.name}`} referrerPolicy="no-referrer"
        onError={() => setError("The image could not be previewed. Check your access and try again.")} />
    </div>;
  }

  return (
    <div className="shared-preview office-preview" role="region"
      aria-label={`Preview of ${file.name}`} tabIndex={sections?.length ? 0 : undefined}>
      {sections === undefined ? <p className="file-meta" role="status">Loading preview…</p>
        : sections.length === 0 ? <p className="file-meta">This document has no text to preview.</p>
          : sections.map((section, index) => <p key={index}>{section}</p>)}
    </div>
  );
}
