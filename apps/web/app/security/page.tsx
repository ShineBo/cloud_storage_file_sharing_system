"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { AppShell, useSession } from "../app-shell";
import { localDateTime } from "../local-date-time";
import styles from "./security.module.css";

const PAGE_SIZE = 30;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const outcomes = {
  success: "Succeeded",
  denied: "Denied",
  failed: "Failed",
} as const;

const alertStates = {
  pending: "Queued",
  sending: "Sending",
  sent: "Accepted by relay",
  failed: "Delivery failed",
} as const;

const actions: Record<string, string> = {
  upload: "File upload",
  "file.update": "File change",
  "folder.create": "Folder creation",
  "folder.update": "Folder change",
  "share.create": "Link creation",
  "share.revoke": "Link revocation",
  "share.open": "Shared item access",
  view: "File preview",
  download: "File download",
  "edit.prepare": "Edit request",
  edit: "Revision publication",
  "policy.update": "Policy update",
  "account.update": "Account access change",
  "item.delete": "Move to Trash",
  "item.restore": "Item restore",
  "recovery.backup": "Backup creation",
  "recovery.restore": "Backup restore",
  "recovery.resume": "Service reopening",
};

const alertRules: Record<string, string> = {
  "denied-shared-access": "Denied shared access",
  "inactive-share-access": "Inactive link access",
};

type AuditEvent = {
  id: string;
  actorId: string | null;
  actorName: string | null;
  itemType: string;
  itemId: string | null;
  action: string;
  outcome: keyof typeof outcomes;
  status: number;
  revision: number | null;
  occurredAt: string;
  alertRule: string | null;
  alertStatus: keyof typeof alertStates | null;
  detail: Record<string, unknown> | null;
};

type Filters = {
  searchId: string;
  outcome: keyof typeof outcomes | "";
  alert: keyof typeof alertStates | "present" | "";
};
type Query = {
  filters: Filters;
  cursors: (string | null)[];
};
type LoadState =
  | { status: "loading" | "error" | "signed-out" | "forbidden" }
  | { status: "ready"; events: AuditEvent[]; nextCursor: string | null };

const emptyFilters: Filters = { searchId: "", outcome: "", alert: "" };

function label(value: string, known: Record<string, string>) {
  return Object.hasOwn(known, value) ? known[value] : value;
}

function actorLabel(event: AuditEvent) {
  return event.actorName || (event.actorId ? "Unnamed account" : "No identified account");
}

function hasFilters(filters: Filters) {
  return Boolean(filters.searchId || filters.outcome || filters.alert);
}

export default function SecurityPage() {
  const session = useSession();
  const user = session.status === "signed-in" ? session.user : null;
  const canReview = user && user.capabilities?.reviewActivity !== false;
  const placeholder = user ? "forbidden" : session.status === "signed-in" ? "signed-out" : session.status;
  return (
    <AppShell section="security" user={user}>
      <main className={canReview ? "workspace" : styles.publicNotice}>
        {canReview
          ? <AuditConsole key={user.id} />
          : <SecurityNotice status={placeholder} retry={session.retry} />}
      </main>
    </AppShell>
  );
}

function SecurityNotice({ status, retry }: {
  status: "loading" | "error" | "signed-out" | "forbidden";
  retry?: () => void;
}) {
  return (
    <>
      <div className="page-heading">
        <h1>Security activity</h1>
      </div>
      <div className={`panel ${styles.notice}`}>
        {status === "loading" && <p role="status">Checking access…</p>}
        {status === "forbidden" && <p role="status">Security activity is available to assigned reviewers.</p>}
        {status === "signed-out" && (
          <>
            <p>Sign in with a security reviewer account to view activity.</p>
            <a className="button button-primary" href="/api/auth/login">Sign in</a>
          </>
        )}
        {status === "error" && (
          <>
            <p role="alert">Your session could not be checked. Try again in a moment.</p>
            <button className="button button-secondary" type="button" onClick={retry}>Try again</button>
          </>
        )}
      </div>
    </>
  );
}

