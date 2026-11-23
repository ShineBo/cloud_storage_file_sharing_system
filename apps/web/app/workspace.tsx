"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { fileExtension, formatSize, responseMessage, uploadFileRequest, uploadFormats } from "./file-transfer";
import { RevisionDetails, RevisionDialog, staleRevisionNotice, type Revision } from "./revision-dialog";
import { ShareDialog } from "./share-dialog";

export type User = {
  id: string;
  username: string;
  displayName: string;
};

type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
};

type StoredFile = Revision & {
  id: string;
  name: string;
  size: number;
  createdAt: string;
  folderId: string | null;
};

type StoragePolicy = {
  maxFileBytes: number;
  quotaBytes: number;
  availableBytes: number;
  allowedMimeTypes: string[];
};

type WorkspaceData = {
  folders: Map<string, Folder>;
  files: StoredFile[];
  policy: StoragePolicy;
};

type Feedback = { kind: "error" | "success"; message: string };
type Item = { type: "folder"; data: Folder } | { type: "file"; data: StoredFile };
type ItemAction = { type: "create" } | { type: "rename" | "move" | "trash"; item: Item };

const fileTypeList = new Intl.ListFormat(undefined, { type: "conjunction" });
const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const folderSort = new Intl.Collator(undefined, { numeric: true });

function validateFile(file: File, policy: StoragePolicy) {
  if (file.size === 0) return "This file is empty. Choose another file.";
  const formats = uploadFormats(policy.allowedMimeTypes);
  if (!formats.some(({ extensions }) => extensions.includes(fileExtension(file.name)))) {
    return `Choose an approved file type. This workspace allows ${fileTypeList.format(formats.map(({ name }) => name))}.`;
  }
  if (file.size > policy.maxFileBytes) {
    return `This file exceeds the ${formatSize(policy.maxFileBytes)} limit. Choose a smaller file.`;
  }
  if (file.size > policy.availableBytes) {
    return "There isn’t enough storage space for this file. Choose a smaller file.";
  }
}

function validateName(name: string) {
  if (!name || name === "." || name === "..") return "Enter a name for this item.";
  if (
    /[\\/\u0000-\u001f\u007f]/.test(name) ||
    new TextEncoder().encode(name).length > 255
  ) {
    return "Use a name of up to 255 bytes without slashes or control characters.";
  }
}

function folderTrail(folderId: string | null, folders: Map<string, Folder>) {
  const trail: Folder[] = [];
  const seen = new Set<string>();
  let current = folderId ? folders.get(folderId) : undefined;
  while (current && !seen.has(current.id)) {
    trail.push(current);
    seen.add(current.id);
    current = current.parentId ? folders.get(current.parentId) : undefined;
  }
  return trail.reverse();
}

function uploadErrorMessage(status: number, policy: StoragePolicy) {
  switch (status) {
    case 413:
      return `This file exceeds the ${formatSize(policy.maxFileBytes)} limit. Choose a smaller file.`;
    case 409:
      return "There isn’t enough storage space for this file. Check your available storage or choose a smaller file.";
    case 415:
      return "The file contents don’t match an approved file type. Choose another file.";
    case 400:
      return "The file could not be accepted. Check the file and its name, then try again.";
    case 403:
      return "This upload was blocked. Open the workspace again and retry.";
    case 404:
      return "This folder is no longer available. Choose another folder and retry.";
    default:
      return "Upload could not be confirmed. Reload the workspace to check your files before trying again.";
  }
}

function itemErrorMessage(status: number, action: ItemAction) {
  if (action.type === "trash") {
    return status === 404 ? "This item is unavailable. Reload your files and try again."
      : "The move to Trash could not be confirmed. Check your files and try again.";
  }
  switch (status) {
    case 400:
      if (action.type === "move") return "Choose a different destination folder.";
      if (action.type === "rename" && action.item.type === "file") {
        return "Check that the name is valid and keeps the file extension.";
      }
      return "Check the folder name and try again.";
    case 404:
      return "The item or destination is unavailable. Cancel and reopen the workspace before retrying.";
    case 409:
      return "A folder with this name already exists there. Choose a different name or destination.";
    default:
      return "The change could not be confirmed. Cancel and check the workspace before trying again.";
  }
}

