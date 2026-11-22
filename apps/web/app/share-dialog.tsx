"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

type RecipientType = "employee" | "group";
type Permission = "view" | "edit";

type RecipientDirectory = {
  employees: { id: string; username: string; displayName: string }[];
  groups: { id: string; name: string }[];
};

type Share = {
  id: string;
  link: string;
  recipientName: string;
  permission: Permission;
  allowDownload: boolean;
  expiresAt: string;
  revokedAt: string | null;
};

type ShareDialogProps = {
  item: { type: "file" | "folder"; data: { id: string; name: string } };
  onClose: () => void;
  onSessionExpired: () => void;
};

const expiryFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

async function shareError(response: Response, fallback: string) {
  if (response.status >= 400 && response.status < 500) {
    const body = await response.json().catch(() => undefined) as { message?: unknown } | undefined;
    if (typeof body?.message === "string") return body.message;
  }
  return fallback;
}

function absoluteLink(share: Share) {
  return new URL(share.link, window.location.origin).href;
}

export function ShareDialog({ item, onClose, onSessionExpired }: ShareDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestId = useRef<string>(null);
  const [attempt, setAttempt] = useState(0);
  const [directory, setDirectory] = useState<RecipientDirectory>();
  const [shares, setShares] = useState<Share[]>([]);
  const [recipientType, setRecipientType] = useState<RecipientType>("employee");
  const [recipientId, setRecipientId] = useState("");
  const [permission, setPermission] = useState<Permission>("view");
  const [allowDownload, setAllowDownload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const recipients = recipientType === "employee"
    ? directory?.employees.map((employee) => ({
      id: employee.id,
      name: `${employee.displayName} (${employee.username})`,
    }))
    : directory?.groups;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ itemType: item.type, itemId: item.data.id });

    async function loadShares() {
      try {
        const options = { cache: "no-store", signal: controller.signal } as const;
        const [directoryResponse, sharesResponse] = await Promise.all([
          fetch("/api/shares/recipients", options),
          fetch(`/api/shares?${params}`, options),
        ]);
        if (controller.signal.aborted) return;
        if (directoryResponse.status === 401 || sharesResponse.status === 401) {
          onSessionExpired();
          return;
        }
        if (!directoryResponse.ok || !sharesResponse.ok) throw new Error("Could not load sharing.");
        const [recipients, { shares }] = await Promise.all([
          directoryResponse.json() as Promise<RecipientDirectory>,
          sharesResponse.json() as Promise<{ shares: Share[] }>,
        ]);
        if (controller.signal.aborted) return;
        setDirectory(recipients);
        setShares(shares);
      } catch {
        if (!controller.signal.aborted) setLoadError(true);
      }
    }

    void loadShares();
    return () => controller.abort();
  }, [attempt, item.type, item.data.id, onSessionExpired]);

  async function createShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !recipientId) return;
    setError(undefined);
    setNotice(undefined);
    setBusy(true);

    try {
      requestId.current ??= crypto.randomUUID();
      const response = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemType: item.type,
          itemId: item.data.id,
          recipientType,
          recipientId,
          permission,
          allowDownload,
          requestId: requestId.current,
        }),
      });
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      if (!response.ok) {
        setError(await shareError(response, "Link creation could not be confirmed. Try creating the link again."));
        return;
      }

      const { share }: { share: Share } = await response.json();
      setShares((previous) => [share, ...previous.filter(({ id }) => id !== share.id)]);
      setRecipientId("");
      requestId.current = null;
      setNotice(`Link created for ${share.recipientName}.`);
    } catch {
      setError("Link creation could not be confirmed. Try creating the link again.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeShare(share: Share) {
    if (busy) return;
    setError(undefined);
    setNotice(undefined);
    setBusy(true);

    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(share.id)}/revoke`, { method: "POST" });
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      if (!response.ok) {
        setError(await shareError(response, "Revocation could not be confirmed. Try again."));
        return;
      }
      const { share: revoked }: { share: Share } = await response.json();
      setShares((previous) => previous.map((entry) => entry.id === revoked.id ? revoked : entry));
      setNotice(`Link revoked for ${share.recipientName}.`);
    } catch {
      setError("Revocation could not be confirmed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(share: Share) {
    setError(undefined);
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(absoluteLink(share));
      setNotice("Link copied.");
    } catch {
      const input = dialogRef.current?.querySelector<HTMLInputElement>(`#link-${share.id}`);
      input?.focus();
      input?.select();
      setNotice("Copy the selected link using your keyboard.");
    }
  }

  return (
    <dialog
      className="item-dialog share-dialog"
      ref={dialogRef}
      aria-labelledby="share-dialog-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    >
      <div className="share-dialog-heading">
        <div>
          <h2 id="share-dialog-title">Share item</h2>
          <p className="dialog-item-name">{item.data.name}</p>
        </div>
        <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Close</button>
      </div>
      {loadError ? (
        <>
          <p className="notice notice-error" role="alert">Sharing could not be loaded. Try again in a moment.</p>
          <button className="button button-secondary share-retry" type="button" onClick={() => {
            setLoadError(false);
            setAttempt((previous) => previous + 1);
          }}>Try again</button>
        </>
      ) : !directory ? <p className="entry-status" role="status">Loading sharing…</p> : (
        <>
          <form onSubmit={createShare}>
            <div className="share-fields">
              <div>
                <label htmlFor="recipient-type">Recipient type</label>
                <select id="recipient-type" value={recipientType} disabled={busy} onChange={(event) => {
                  setRecipientType(event.currentTarget.value as RecipientType);
                  setRecipientId("");
                  requestId.current = null;
                }}>
                  <option value="employee">Employee</option>
                  <option value="group">Approved group</option>
                </select>
              </div>
              <div>
                <label htmlFor="recipient">Recipient</label>
                <select id="recipient" value={recipientId} disabled={busy || !recipients?.length} required onChange={(event) => {
                  setRecipientId(event.currentTarget.value);
                  requestId.current = null;
                }}>
                  <option value="">{recipients?.length ? "Choose a recipient" : "No recipients available"}</option>
                  {recipients?.map((recipient) => (
                    <option key={recipient.id} value={recipient.id}>{recipient.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="share-fields">
              <div>
                <label htmlFor="share-permission">Permission</label>
                <select id="share-permission" value={permission} disabled={busy} onChange={(event) => {
                  setPermission(event.currentTarget.value as Permission);
                  requestId.current = null;
                }}>
                  <option value="view">Can view</option>
                  <option value="edit">Can edit</option>
                </select>
              </div>
              <label className="share-check">
                <input type="checkbox" checked={allowDownload} disabled={busy} onChange={(event) => {
                  setAllowDownload(event.currentTarget.checked);
                  requestId.current = null;
                }} />
                Allow download
              </label>
            </div>
            <div className="dialog-actions">
              <button className="button button-primary" type="submit" disabled={busy || !recipientId}>Create link</button>
            </div>
          </form>
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          {notice && <p className="notice notice-success" role="status">{notice}</p>}
          {shares.length > 0 && (
            <section className="share-history" aria-labelledby="share-history-title">
              <h3 id="share-history-title">Shared links</h3>
              <ul>
                {shares.map((share) => {
                  const expiry = new Date(share.expiresAt);
                  const expired = expiry.getTime() <= Date.now();
                  const active = !share.revokedAt && !expired;
                  return (
                    <li key={share.id}>
                      <strong>{share.recipientName}</strong>
                      <p className="file-meta">
                        {share.permission === "edit" ? "Can edit" : "Can view"}
                        {share.allowDownload && " · Download allowed"}
                        {share.revokedAt ? " · Revoked" : expired ? " · Expired" : " · Expires "}
                        {active && <time dateTime={share.expiresAt}>{expiryFormat.format(expiry)}</time>}
                      </p>
                      {active && (
                        <div className="share-link">
                          <input
                            id={`link-${share.id}`}
                            aria-label={`Share link for ${share.recipientName}`}
                            value={absoluteLink(share)}
                            readOnly
                            onFocus={(event) => event.currentTarget.select()}
                          />
                          <div className="item-actions">
                            <button className="button button-secondary" type="button" onClick={() => void copyLink(share)}>Copy link</button>
                            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void revokeShare(share)}>Revoke</button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </dialog>
  );
}
