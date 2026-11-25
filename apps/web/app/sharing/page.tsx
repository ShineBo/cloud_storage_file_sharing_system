"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell, useSession } from "../app-shell";
import { localDateTime } from "../local-date-time";
import { SessionEntry } from "../session-entry";
import { ShareDialog } from "../share-dialog";
import styles from "./sharing.module.css";

type Direction = "incoming" | "outgoing";
const linkStatuses = { active: "Active", expired: "Expired", revoked: "Revoked", unavailable: "Unavailable" };
type LinkStatus = keyof typeof linkStatuses;
type StatusFilter = "" | LinkStatus;
type SharedItem = { id: string; type: "file" | "folder"; name: string };
type SharedLink = {
  id: string;
  item: SharedItem;
  permission: "view" | "edit";
  allowDownload: boolean;
  expiresAt: string;
};
type IncomingLink = SharedLink & { link: string; ownerName: string; groupName: string | null };
type OutgoingLink = SharedLink & {
  recipientName: string;
  recipientType: "employee" | "group";
  status: LinkStatus;
  canManage: boolean;
};
type SharePage = { shares: (IncomingLink | OutgoingLink)[]; nextCursor: string | null };

export default function SharingPage() {
  const { user, status, retry } = useSession();
  const [expired, setExpired] = useState(false);
  const expireSession = useCallback(() => setExpired(true), []);

  if (!user || expired) return <SessionEntry status={expired || status === "signed-in" ? "signed-out" : status}
    message={expired ? "Your session ended. Sign in again to view shared items." : undefined} retry={retry} />;

  return (
    <AppShell user={user} section="sharing">
      <main className={styles.workspace}>
        <div className="page-heading">
          <h1>Shared</h1>
          <p>Open files and folders shared with you and manage the links you’ve sent.</p>
        </div>
        <Directories key={user.id} onSessionExpired={expireSession} />
      </main>
    </AppShell>
  );
}