function AuditConsole() {
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [query, setQuery] = useState<Query>({ filters: emptyFilters, cursors: [null] });
  const [validation, setValidation] = useState<string>();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState<AuditEvent>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const moveFocusAfterPaging = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    const cursor = query.cursors.at(-1);
    if (cursor) params.set("after", cursor);
    if (query.filters.searchId) params.set("searchId", query.filters.searchId);
    if (query.filters.outcome) params.set("outcome", query.filters.outcome);
    if (query.filters.alert) params.set("alert", query.filters.alert);

    async function retrieve() {
      try {
        const response = await fetch(`/api/audit?${params}`, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          setLoad({ status: response.status === 401 ? "signed-out" : "forbidden" });
          return;
        }
        if (!response.ok) throw new Error("Audit is unavailable.");
        const { events } = await response.json() as { events: AuditEvent[] };
        if (!controller.signal.aborted) {
          setLoad({ status: "ready", events, nextCursor: response.headers.get("X-Audit-Next-Cursor") });
        }
      } catch {
        if (!controller.signal.aborted) setLoad({ status: "error" });
      }
    }

    void retrieve();
    return () => controller.abort();
  }, [query]);

  useEffect(() => {
    if (moveFocusAfterPaging.current && load.status !== "loading") {
      moveFocusAfterPaging.current = false;
      if (document.activeElement === document.body) headingRef.current?.focus();
    }
  }, [load.status]);

  function request(filters: Filters, cursors: (string | null)[], moveFocus = false) {
    moveFocusAfterPaging.current = moveFocus;
    setSelected(undefined);
    setLoad({ status: "loading" });
    setQuery({ filters, cursors });
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const searchId = draft.searchId.trim();
    if (searchId && !UUID.test(searchId)) {
      setValidation("Enter a complete event, item, or actor ID.");
      searchRef.current?.focus();
      return;
    }
    setValidation(undefined);
    request({ ...draft, searchId }, [null]);
  }

  function clear() {
    searchRef.current?.focus();
    setDraft(emptyFilters);
    setValidation(undefined);
    request(emptyFilters, [null]);
  }

  if (load.status === "signed-out" || load.status === "forbidden") {
    return <SecurityNotice status={load.status} />;
  }

  const filtered = hasFilters(query.filters);
  return (
    <div className={styles.console}>
      <div className={`page-heading ${styles.heading}`}>
        <div>
          <h1>Security activity</h1>
          <p className={styles.subtitle}>Review access decisions, workspace changes, and security alerts.</p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => request(query.filters, [null])}
        >
          Refresh activity
        </button>
      </div>

      <section className={`panel ${styles.filters}`} aria-labelledby="audit-filters">
        <h2 id="audit-filters">Find activity</h2>
        <form className={styles.filterForm} onSubmit={apply} noValidate>
          <div className={styles.field}>
            <label htmlFor="audit-id">Search by ID</label>
            <input
              id="audit-id"
              ref={searchRef}
              type="search"
              placeholder="Event, item, or actor ID"
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={Boolean(validation)}
              aria-describedby={validation ? "audit-search-error" : undefined}
              value={draft.searchId}
              onChange={(event) => {
                setDraft({ ...draft, searchId: event.currentTarget.value });
                setValidation(undefined);
              }}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="audit-outcome">Outcome</label>
            <select id="audit-outcome" value={draft.outcome}
              onChange={(event) => setDraft({ ...draft, outcome: event.currentTarget.value as Filters["outcome"] })}>
              <option value="">All outcomes</option>
              {Object.entries(outcomes).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="audit-alert">Alert delivery</label>
            <select id="audit-alert" value={draft.alert}
              onChange={(event) => setDraft({ ...draft, alert: event.currentTarget.value as Filters["alert"] })}>
              <option value="">All events</option>
              <option value="present">Any alert</option>
              {Object.entries(alertStates).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </div>
          <div className={styles.actions}>
            <button type="submit" className="button button-primary">Apply filters</button>
            {hasFilters(draft) || filtered ? (
              <button type="button" className="button button-secondary" onClick={clear}>Clear</button>
            ) : null}
          </div>
          {validation && <p id="audit-search-error" className={styles.validation} role="alert">{validation}</p>}
        </form>
      </section>

      <section className={`panel ${styles.results}`} aria-labelledby="audit-results">
        <div className={styles.resultsHeading}>
          <h2 ref={headingRef} id="audit-results" tabIndex={-1}>{filtered ? "Matching activity" : "Recent activity"}</h2>
          {load.status === "ready" && load.events.length > 0 && (
            <p className={styles.count} role="status">
              {load.events.length} {load.events.length === 1 ? "event" : "events"} on this page
            </p>
          )}
        </div>
        {load.status === "loading" && <p className={styles.resultMessage} role="status">Loading activity…</p>}
        {load.status === "error" && (
          <div className={styles.resultMessage}>
            <p role="alert">Activity could not be loaded. Try again in a moment.</p>
            <button className="button button-secondary" type="button"
              onClick={() => request(query.filters, query.cursors)}>Try again</button>
          </div>
        )}
        {load.status === "ready" && (
          <>
            {load.events.length === 0 ? (
              <p className={styles.resultMessage} role="status">
                {query.cursors.length > 1 ? "No more matching activity." : filtered
                  ? "No activity matches these filters." : "No activity has been recorded yet."}
              </p>
            ) : (
              <>
                <div className={styles.columnHeading} aria-hidden="true">
                  <span>Event</span><span>Actor</span><span>Outcome</span><span>Time</span><span>Alert delivery</span>
                </div>
                <ul className={styles.eventList} role="list">
                  {load.events.map((event) => <EventRow key={event.id} event={event} open={() => setSelected(event)} />)}
                </ul>
              </>
            )}
            {(query.cursors.length > 1 || load.nextCursor) && (
              <nav className={styles.pagination} aria-label="Activity pages">
                <button className="button button-secondary" type="button" disabled={query.cursors.length === 1}
                  onClick={() => request(query.filters, query.cursors.slice(0, -1), true)}>Newer events</button>
                <button className="button button-secondary" type="button" disabled={!load.nextCursor}
                  onClick={() => request(query.filters, [...query.cursors, load.nextCursor], true)}>Older events</button>
              </nav>
            )}
          </>
        )}
      </section>
      {selected && <EventDialog event={selected} dismiss={() => setSelected(undefined)} />}
    </div>
  );
}

