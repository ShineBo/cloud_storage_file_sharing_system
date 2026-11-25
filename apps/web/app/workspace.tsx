"use client";

import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppShell, type SessionUser } from "./app-shell";
import { FilePreview } from "./file-preview";
import { fileExtension, formatSize, responseMessage, uploadFileRequest, uploadFormats } from "./file-transfer";
import { RevisionDetails, RevisionDialog, staleRevisionNotice, type Revision } from "./revision-dialog";
import { ShareDialog } from "./share-dialog";

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
  mimeType: string;
};

type StoragePolicy = {
  maxFileBytes: number;
  quotaBytes: number;
  usedBytes: number;
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
type FileSort = "recent" | "name";

const fileTypeList = new Intl.ListFormat("en", { type: "conjunction" });
const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const sortByName = new Intl.Collator(undefined, { numeric: true }).compare;

function readFileSort(key: string): FileSort {
  try {
    return window.localStorage.getItem(key) === "name" ? "name" : "recent";
  } catch {
    return "recent";
  }
}

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

function folderFromLocation() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("folder");
}

function setFolderLocation(id: string | null, replace = false) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("folder", id);
  else url.searchParams.delete("folder");
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

export function Workspace({
  user,
  onSessionExpired,
}: {
  user: SessionUser;
  onSessionExpired: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sortKey = `cloud-storage:files-sort:${user.id}`;
  const [fileSort, setFileSort] = useState(() => readFileSort(sortKey));
  const [folderId, setFolderId] = useState(folderFromLocation);
  const [search, setSearch] = useState("");
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
  const [previewFile, setPreviewFile] = useState<StoredFile>();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    function syncFolder() {
      const nextId = folderFromLocation();
      if (nextId === folderId) return;
      if (uploading) {
        setFolderLocation(folderId, true);
        return;
      }
      if (inputRef.current) inputRef.current.value = "";
      setSelectedFile(null);
      setSearch("");
      setUploadFeedback(undefined);
      setItemFeedback(undefined);
      setLoadStatus("loading");
      setFolderId(nextId);
    }
    window.addEventListener("popstate", syncFolder);
    return () => window.removeEventListener("popstate", syncFolder);
  }, [folderId, uploading]);

  useEffect(() => {
    if (!uploading) return;
    function warnLeaving(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnLeaving);
    return () => window.removeEventListener("beforeunload", warnLeaving);
  }, [uploading]);

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
        if (folderId && [400, 404].includes(filesResponse.status)) {
          setFolderLocation(null, true);
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
      .sort((left, right) => sortByName(left.name, right.name))
    : [];
  const files = workspace?.files ?? [];
  const query = search.trim().toLocaleLowerCase();
  const matches = ({ name }: { name: string }) => name.toLocaleLowerCase().includes(query);
  const visibleFolders = children.filter(matches);
  const matchedFiles = files.filter(matches);
  const listedFiles = fileSort === "name"
    ? matchedFiles.toSorted((left, right) => sortByName(left.name, right.name)) : matchedFiles;
  const resultCount = visibleFolders.length + listedFiles.length;
  const canEdit = loadStatus === "ready" && !uploading;
  const policy = workspace?.policy;
  const formats = uploadFormats(policy?.allowedMimeTypes);

  function changeFileSort(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.currentTarget.value === "name" ? "name" : "recent";
    setFileSort(value);
    try {
      window.localStorage.setItem(sortKey, value);
    } catch {
      // Sorting still works for the current visit when browser storage is unavailable.
    }
  }

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
    if (uploading || id === folderId) return;
    setFolderLocation(id);
    if (inputRef.current) inputRef.current.value = "";
    setSearch("");
    setSelectedFile(null);
    setUploadFeedback(undefined);
    setItemFeedback(undefined);
    setLoadStatus("loading");
    setFolderId(id);
    headingRef.current?.focus();
  }

  function selectFile(file: File) {
    if (!policy || !canEdit) return;
    const error = validateFile(file, policy);
    setSelectedFile(error ? null : file);
    setUploadFeedback(error ? { kind: "error", message: error } : undefined);
    if (error && inputRef.current) inputRef.current.value = "";
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) selectFile(file);
  }

  function dropFile(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (!canEdit) return;
    if (event.dataTransfer.files.length !== 1) {
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = "";
      setUploadFeedback({ kind: "error", message: "Drop one file at a time." });
      return;
    }
    if (inputRef.current) inputRef.current.value = "";
    selectFile(event.dataTransfer.files[0]);
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

  return (
    <AppShell user={user} section="files" navigationLocked={uploading}>
      <main className="workspace file-workspace">
        <header className="workspace-heading page-heading workspace-hero">
          <div>
            <h1>My files</h1>
            <p>Organize, preview, and share files from your private workspace.</p>
          </div>
          <button className="button button-secondary" type="button" disabled={!canEdit}
            onClick={() => setAction({ type: "create" })}>
            <span className="button-plus" aria-hidden="true">+</span> New folder
          </button>
        </header>
        <div className="workspace-grid file-workspace-grid">
          <section className="panel files-panel" aria-labelledby="files-title">
            <div className="files-heading file-browser-heading">
              <div>
                {breadcrumbs.length > 0 && (
                  <nav className="breadcrumbs" aria-label="Folder path">
                    <ol>
                      <li><button type="button" disabled={uploading} onClick={() => openFolder(null)}>My files</button></li>
                      {breadcrumbs.slice(0, -1).map((folder) => (
                        <li key={folder.id}>
                          <span aria-hidden="true" className="breadcrumb-separator">/</span>
                          <button type="button" disabled={uploading} onClick={() => openFolder(folder.id)}>
                            {folder.name}
                          </button>
                        </li>
                      ))}
                    </ol>
                  </nav>
                )}
                <h2 id="files-title" ref={headingRef} tabIndex={-1}>{currentFolder?.name ?? "Files"}</h2>
                {loadStatus === "ready" && <p className="file-meta" role="status">
                  {resultCount} {resultCount === 1 ? "item" : "items"}{query ? " found" : ""}
                </p>}
              </div>
              <div className="files-heading-actions file-browser-controls">
                <label className="file-search">
                  <span className="visually-hidden">Search this folder</span>
                  <span className="search-icon" aria-hidden="true" />
                  <input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)}
                    placeholder="Search this folder" disabled={loadStatus !== "ready"} />
                </label>
                <div className="file-sort">
                  <label className="visually-hidden" htmlFor="file-sort">Sort files</label>
                  <span className="file-sort-label" aria-hidden="true">Sort</span>
                  <select id="file-sort" value={fileSort} disabled={!canEdit} onChange={changeFileSort}>
                    <option value="recent">Newest first</option>
                    <option value="name">Name A–Z</option>
                  </select>
                </div>
              </div>
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
              resultCount ? (
                <ul className="file-list">
                  {visibleFolders.map((folder) => (
                    <li className="file-row" key={folder.id}>
                      <div className="file-type file-type-folder" aria-hidden="true"><span className="folder-icon" /></div>
                      <div className="file-info">
                        <button className="folder-link" type="button" disabled={!canEdit} onClick={() => openFolder(folder.id)}>
                          {folder.name}
                        </button>
                        <span className="file-meta">Folder</span>
                      </div>
                      <ItemActions item={{ type: "folder", data: folder }} disabled={!canEdit} onAction={setAction} onShare={setShareItem} />
                    </li>
                  ))}
                  {listedFiles.map((file) => (
                    <li className="file-row" key={file.id}>
                      <div className="file-type" data-type={fileExtension(file.name)} aria-hidden="true">
                        {fileExtension(file.name).slice(1).toUpperCase()}
                      </div>
                      <div className="file-info">
                        <button className="folder-link" type="button" disabled={!canEdit} onClick={() => setPreviewFile(file)}>
                          {file.name}
                        </button>
                        <span className="file-meta">{formatSize(file.size)}</span>
                      </div>
                      <ItemActions item={{ type: "file", data: file }} disabled={!canEdit}
                        onAction={setAction} onShare={setShareItem} onRevise={setRevisionFile} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="files-empty">
                  <div className="entry-icon" aria-hidden="true"><span className="folder-icon" /></div>
                  <p className="empty-title">{query ? "No matches in this folder" : "No files or folders yet"}</p>
                  {query ? <button className="button button-secondary" onClick={() => setSearch("")}>Clear search</button>
                    : <p>Upload a file or create a folder here.</p>}
                </div>
              )
            )}
          </section>
          <aside className="workspace-tools" aria-label="File tools">
            <section className="panel upload-panel" aria-labelledby="upload-title">
              <h2 id="upload-title">Upload a file</h2>
              <p className="upload-destination">To {currentFolder?.name ?? "My files"}</p>
              <form className="upload-form" onSubmit={submitUpload}>
                <label className={`file-picker upload-drop${dragging ? " upload-drop-active" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (canEdit && event.dataTransfer.types.includes("Files")) setDragging(true);
                  }}
                  onDragLeave={(event) => {
                    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
                  }}
                  onDrop={dropFile}>
                  <input ref={inputRef} className="visually-hidden" type="file" name="file"
                    accept={formats.flatMap(({ extensions }) => extensions).join(",")}
                    aria-label="Choose file" aria-describedby="file-limits" disabled={!canEdit} onChange={chooseFile} />
                  <span className="upload-arrow" aria-hidden="true">↑</span>
                  <span className="button button-secondary">Choose file</span>
                  <small>or drop a file here</small>
                </label>
                <p id="file-limits" className="panel-description">
                  {fileTypeList.format(formats.map(({ name }) => name))}{policy && ` · Up to ${formatSize(policy.maxFileBytes)}`}
                </p>
                {selectedFile && <p className="selection" role="status">
                  <span>{selectedFile.name}</span>
                  <span>{sizeFormat.format(selectedFile.size)} {selectedFile.size === 1 ? "byte" : "bytes"}</span>
                </p>}
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
            {policy && (
              <section className="panel quota-panel" aria-labelledby="storage-title">
                <h2 id="storage-title">Storage quota</h2>
                <div className="quota-overview">
                  <p className="quota-used" title={`${sizeFormat.format(policy.usedBytes)} bytes used`}>
                    <strong>{formatSize(policy.usedBytes)}</strong> used
                  </p>
                  <p className="quota-limit">of {formatSize(policy.quotaBytes)}</p>
                </div>
                <meter min={0} max={policy.quotaBytes} value={policy.quotaBytes - policy.availableBytes}
                  aria-label="Used or reserved storage" />
                <p className="storage-summary" title={`${sizeFormat.format(policy.availableBytes)} bytes available`}>
                  {formatSize(policy.availableBytes)} available
                </p>
                <p className="file-meta">Older revisions and files in Trash count toward your account quota.</p>
              </section>
            )}
          </aside>
        </div>
      </main>
      {previewFile && <OwnedPreview file={previewFile} onClose={() => setPreviewFile(undefined)} />}
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
    </AppShell>
  );
}

function OwnedPreview({ file, onClose }: { file: StoredFile; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [attempt, setAttempt] = useState(0);
  const endpoint = `/api/files/${encodeURIComponent(file.id)}`;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return <dialog ref={dialog} className="item-dialog preview-dialog" aria-labelledby="preview-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="preview-heading">
      <div>
        <h2 id="preview-title">{file.name}</h2>
        <p className="file-meta">{formatSize(file.size)}</p>
        <RevisionDetails file={file} />
      </div>
      <button className="button button-secondary" onClick={onClose}>Close preview</button>
    </div>
    <FilePreview key={attempt} file={file} url={`${endpoint}/view`} onReload={() => setAttempt((previous) => previous + 1)} />
    <a className="button button-primary preview-download" download href={`${endpoint}/download`}>Download file</a>
  </dialog>;
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
  const menu = useRef<HTMLDetailsElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) menu.current?.removeAttribute("open");
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menuOpen]);

  function dismissMenu() {
    if (!menu.current) return;
    menu.current.open = false;
    menu.current.querySelector("summary")?.focus();
  }

  return (
    <div className="item-actions browser-actions">
      <button className="button button-secondary" type="button"
        aria-label={`Share ${item.data.name}`} disabled={disabled} onClick={() => onShare(item)}>
        Share
      </button>
      {item.type === "file" && (
        <a className="button button-secondary" href={`/api/files/${encodeURIComponent(item.data.id)}/download`}
          download aria-label={`Download ${item.data.name}`} aria-disabled={disabled || undefined}
          onClick={(event) => { if (disabled) event.preventDefault(); }}>
          Download
        </a>
      )}
      <details ref={menu} className="item-menu" onToggle={(event) => setMenuOpen(event.currentTarget.open)}
        onKeyDown={(event) => { if (event.key === "Escape") dismissMenu(); }}>
        <summary className="button button-secondary" aria-label={`More actions for ${item.data.name}`}
          aria-disabled={disabled || undefined} onClick={(event) => { if (disabled) event.preventDefault(); }}>
          <span aria-hidden="true">⋯</span>
        </summary>
        <div className="item-menu-list">
          <button type="button" aria-label={`Rename ${item.data.name}`} disabled={disabled}
            onClick={() => { dismissMenu(); onAction({ type: "rename", item }); }}>Rename</button>
          <button type="button" aria-label={`Move ${item.data.name}`} disabled={disabled}
            onClick={() => { dismissMenu(); onAction({ type: "move", item }); }}>Move</button>
          {item.type === "file" && <button type="button"
            aria-label={`Publish revision for ${item.data.name}`} disabled={disabled}
            onClick={() => { dismissMenu(); onRevise?.(item.data); }}>Publish revision</button>}
          <button className="item-menu-danger" type="button"
            aria-label={`Move ${item.data.name} to trash`} disabled={disabled}
            onClick={() => { dismissMenu(); onAction({ type: "trash", item }); }}>Move to trash</button>
        </div>
      </details>
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
    .sort((left, right) => sortByName(left.label, right.label))
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
