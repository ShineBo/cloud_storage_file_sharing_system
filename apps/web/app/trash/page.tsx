"use client";

import { useEffect, useRef, useState } from "react";
import { responseMessage } from "../file-transfer";
import { localDateTime } from "../local-date-time";
import { AppShell, useSession } from "../app-shell";

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

export default function TrashPage() {
  const { user } = useSession();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const focusAfterRefresh = useRef(false);
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

  useEffect(() => {
    if (state.status !== "loading" && focusAfterRefresh.current) {
      focusAfterRefresh.current = false;
      if (document.activeElement === document.body) {
        (refreshRef.current ?? headingRef.current)?.focus();
      }
    }
  }, [state.status]);

  function refresh(returnFocus = true) {
    focusAfterRefresh.current = returnFocus;
    setState({ status: "loading" });
    setAttempt((previous) => previous + 1);
  }

  async function restore(item: TrashItem, trigger: HTMLButtonElement) {
    if (restoringId) return;
    setNotice(undefined);
    setRestoringId(item.id);
    try {
      const response = await fetch(`/api/trash/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
      if (response.status === 401) {
        if (document.activeElement === trigger) headingRef.current?.focus();
        setState({ status: "signed-out" });
        return;
      }
      if (!response.ok) {
        const fallback = "The item could not be restored. Refresh Trash and try again.";
        setNotice({ kind: "error", message: responseMessage(await response.json().catch(() => undefined), fallback) });
        if (response.status === 404 || response.status === 410) refresh(document.activeElement === trigger);
        return;
      }
      if (document.activeElement === trigger) resultsRef.current?.focus();
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
    <AppShell section="trash" user={state.status === "signed-out" ? null : user} navigationLocked={!!restoringId}>
      <main className="workspace management-page">
        <div className="workspace-heading">
          <h1 ref={headingRef} tabIndex={-1}>Trash</h1>
          <p>Restore items to their original location before the recovery deadline. Share links that are still valid can resume access after a restore.</p>
        </div>
        {notice && <p className={`notice notice-${notice.kind} management-notice`}
          role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</p>}
        {state.status === "loading" && <p className="entry-status" role="status">Loading Trash…</p>}
        {state.status === "signed-out" && (
          <div className="panel management-panel">
            <p className="notice notice-error" role="alert">Sign in to open your Trash.</p>
            <a className="button button-primary" href="/api/auth/login">Sign in</a>
          </div>
        )}
        {state.status === "error" && (
          <div className="panel management-panel">
            <p className="notice notice-error" role="alert">Trash is temporarily unavailable.</p>
            <button className="button button-secondary" type="button" onClick={() => refresh()}>Try again</button>
          </div>
        )}
        {state.status === "ready" && (
          <section className="panel management-panel" aria-labelledby="trash-title">
            <div className="files-heading management-heading">
              <h2 id="trash-title" ref={resultsRef} tabIndex={-1}>Deleted items</h2>
              <button className="button button-secondary" type="button" ref={refreshRef}
                disabled={restoringId !== undefined} onClick={() => refresh()}>
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
                        <time dateTime={item.deletedAt}>{localDateTime.format(new Date(item.deletedAt))}</time>
                      </span>
                      <span className="file-meta">{item.canRestore ? "Restore by " : "Recovery window ended "}
                        <time dateTime={item.restoreUntil}>{localDateTime.format(new Date(item.restoreUntil))}</time>
                      </span>
                    </div>
                    {item.canRestore && <button className="button button-secondary" type="button"
                      disabled={restoringId !== undefined && restoringId !== item.id}
                      aria-disabled={restoringId === item.id || undefined}
                      aria-label={`Restore ${item.name}`} onClick={(event) => void restore(item, event.currentTarget)}>
                      {restoringId === item.id ? "Restoring…" : "Restore"}
                    </button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
    </AppShell>
  );
}