function Outcome({ outcome }: { outcome: AuditEvent["outcome"] }) {
  return <span className={`status-pill ${styles.outcome} ${styles[outcome]}`}>{outcomes[outcome]}</span>;
}

function EventRow({ event, open }: { event: AuditEvent; open: () => void }) {
  return (
    <li>
      <button className={styles.eventRow} type="button" onClick={open} aria-haspopup="dialog">
        <span className={styles.eventTitle}>
          <strong>{label(event.action, actions)}</strong>
          <span className={styles.itemType}>{event.itemType}</span>
        </span>
        <span className={styles.actor}>{actorLabel(event)}</span>
        <Outcome outcome={event.outcome} />
        <time className={styles.inlineTime} dateTime={event.occurredAt}>
          {localDateTime.format(new Date(event.occurredAt))}
        </time>
        <span className={event.alertStatus === "failed" ? styles.failedAlert : styles.alertState}>
          {event.alertStatus ? alertStates[event.alertStatus] : "No alert"}
        </span>
        <span className={styles.chevron} aria-hidden="true" />
      </button>
    </li>
  );
}

function EventDialog({ event, dismiss }: { event: AuditEvent; dismiss: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  function close() {
    dialogRef.current?.close();
    dismiss();
  }

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="audit-event-title"
      onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className={styles.dialogHeading}>
        <div>
          <p className="eyebrow">Activity record</p>
          <h2 id="audit-event-title">{label(event.action, actions)}</h2>
        </div>
        <button className="button button-secondary" type="button" onClick={close}>Close</button>
      </div>
      <dl className={styles.metadata}>
        <div><dt>Outcome</dt><dd><Outcome outcome={event.outcome} /> <span className={styles.http}>HTTP {event.status}</span></dd></div>
        <div><dt>Actor</dt><dd>{actorLabel(event)}</dd></div>
        <div><dt>Event ID</dt><dd><code>{event.id}</code></dd></div>
        {event.actorId && <div><dt>Actor ID</dt><dd><code>{event.actorId}</code></dd></div>}
        <div><dt>Item type</dt><dd className={styles.itemType}>{event.itemType}</dd></div>
        {event.itemId && <div><dt>Item ID</dt><dd><code>{event.itemId}</code></dd></div>}
        {event.revision !== null && <div><dt>Revision</dt><dd>{event.revision}</dd></div>}
        <div>
          <dt>Recorded time</dt>
          <dd>
            <time dateTime={event.occurredAt}>{localDateTime.format(new Date(event.occurredAt))}</time>
            <code className={styles.utc}>{event.occurredAt}</code>
          </dd>
        </div>
        <div>
          <dt>Alert delivery</dt>
          <dd className={event.alertStatus === "failed" ? styles.failedAlert : undefined}>
            {event.alertStatus ? alertStates[event.alertStatus] : "No alert"}
          </dd>
        </div>
        {event.alertRule && <div><dt>Alert rule</dt><dd>{label(event.alertRule, alertRules)}</dd></div>}
      </dl>
      {event.detail && (
        <details className={styles.details}>
          <summary>Recorded data</summary>
          <pre tabIndex={0} aria-label="Recorded event data">{JSON.stringify(event.detail, null, 2)}</pre>
        </details>
      )}
    </dialog>
  );
}