function Directories({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [direction, setDirection] = useState<Direction>("incoming");
  const [filter, setFilter] = useState<StatusFilter>("");
  const appliedFilter = direction === "outgoing" ? filter : "";

  return (
    <>
      <div className={styles.controls}>
        <div className={styles.directions} role="group" aria-label="Share direction">
          <button type="button" aria-pressed={direction === "incoming"} onClick={() => setDirection("incoming")}>
            Shared with me
          </button>
          <button type="button" aria-pressed={direction === "outgoing"} onClick={() => setDirection("outgoing")}>
            Shared by me
          </button>
        </div>
        {direction === "outgoing" && <div className={styles.filter}>
          <label htmlFor="share-status">Status</label>
          <select id="share-status" value={filter} onChange={(event) => setFilter(event.currentTarget.value as StatusFilter)}>
            <option value="">All statuses</option>
            {Object.entries(linkStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>}
      </div>
      <ShareDirectory key={`${direction}:${appliedFilter}`} direction={direction} filter={appliedFilter}
        onSessionExpired={onSessionExpired} />
    </>
  );
}

function ShareDirectory({ direction, filter, onSessionExpired }: {
  direction: Direction;
  filter: StatusFilter;
  onSessionExpired: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  const [page, setPage] = useState<SharePage>({ shares: [], nextCursor: null });
  const [request, setRequest] = useState<{ cursor: string | null; attempt: number }>({ cursor: null, attempt: 0 });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<SharedItem>();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (filter) query.set("status", filter);
    if (request.cursor) query.set("cursor", request.cursor);
    const path = `/api/shares/${direction}${query.size ? `?${query}` : ""}`;

    async function loadPage() {
      try {
        const response = await fetch(path, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          onSessionExpired();
          return;
        }
        if (!response.ok) throw new Error("Shared links unavailable.");
        const result = await response.json() as SharePage;
        if (controller.signal.aborted) return;
        setPage((previous) => request.cursor
          ? { shares: [...previous.shares, ...result.shares], nextCursor: result.nextCursor }
          : result);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadPage();
    return () => controller.abort();
  }, [direction, filter, onSessionExpired, request]);

  useEffect(() => {
    if (loading || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body) headingRef.current?.focus();
  }, [loading]);

  function load(cursor: string | null, focusWhenComplete = false) {
    restoreFocus.current = focusWhenComplete;
    if (!cursor) setPage({ shares: [], nextCursor: null });
    setFailed(false);
    setLoading(true);
    setRequest((previous) => ({ cursor, attempt: previous.attempt + 1 }));
  }

  return (
    <section className={`panel ${styles.directory}`} aria-labelledby="shared-links-heading">
      <div className={styles.toolbar}>
        <h2 id="shared-links-heading" tabIndex={-1} ref={headingRef}>
          {direction === "incoming" ? "Received links" : "Sent links"}
        </h2>
        <button type="button" className="button button-secondary" aria-disabled={loading || undefined}
          onClick={() => { if (!loading) load(null); }}>Refresh</button>
      </div>
      {page.shares.length > 0 && (
        <ul className={styles.list}>
          {page.shares.map((share) => <ShareEntry key={share.id} share={share} onManage={setSelected} />)}
        </ul>
      )}
      {loading && <p className={styles.message} role="status">Loading links…</p>}
      {failed && <div className={styles.message}>
        <p role="alert">The links could not be loaded.</p>
        <button className="button button-secondary" type="button" onClick={() => load(request.cursor, true)}>Try again</button>
      </div>}
      {!loading && !failed && page.shares.length === 0 && <div className={styles.empty}>
        <p>{direction === "incoming" ? "No items have been shared with you." : filter ? "No links match this status." : "You haven’t shared any items yet."}</p>
        {direction === "outgoing" && !filter && <Link className="button button-secondary" href="/files">Go to My files</Link>}
      </div>}
      {page.nextCursor && !failed && <div className={styles.footer}>
        <button className="button button-secondary" type="button" aria-disabled={loading || undefined}
          onClick={() => { if (!loading) load(page.nextCursor, true); }}>Load more links</button>
      </div>}
      {selected && <ShareDialog item={{ type: selected.type, data: selected }} onSessionExpired={onSessionExpired}
        onClose={() => { setSelected(undefined); load(null, true); }} />}
    </section>
  );
}

function ShareEntry({ share, onManage }: {
  share: IncomingLink | OutgoingLink;
  onManage: (item: SharedItem) => void;
}) {
  const itemType = share.item.type === "folder" ? "Folder" : "File";
  const recipient = "recipientName" in share ? share : null;
  return (
    <li className={styles.row}>
      <div className={styles.item}>
        <span className={styles.itemIcon} aria-hidden="true">
          <span className={share.item.type === "folder" ? "folder-icon" : styles.fileIcon} />
        </span>
        <div className={styles.itemDetails}>
          <h3>{share.item.name}</h3>
          <div className={styles.meta}>
            <span>{itemType}</span>
            {"ownerName" in share && <span>From {share.ownerName}</span>}
            {"groupName" in share && share.groupName && <span>Via {share.groupName}</span>}
            {recipient && <span>To {recipient.recipientName}{recipient.recipientType === "group" && " (group)"}</span>}
          </div>
        </div>
      </div>
      <div className={styles.access}>
        <div className={styles.accessLabels}>
          <span className="status-pill">{share.permission === "edit" ? "Can edit" : "Can view"}</span>
          {recipient && <span className={`status-pill ${styles[recipient.status]}`}>{linkStatuses[recipient.status]}</span>}
        </div>
        <div className={styles.meta}>
          <span>{share.allowDownload ? "Download allowed" : "Download blocked"}</span>
          {recipient?.status !== "revoked" && <span>
            {recipient?.status === "expired" ? "Expired " : "Expires "}
            <time dateTime={share.expiresAt}>{localDateTime.format(new Date(share.expiresAt))}</time>
          </span>}
        </div>
      </div>
      <div className={styles.action}>
        {"link" in share && <Link className="button button-secondary" href={share.link} prefetch={false}
          aria-label={`Open ${share.item.name}`}>Open</Link>}
        {recipient?.canManage && <button className="button button-secondary" type="button"
          aria-label={`Manage links for ${share.item.name}`} onClick={() => onManage(share.item)}>Manage links</button>}
        {recipient && !recipient.canManage && <span className={styles.meta}>Item unavailable</span>}
      </div>
    </li>
  );
}