export function Header({
  user,
  onSignOut,
  signingOut = false,
  uploading = false,
}: {
  user?: User;
  onSignOut?: () => void;
  signingOut?: boolean;
  uploading?: boolean;
}) {
  return (
    <header className="site-header">
      <div className="header-content">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            <span className="folder-icon" />
          </span>
          <span>Cloud Storage</span>
        </div>
        {user && (
          <div className="account">
            <span className="account-name">{user.displayName || user.username}</span>
            <button
              className="button button-secondary"
              type="button"
              onClick={onSignOut}
              disabled={signingOut || uploading}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export function Workspace({
  user,
  onSessionExpired,
}: {
  user: User;
  onSessionExpired: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceData>();
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number>();
  const [uploadFeedback, setUploadFeedback] = useState<Feedback>();
  const [itemFeedback, setItemFeedback] = useState<Feedback>();
  const [action, setAction] = useState<ItemAction>();
  const [shareItem, setShareItem] = useState<Item>();
  const [revisionFile, setRevisionFile] = useState<StoredFile>();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [canAdminister, setCanAdminister] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/policy", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setCanAdminister(response.ok);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadWorkspace() {
      try {
        const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
        const options = { cache: "no-store", signal: controller.signal } as const;
        const [foldersResponse, filesResponse, policyResponse] = await Promise.all([
          fetch("/api/folders", options),
          fetch(`/api/files${query}`, options),
          fetch("/api/files/policy", options),
        ]);

        if (controller.signal.aborted) return;
        if ([foldersResponse, filesResponse, policyResponse].some((result) => result.status === 401)) {
          onSessionExpired();
          return;
        }
        if (folderId && filesResponse.status === 404) {
          setFolderId(null);
          setSelectedFile(null);
          if (inputRef.current) inputRef.current.value = "";
          setItemFeedback({ kind: "error", message: "This folder is unavailable. You’re viewing My files." });
          return;
        }
        if (!foldersResponse.ok || !filesResponse.ok || !policyResponse.ok) {
          throw new Error("Workspace unavailable.");
        }

        const [{ folders }, { files }, policy] = (await Promise.all([
          foldersResponse.json(),
          filesResponse.json(),
          policyResponse.json(),
        ])) as [{ folders: Folder[] }, { files: StoredFile[] }, StoragePolicy];
        if (controller.signal.aborted) return;

        setWorkspace({ folders: new Map(folders.map((folder) => [folder.id, folder])), files, policy });
        setLoadStatus("ready");
      } catch {
        if (!controller.signal.aborted) setLoadStatus("error");
      }
    }

    void loadWorkspace();
    return () => controller.abort();
  }, [folderId, loadAttempt, onSessionExpired]);

  const currentFolder = folderId ? workspace?.folders.get(folderId) : undefined;
  const breadcrumbs = workspace ? folderTrail(folderId, workspace.folders) : [];
  const children = workspace
    ? Array.from(workspace.folders.values()).filter((folder) => folder.parentId === folderId)
      .sort((left, right) => folderSort.compare(left.name, right.name))
    : [];
  const canEdit = loadStatus === "ready" && !uploading && !signingOut;
  const policy = workspace?.policy;
  const formats = uploadFormats(policy?.allowedMimeTypes);

  function reloadWorkspace() {
    setLoadStatus("loading");
    setLoadAttempt((previous) => previous + 1);
  }

  function finishRevision(feedback: Feedback) {
    setRevisionFile(undefined);
    setItemFeedback(feedback);
    reloadWorkspace();
    headingRef.current?.focus();
  }

  function openFolder(id: string | null) {
    if (uploading || signingOut || id === folderId) return;
    if (inputRef.current) inputRef.current.value = "";
    setSelectedFile(null);
    setUploadFeedback(undefined);
    setItemFeedback(undefined);
    setLoadStatus("loading");
    setFolderId(id);
    headingRef.current?.focus();
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setUploadFeedback(undefined);
    setSelectedFile(null);
    if (!file || !policy) return;

    const error = validateFile(file, policy);
    if (error) {
      event.currentTarget.value = "";
      setUploadFeedback({ kind: "error", message: error });
      return;
    }
    setSelectedFile(file);
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile || !policy || !canEdit) return;

    const error = validateFile(selectedFile, policy);
    if (error) {
      setUploadFeedback({ kind: "error", message: error });
      return;
    }

    setUploading(true);
    setUploadPercent(undefined);
    setUploadFeedback(undefined);

    const query = new URLSearchParams({ size: String(selectedFile.size) });
    if (folderId) query.set("folderId", folderId);
    try {
      const { status, body } = await uploadFileRequest(`/api/files?${query}`, selectedFile, setUploadPercent);
      if (status === 401) {
        onSessionExpired();
        return;
      }
      if (status < 200 || status >= 300) {
        const fallback = uploadErrorMessage(status, policy);
        setUploadFeedback({ kind: "error", message: status === 415 ? responseMessage(body, fallback) : fallback });
        if (status === 404 || status === 409 || status === 413 || status === 415) reloadWorkspace();
        return;
      }

      if (inputRef.current) inputRef.current.value = "";
      setSelectedFile(null);
      setUploadFeedback({ kind: "success", message: `${selectedFile.name} uploaded.` });
      reloadWorkspace();
    } catch {
      setUploadFeedback({ kind: "error", message: uploadErrorMessage(0, policy) });
    } finally {
      setUploading(false);
    }
  }

  async function updateItem(currentAction: ItemAction, value: string) {
    let endpoint = "/api/folders";
    let body: Record<string, string | null>;
    if (currentAction.type === "create") {
      body = { name: value, parentId: folderId };
    } else if (currentAction.type === "trash") {
      endpoint = "/api/trash";
      body = { itemType: currentAction.item.type, itemId: currentAction.item.data.id };
    } else {
      const { item } = currentAction;
      endpoint = `/api/${item.type === "folder" ? "folders" : "files"}/${encodeURIComponent(item.data.id)}`;
      if (currentAction.type === "rename") {
        body = { name: value };
      } else {
        body = item.type === "folder" ? { parentId: value || null } : { folderId: value || null };
      }
    }

    try {
      const response = await fetch(endpoint, {
        method: currentAction.type === "create" || currentAction.type === "trash" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      if (!response.ok) return itemErrorMessage(response.status, currentAction);

      const message = currentAction.type === "create" ? `Folder ${value} created.`
        : currentAction.type === "rename" ? `Renamed to ${value}.`
        : currentAction.type === "trash" ? `${currentAction.item.data.name} moved to Trash.`
        : `${currentAction.item.data.name} moved to ${workspace?.folders.get(value)?.name ?? "My files"}.`;
      setItemFeedback({ kind: "success", message });
    } catch {
      return itemErrorMessage(0, currentAction);
    }
  }

  async function signOut() {
    setSigningOut(true);
    setSignOutFailed(false);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok && response.status !== 401) throw new Error("Sign-out failed.");
      window.location.replace("/");
    } catch {
      setSignOutFailed(true);
      setSigningOut(false);
    }
  }

  return (
    <>
      <Header user={user} onSignOut={signOut} signingOut={signingOut} uploading={uploading} />
      <main className="workspace">
        <div className="workspace-heading workspace-heading-with-nav">
          <div>
            <h1>My files</h1>
            <p>Organize and share files from your private workspace.</p>
          </div>
          <nav className="workspace-nav" aria-label="Workspace pages">
            <a className="button button-secondary" href="/trash" aria-disabled={uploading || signingOut}
              onClick={(event) => { if (uploading || signingOut) event.preventDefault(); }}>Trash</a>
            {canAdminister && <a className="button button-secondary" href="/admin" aria-disabled={uploading || signingOut}
              onClick={(event) => { if (uploading || signingOut) event.preventDefault(); }}>Administration</a>}
          </nav>
        </div>
        {breadcrumbs.length > 0 && (
          <nav className="breadcrumbs" aria-label="Folder path">
            <ol>
              <li><button type="button" disabled={uploading || signingOut} onClick={() => openFolder(null)}>My files</button></li>
              {breadcrumbs.map((folder) => (
                <li key={folder.id}>
                  <span aria-hidden="true" className="breadcrumb-separator">/</span>
                  {folder.id === folderId ? (
                    <span aria-current="location">{folder.name}</span>
                  ) : (
                    <button type="button" disabled={uploading || signingOut} onClick={() => openFolder(folder.id)}>
                      {folder.name}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        {signOutFailed && (
          <p className="notice notice-error signout-notice" role="alert">
            Sign-out could not be confirmed. Try signing out again.
          </p>
        )}
        <div className="workspace-grid">
          <section className="panel upload-panel" aria-labelledby="upload-title">
            <h2 id="upload-title">Upload a file</h2>
            {currentFolder && <p className="upload-destination">To {currentFolder.name}</p>}
            <p id="file-limits" className="panel-description">
              {fileTypeList.format(formats.map(({ name }) => name))}.{policy && ` Up to ${formatSize(policy.maxFileBytes)} per file.`}
            </p>
            {policy && (
              <p className="storage-summary">
                <strong>{formatSize(policy.availableBytes)} available</strong> of {formatSize(policy.quotaBytes)}
              </p>
            )}
            <form className="upload-form" onSubmit={submitUpload}>
              <label className="file-picker">
                <input
                  ref={inputRef}
                  className="visually-hidden"
                  type="file"
                  name="file"
                  accept={formats.flatMap(({ extensions }) => extensions).join(",")}
                  aria-describedby="file-limits"
                  disabled={!canEdit}
                  onChange={chooseFile}
                />
                <span className="button button-secondary">Choose file</span>
              </label>
              {selectedFile && (
                <p className="selection" role="status">
                  <span>{selectedFile.name}</span>
                  <span>{sizeFormat.format(selectedFile.size)} {selectedFile.size === 1 ? "byte" : "bytes"}</span>
                </p>
              )}
              <button className="button button-primary" type="submit" disabled={!selectedFile || !canEdit}>
                {uploading ? "Uploading…" : "Upload file"}
              </button>
              {uploading && (
                <div className="upload-progress">
                  <progress max={100} value={uploadPercent} aria-label="Upload progress" />
                  {uploadPercent === 100 && <p role="status">Saving the file…</p>}
                </div>
              )}
              {uploadFeedback && <WorkspaceNotice feedback={uploadFeedback} />}
            </form>
          </section>

          <section className="panel files-panel" aria-labelledby="files-title">
            <div className="files-heading">
              <h2 id="files-title" ref={headingRef} tabIndex={-1}>{currentFolder?.name ?? "Files"}</h2>
              <button className="button button-secondary" type="button" disabled={!canEdit}
                onClick={() => setAction({ type: "create" })}>
                New folder
              </button>
            </div>
            {itemFeedback && <WorkspaceNotice feedback={itemFeedback} className="item-notice" />}
            {loadStatus === "loading" && <p className="files-status" role="status">Loading files…</p>}
            {loadStatus === "error" && (
              <div className="files-status">
                <p role="alert">The workspace could not be loaded. Try again in a moment.</p>
                <button className="button button-secondary" type="button" onClick={reloadWorkspace}>
                  Reload files
                </button>
              </div>
            )}
            {loadStatus === "ready" && workspace && (
              children.length || workspace.files.length ? (
                <ul className="file-list">
                  {children.map((folder) => (
                    <li className="file-row" key={folder.id}>
                      <div className="file-type" aria-hidden="true"><span className="folder-icon" /></div>
                      <div className="file-info">
                        <button className="folder-link" type="button" disabled={!canEdit} onClick={() => openFolder(folder.id)}>
                          {folder.name}
                        </button>
                        <span className="file-meta">Folder</span>
                      </div>
                      <ItemActions item={{ type: "folder", data: folder }} disabled={!canEdit} onAction={setAction} onShare={setShareItem} />
                    </li>
                  ))}
                  {workspace.files.map((file) => (
                    <li className="file-row" key={file.id}>
                      <div className="file-type" aria-hidden="true">{fileExtension(file.name).slice(1).toUpperCase()}</div>
                      <div className="file-info">
                        <span className="file-name">{file.name}</span>
                        <span className="file-meta">{formatSize(file.size)}</span>
                        <RevisionDetails file={file} />
                      </div>
                      <ItemActions item={{ type: "file", data: file }} disabled={!canEdit}
                        onAction={setAction} onShare={setShareItem} onRevise={setRevisionFile} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="files-empty">
                  <div className="entry-icon" aria-hidden="true"><span className="folder-icon" /></div>
                  <p className="empty-title">No files or folders yet</p>
                  <p>Upload a file or create a folder here.</p>
                </div>
              )
            )}
          </section>
        </div>
      </main>
      {shareItem && (
        <ShareDialog item={shareItem} onClose={() => setShareItem(undefined)} onSessionExpired={onSessionExpired} />
      )}
      {revisionFile && (
        <RevisionDialog file={revisionFile} endpoint={`/api/files/${encodeURIComponent(revisionFile.id)}/revisions`}
          limits={policy} onClose={() => setRevisionFile(undefined)}
          onPublished={(version) => finishRevision({ kind: "success", message: `Version ${version} published.` })}
          onStale={() => finishRevision({ kind: "error", message: staleRevisionNotice })}
          onUnavailable={(status) => {
            if (status === 401) onSessionExpired();
            else finishRevision({ kind: "error", message: "This file is unavailable. Check your workspace." });
          }} />
      )}
      {action && workspace && (
        <ItemDialog
          action={action}
          folders={workspace.folders}
          onClose={() => setAction(undefined)}
          onSave={(value) => updateItem(action, value)}
          onSuccess={() => {
            reloadWorkspace();
            headingRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

function WorkspaceNotice({ feedback, className = "" }: { feedback: Feedback; className?: string }) {
  return (
    <p
      className={`notice notice-${feedback.kind} ${className}`}
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      {feedback.message}
    </p>
  );
}

function ItemActions({
  item,
  disabled,
  onAction,
  onShare,
  onRevise,
}: {
  item: Item;
  disabled: boolean;
  onAction: (action: ItemAction) => void;
  onShare: (item: Item) => void;
  onRevise?: (file: StoredFile) => void;
}) {
  return (
    <div className="item-actions">
      <button className="button button-secondary" type="button"
        aria-label={`Rename ${item.data.name}`} disabled={disabled}
        onClick={() => onAction({ type: "rename", item })}>
        Rename
      </button>
      <button className="button button-secondary" type="button"
        aria-label={`Move ${item.data.name}`} disabled={disabled}
        onClick={() => onAction({ type: "move", item })}>
        Move
      </button>
      <button className="button button-secondary" type="button"
        aria-label={`Share ${item.data.name}`} disabled={disabled} onClick={() => onShare(item)}>
        Share
      </button>
      <button className="button button-secondary" type="button"
        aria-label={`Move ${item.data.name} to trash`} disabled={disabled}
        onClick={() => onAction({ type: "trash", item })}>
        Move to trash
      </button>
      {item.type === "file" && (
        <>
          <button className="button button-secondary" type="button"
            aria-label={`Publish revision for ${item.data.name}`} disabled={disabled}
            onClick={() => onRevise?.(item.data)}>
            Revise
          </button>
          <a className="button button-secondary" href={`/api/files/${encodeURIComponent(item.data.id)}/download`}
            download aria-label={`Download ${item.data.name}`}>
            Download
          </a>
        </>
      )}
    </div>
  );
}

function ItemDialog({
  action,
  folders,
  onClose,
  onSave,
  onSuccess,
}: {
  action: ItemAction;
  folders: Map<string, Folder>;
  onClose: () => void;
  onSave: (value: string) => Promise<string | undefined>;
  onSuccess: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(action.type === "rename" ? action.item.data.name : "");
  const [destination, setDestination] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const moving = action.type === "move";
  const currentParent = moving
    ? action.item.type === "folder" ? action.item.data.parentId : action.item.data.folderId
    : null;
  const avoidFolderId = moving && action.item.type === "folder" ? action.item.data.id : null;
  const destinations = moving ? Array.from(folders.values())
    .map((folder) => ({ folder, trail: folderTrail(folder.id, folders) }))
    .filter(({ trail }) => !trail.some((folder) => folder.id === avoidFolderId))
    .map(({ folder, trail }) => ({ id: folder.id, label: trail.map((part) => part.name).join(" / ") }))
    .sort((left, right) => folderSort.compare(left.label, right.label))
    : [];
  const hasDestination = currentParent !== null || destinations.some((folder) => folder.id !== currentParent);
  const title = action.type === "create" ? "New folder" : action.type === "rename" ? "Rename item"
    : action.type === "trash" ? "Move to trash" : "Move item";
  const submitLabel = action.type === "create" ? "Create folder" : action.type === "rename" ? "Save name" : title;
  const renamesFile = action.type === "rename" && action.item.type === "file";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || (action.type === "move" && destination === undefined)) return;
    const nextValue = action.type === "move" ? destination ?? "" : value.trim();
    if (action.type === "create" || action.type === "rename") {
      const problem = validateName(nextValue);
      if (problem) {
        setError(problem);
        return;
      }
    }

    setSaving(true);
    setError(undefined);
    const problem = await onSave(nextValue);
    if (problem) {
      setError(problem);
      setSaving(false);
      return;
    }
    dialogRef.current?.close();
    onClose();
    onSuccess();
  }

  return (
    <dialog
      className="item-dialog"
      ref={dialogRef}
      aria-labelledby="item-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) {
          dialogRef.current?.close();
          onClose();
        }
      }}
    >
      <form onSubmit={save}>
        <h2 id="item-dialog-title">{title}</h2>
        {action.type !== "create" && <p className="dialog-item-name">{action.item.data.name}</p>}
        {action.type === "trash" ? (
          <p className="panel-description">
            {action.item.type === "folder" ? "This moves the folder and its contents to Trash." : "This moves the file to Trash."}
            {" "}Shared access pauses while the item is there. You can restore it before its recovery deadline.
          </p>
        ) : moving ? (
          <>
            <label htmlFor="destination">Destination folder</label>
            <select
              id="destination"
              value={destination ?? "unselected"}
              disabled={saving || !hasDestination}
              onChange={(event) => {
                setError(undefined);
                setDestination(event.target.value);
              }}
            >
              <option value="unselected" disabled>Choose a folder</option>
              <option value="" disabled={currentParent === null}>My files</option>
              {destinations.map((folder) => (
                <option key={folder.id} value={folder.id} disabled={folder.id === currentParent}>{folder.label}</option>
              ))}
            </select>
            {!hasDestination && <p className="panel-description">Create a destination folder before moving this item.</p>}
          </>
        ) : (
          <>
            <label htmlFor="item-name">{action.type === "create" ? "Folder name" : "New name"}</label>
            <input
              id="item-name"
              value={value}
              disabled={saving}
              aria-describedby={renamesFile ? "name-hint" : undefined}
              onChange={(event) => {
                setError(undefined);
                setValue(event.target.value);
              }}
            />
            {renamesFile && <p className="panel-description" id="name-hint">Keep the file extension.</p>}
          </>
        )}
        {error && <WorkspaceNotice feedback={{ kind: "error", message: error }} />}
        <div className="dialog-actions">
          <button className="button button-secondary" type="button" disabled={saving}
            onClick={() => {
              dialogRef.current?.close();
              onClose();
            }}>
            Cancel
          </button>
          <button className="button button-primary" type="submit" disabled={saving || (moving && destination === undefined)}>
            {saving ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
