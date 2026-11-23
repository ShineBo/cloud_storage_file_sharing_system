"use client";

import { useEffect, useState } from "react";
import { responseMessage } from "../file-transfer";
import { Header } from "../workspace";

type TrashItem = {
  id: string;
  itemType: "file" | "folder";
  itemId: string;
  name: string;
  deletedAt: string;
  restoreUntil: string;
  canRestore: boolean;
};
type State = { status: "loading" | "error" | "signed-out" } | { status: "ready"; items: TrashItem[] };
type Notice = { kind: "error" | "success"; message: string };

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export default function TrashPage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [restoringId, setRestoringId] = useState<string>();
  const [notice, setNotice] = useState<Notice>();

  useEffect(() => {
    const controller = new AbortController();
    async function loadTrash() {
      try {
        const response = await fetch("/api/trash", { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          setState({ status: "signed-out" });
          return;
        }
        if (!response.ok) throw new Error("Trash unavailable.");
        const { items } = await response.json() as { items: TrashItem[] };
        if (!controller.signal.aborted) setState({ status: "ready", items });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    }
    void loadTrash();
    return () => controller.abort();
  }, [attempt]);

  function refresh() {
    setState({ status: "loading" });
    setAttempt((previous) => previous + 1);
  }

  async function restore(item: TrashItem) {
    if (restoringId) return;
    setNotice(undefined);
    setRestoringId(item.id);
    try {
      const response = await fetch(`/api/trash/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
      if (response.status === 401) {
        setState({ status: "signed-out" });
        return;
      }
      if (!response.ok) {
        const fallback = "The item could not be restored. Refresh Trash and try again.";
        setNotice({ kind: "error", message: responseMessage(await response.json().catch(() => undefined), fallback) });
        if (response.status === 404 || response.status === 410) refresh();
        return;
      }
      setState((previous) => previous.status === "ready"
        ? { ...previous, items: previous.items.filter(({ id }) => id !== item.id) } : previous);
      setNotice({ kind: "success", message: `${item.name} restored.` });
    } catch {
      setNotice({ kind: "error", message: "Restoration could not be confirmed. Refresh Trash before trying again." });
    } finally {
      setRestoringId(undefined);
    }
  }

  return (
    <>
      <Header />
      <main className="workspace management-page">
        <a className="shared-back" href="/">My files</a>
        <div className="workspace-heading">
          <h1>Trash</h1>
          <p>Restore items to their original location before the recovery deadline. Share links that are still valid can resume access after a restore.</p>
        </div>
        {notice && <p className={`notice notice-${notice.kind} management-notice`}
          role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</p>}
        {state.status === "loading" && <p className="entry-status" role="status">Loading Trash…</p>}
        {state.status === "signed-out" && (
          <p className="notice notice-error" role="alert">Sign in to open your Trash.</p>
        )}
        {state.status === "error" && (
          <div className="panel management-panel">
            <p className="notice notice-error" role="alert">Trash is temporarily unavailable.</p>
            <button className="button button-secondary" type="button" onClick={refresh}>Try again</button>
          </div>
        )}
        {state.status === "ready" && (
          <section className="panel management-panel" aria-labelledby="trash-title">
            <div className="files-heading management-heading">
              <h2 id="trash-title">Deleted items</h2>
              <button className="button button-secondary" type="button" disabled={restoringId !== undefined} onClick={refresh}>
                Refresh
              </button>
            </div>
            {state.items.length === 0 ? <p className="panel-description">Trash is empty.</p> : (
              <ul className="management-list">
                {state.items.map((item) => (
                  <li key={item.id}>
                    <div className="file-info">
                      <span className="file-name">{item.name}</span>
                      <span className="file-meta">{item.itemType === "folder" ? "Folder" : "File"}{" · Moved to Trash "}
                        <time dateTime={item.deletedAt}>{dateTime.format(new Date(item.deletedAt))}</time>
                      </span>
                      <span className="file-meta">{item.canRestore ? "Restore by " : "Recovery window ended "}
                        <time dateTime={item.restoreUntil}>{dateTime.format(new Date(item.restoreUntil))}</time>
                      </span>
                    </div>
                    {item.canRestore && <button className="button button-secondary" type="button"
                      disabled={restoringId !== undefined} aria-label={`Restore ${item.name}`} onClick={() => void restore(item)}>
                      {restoringId === item.id ? "Restoring…" : "Restore"}
                    </button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
    </>
  );
}
