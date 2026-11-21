"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type User = {
  id: string;
  username: string;
  displayName: string;
};

type StoredFile = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  createdAt: string;
};

type Session =
  | { status: "loading" | "error" }
  | { status: "signed-out"; message?: string }
  | { status: "signed-in"; user: User };

type FileList =
  | { status: "loading" | "error" }
  | { status: "ready"; files: StoredFile[] };

type UploadFeedback = { kind: "error" | "success"; message: string };

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const fileSizeFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${fileSizeFormat.format(bytes / 1024)} KiB`;
  }
  return `${fileSizeFormat.format(bytes / (1024 * 1024))} MiB`;
}

function callbackMessage() {
  const status = new URLSearchParams(window.location.search).get("auth");
  if (status === "denied") {
    return "This organization account does not have access. Sign in with an approved account or contact your administrator.";
  }
  if (status === "unavailable") {
    return "Sign-in is temporarily unavailable. Try again in a moment.";
  }
}

function validateFile(file: File) {
  if (!file.name.toLowerCase().endsWith(".png")) {
    return "Choose a PNG file.";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return "This file is larger than 10 MiB. Choose a smaller PNG.";
  }
  if (file.size === 0) {
    return "This file is empty. Choose a different PNG.";
  }
}

function uploadErrorMessage(status: number) {
  switch (status) {
    case 413:
      return "This file is larger than 10 MiB. Choose a smaller PNG.";
    case 415:
      return "The file could not be recognized as a PNG. Choose a different PNG.";
    case 400:
      return "The file could not be accepted. Check the file and its name, then try again.";
    case 403:
      return "This upload was blocked. Open the workspace again and retry.";
    default:
      return "Upload could not be confirmed. Reload the workspace to check your files before trying again.";
  }
}

export default function HomePage() {
  const [session, setSession] = useState<Session>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const expireSession = useCallback(() => {
    setSession({
      status: "signed-out",
      message: "Your session has ended. Sign in again to open your files.",
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function checkSession() {
      try {
        const response = await fetch("/api/auth/me", {
          cache: "no-store",
          signal: controller.signal,
        });

        if (response.status === 401) {
          setSession({ status: "signed-out", message: callbackMessage() });
          return;
        }
        if (!response.ok) throw new Error("Session check failed.");

        const { user } = (await response.json()) as { user: User };
        if (!controller.signal.aborted) {
          setSession({ status: "signed-in", user });
        }
      } catch {
        if (!controller.signal.aborted) setSession({ status: "error" });
      }
    }

    void checkSession();
    return () => controller.abort();
  }, [attempt]);

  if (session.status === "signed-in") {
    return <Workspace user={session.user} onSessionExpired={expireSession} />;
  }

  return (
    <>
      <Header />
      <main className="entry">
        <section className="entry-card" aria-labelledby="entry-title">
          <div className="entry-icon" aria-hidden="true">
            <span className="folder-icon" />
          </div>
          <h1 id="entry-title">Your file workspace</h1>
          <p className="entry-description">
            Sign in with your organization account to upload and download your files.
          </p>
          {session.status === "loading" && (
            <p className="entry-status" role="status">Checking your session…</p>
          )}
          {session.status === "error" && (
            <>
              <p className="notice notice-error" role="alert">
                We couldn’t check your session. Check your connection and try again.
              </p>
              <button
                className="button button-primary"
                onClick={() => {
                  setSession({ status: "loading" });
                  setAttempt((previous) => previous + 1);
                }}
              >
                Try again
              </button>
            </>
          )}
          {session.status === "signed-out" && (
            <>
              {session.message && (
                <p className="notice notice-error" role="alert">{session.message}</p>
              )}
              <a className="button button-primary" href="/api/auth/login">Sign in</a>
            </>
          )}
        </section>
      </main>
    </>
  );
}

function Header({
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

function Workspace({
  user,
  onSessionExpired,
}: {
  user: User;
  onSessionExpired: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileList, setFileList] = useState<FileList>({ status: "loading" });
  const [listAttempt, setListAttempt] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<UploadFeedback>();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadFiles() {
      try {
        const response = await fetch("/api/files", {
          cache: "no-store",
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        if (!response.ok) throw new Error("File list unavailable.");

        const { files } = (await response.json()) as { files: StoredFile[] };
        if (!controller.signal.aborted) setFileList({ status: "ready", files });
      } catch {
        if (!controller.signal.aborted) setFileList({ status: "error" });
      }
    }

    void loadFiles();
    return () => controller.abort();
  }, [listAttempt, onSessionExpired]);

  function retryFileList() {
    setFileList({ status: "loading" });
    setListAttempt((previous) => previous + 1);
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setUploadFeedback(undefined);
    setSelectedFile(null);
    if (!file) return;

    const error = validateFile(file);
    if (error) {
      event.currentTarget.value = "";
      setUploadFeedback({ kind: "error", message: error });
      return;
    }
    setSelectedFile(file);
  }

  async function uploadFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile || uploading || signingOut || fileList.status === "loading") {
      return;
    }

    setUploading(true);
    setUploadFeedback(undefined);

    const form = new FormData();
    form.set("file", selectedFile);

    try {
      const response = await fetch("/api/files", { method: "POST", body: form });

      if (response.status === 401) {
        onSessionExpired();
        return;
      }

      if (!response.ok) {
        setUploadFeedback({ kind: "error", message: uploadErrorMessage(response.status) });
        return;
      }

      const { file } = (await response.json()) as { file: StoredFile };
      if (fileList.status === "ready") {
        setFileList({ status: "ready", files: [file, ...fileList.files] });
      } else {
        retryFileList();
      }
      if (inputRef.current) inputRef.current.value = "";
      setSelectedFile(null);
      setUploadFeedback({ kind: "success", message: `${file.name} uploaded.` });
    } catch {
      setUploadFeedback({
        kind: "error",
        message: "Upload could not be confirmed. Reload the workspace to check your files before trying again.",
      });
    } finally {
      setUploading(false);
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
      <Header
        user={user}
        onSignOut={signOut}
        signingOut={signingOut}
        uploading={uploading}
      />
      <main className="workspace">
        <div className="workspace-heading">
          <h1>My files</h1>
          <p>Upload and download files in your private workspace.</p>
        </div>
        {signOutFailed && (
          <p className="notice notice-error signout-notice" role="alert">
            Sign-out could not be confirmed. Try signing out again.
          </p>
        )}
        <div className="workspace-grid">
          <section className="panel upload-panel" aria-labelledby="upload-title">
            <h2 id="upload-title">Upload a file</h2>
            <p id="file-limits" className="panel-description">PNG only, up to 10 MiB.</p>
            <form className="upload-form" onSubmit={uploadFile}>
              <label className="file-picker">
                <input
                  ref={inputRef}
                  className="visually-hidden"
                  type="file"
                  name="file"
                  accept=".png,image/png"
                  aria-describedby="file-limits"
                  disabled={uploading || signingOut}
                  onChange={chooseFile}
                />
                <span className="button button-secondary">Choose PNG</span>
              </label>
              {selectedFile && (
                <p className="selection" role="status">
                  <span>{selectedFile.name}</span>
                  <span>{formatFileSize(selectedFile.size)}</span>
                </p>
              )}
              <button
                className="button button-primary"
                type="submit"
                disabled={!selectedFile || uploading || signingOut || fileList.status === "loading"}
              >
                {uploading ? "Uploading…" : "Upload file"}
              </button>
              {uploadFeedback && (
                <p
                  className={`notice notice-${uploadFeedback.kind}`}
                  role={uploadFeedback.kind === "error" ? "alert" : "status"}
                >
                  {uploadFeedback.message}
                </p>
              )}
            </form>
          </section>

          <section className="panel files-panel" aria-labelledby="files-title">
            <div className="files-heading">
              <h2 id="files-title">Files</h2>
              {fileList.status === "ready" && (
                <span className="files-count">
                  {fileList.files.length} {fileList.files.length === 1 ? "file" : "files"}
                </span>
              )}
            </div>
            {fileList.status === "loading" && (
              <p className="files-status" role="status">Loading files…</p>
            )}
            {fileList.status === "error" && (
              <div className="files-status">
                <p role="alert">Files could not be loaded. Try again in a moment.</p>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={retryFileList}
                  disabled={uploading}
                >
                  Reload files
                </button>
              </div>
            )}
            {fileList.status === "ready" && (
              fileList.files.length ? (
                <ul className="file-list">
                  {fileList.files.map((file) => (
                    <li className="file-row" key={file.id}>
                      <div className="file-type" aria-hidden="true">PNG</div>
                      <div className="file-info">
                        <span className="file-name">{file.name}</span>
                        <span className="file-meta">
                          {formatFileSize(file.size)}
                          <span aria-hidden="true"> · </span>
                          <time dateTime={file.createdAt}>{dateFormat.format(new Date(file.createdAt))}</time>
                        </span>
                      </div>
                      <a
                        className="button button-secondary"
                        href={`/api/files/${encodeURIComponent(file.id)}/download`}
                        download
                        aria-label={`Download ${file.name}`}
                      >
                        Download
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="files-empty">
                  <div className="entry-icon" aria-hidden="true">
                    <span className="folder-icon" />
                  </div>
                  <p className="empty-title">No files yet</p>
                  <p>Choose a PNG to add your first file.</p>
                </div>
              )
            )}
          </section>
        </div>
      </main>
    </>
  );
}
