"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { AppShell, useSession } from "../app-shell";
import { fileFormats, formatSize, responseMessage } from "../file-transfer";
import { ServiceChecks } from "./service-checks";
import styles from "./admin.module.css";

type Policy = {
  allowedMimeTypes: string[];
  quotaBytes: number;
  capacityBytes: number;
  linkExpiryDays: number;
  retentionDays: number;
  version: number;
};
type Account = { id: string; username: string; displayName: string; active: boolean; directoryEligible: boolean };
type State =
  | { status: "loading" | "error" | "signed-out" | "forbidden" }
  | { status: "ready"; policy: Policy; accounts: Account[] };
type Notice = { kind: "success" | "error"; message: string };
type Draft = { allowedMimeTypes: string[]; quota: string; linkExpiry: string; retention: string };

function policyDraft(policy: Policy): Draft {
  return {
    allowedMimeTypes: policy.allowedMimeTypes,
    quota: String(policy.quotaBytes),
    linkExpiry: String(policy.linkExpiryDays),
    retention: String(policy.retentionDays),
  };
}

async function errorMessage(response: Response, fallback: string) {
  return responseMessage(await response.json().catch(() => undefined), fallback);
}

function blockedStatus(status: number) {
  if (status === 401) return "signed-out";
  if (status === 403) return "forbidden";
}

export default function AdminPage() {
  const { status: sessionStatus, user, retry: retrySession } = useSession();
  const actorId = user?.capabilities?.administration === false ? undefined : user?.id;
  const [state, setState] = useState<State>({ status: "loading" });
  const [draft, setDraft] = useState<Draft>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [policyNotice, setPolicyNotice] = useState<Notice>();
  const [accountNotice, setAccountNotice] = useState<string>();
  const [selected, setSelected] = useState<Account>();

  useEffect(() => {
    if (!actorId) return;
    const controller = new AbortController();
    const options = { cache: "no-store", signal: controller.signal } as const;
    async function loadAdministration() {
      try {
        const response = await fetch("/api/admin/policy", options);
        const blocked = blockedStatus(response.status);
        if (blocked) {
          if (!controller.signal.aborted) setState({ status: blocked });
          return;
        }
        if (!response.ok) throw new Error("Policy unavailable.");
        const [{ policy }, accountsResponse] = await Promise.all([
          response.json() as Promise<{ policy: Policy }>,
          fetch("/api/admin/accounts", options),
        ]);
        if (controller.signal.aborted) return;
        const blockedAfterLoad = blockedStatus(accountsResponse.status);
        if (blockedAfterLoad) {
          setState({ status: blockedAfterLoad });
          return;
        }
        if (!accountsResponse.ok) throw new Error("Accounts unavailable.");
        const { accounts } = await accountsResponse.json() as { accounts: Account[] };
        if (controller.signal.aborted) return;
        setDraft(policyDraft(policy));
        setState({ status: "ready", policy, accounts });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    }
    void loadAdministration();
    return () => controller.abort();
  }, [actorId, loadAttempt]);

  function reload() {
    setState({ status: "loading" });
    setLoadAttempt((value) => value + 1);
  }

  function usePolicy(policy: Policy) {
    setDraft(policyDraft(policy));
    setState((previous) => previous.status === "ready" ? { ...previous, policy } : previous);
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.status !== "ready" || !draft || saving) return;
    if (!draft.allowedMimeTypes.length) {
      setPolicyNotice({ kind: "error", message: "Allow at least one file type." });
      return;
    }
    const changes = {
      version: state.policy.version,
      allowedMimeTypes: draft.allowedMimeTypes,
      quotaBytes: Number(draft.quota),
      linkExpiryDays: Number(draft.linkExpiry),
      retentionDays: Number(draft.retention),
    };
    setSaving(true);
    setPolicyNotice(undefined);
    try {
      const response = await fetch("/api/admin/policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const blocked = blockedStatus(response.status);
      if (blocked) {
        setState({ status: blocked });
        return;
      }
      if (response.status === 409) {
        setPolicyNotice({ kind: "error", message: "The policy changed in another session. Review the latest settings before saving again." });
        reload();
        return;
      }
      if (!response.ok) {
        setPolicyNotice({ kind: "error", message: await errorMessage(response, "Policy changes could not be saved.") });
        return;
      }
      const { policy } = await response.json() as { policy: Policy };
      usePolicy(policy);
      setPolicyNotice({ kind: "success", message: "Policy saved." });
    } catch {
      setPolicyNotice({ kind: "error", message: "The save could not be confirmed. Refresh this page to check the current policy." });
    } finally {
      setSaving(false);
    }
  }

  async function updateAccount(account: Account) {
    setAccountNotice(undefined);
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !account.active }),
      });
      if (response.status === 401) {
        setState({ status: "signed-out" });
        setSelected(undefined);
        return;
      }
      if (!response.ok) return errorMessage(response, "Account access could not be changed. Refresh and try again.");
      const { account: saved } = await response.json() as { account: Account };
      setState((previous) => previous.status === "ready" ? {
        ...previous, accounts: previous.accounts.map((entry) => entry.id === saved.id ? saved : entry),
      } : previous);
      setAccountNotice(`${saved.displayName || saved.username} ${saved.active ? "reactivated" : "suspended"}.`);
      setSelected(undefined);
    } catch {
      return "The account change could not be confirmed. Refresh this page to check its status.";
    }
  }

  const status = sessionStatus === "signed-in" ? actorId ? state.status : "forbidden" : sessionStatus;
  const settings = status === "ready" && state.status === "ready" ? state : undefined;
  const changed = !!settings && !!draft && (
    draft.allowedMimeTypes.length !== settings.policy.allowedMimeTypes.length
    || draft.allowedMimeTypes.some((type) => !settings.policy.allowedMimeTypes.includes(type))
    || Number(draft.quota) !== settings.policy.quotaBytes
    || Number(draft.linkExpiry) !== settings.policy.linkExpiryDays
    || Number(draft.retention) !== settings.policy.retentionDays
  );
  const canCheckServices = status === "ready" || (
    !!user?.capabilities?.administration && status !== "forbidden" && status !== "signed-out"
  );

  return (
    <AppShell user={status === "signed-out" ? null : user} section="admin" navigationLocked={saving || !!selected}>
      <main className={styles.page}>
        <header className="page-heading">
          <p className="eyebrow">IT administration</p>
          <h1>Operations console</h1>
          <p>Manage storage and sharing rules, control employee access, and check the service.</p>
        </header>
        {status === "loading" && <p className="entry-status" role="status">Loading administration…</p>}
        {status === "signed-out" && (
          <div className={`panel ${styles.feedback}`}>
            <p className="notice notice-error" role="alert">Sign in with your administrator account to open this page.</p>
            <a className="button button-primary" href="/">Go to sign in</a>
          </div>
        )}
        {status === "forbidden" && (
          <p className="notice notice-error" role="alert">Only authorized IT administrators can manage workspace policy and accounts.</p>
        )}
        {status === "error" && (
          <div className={`panel ${styles.feedback}`}>
            <p className="notice notice-error" role="alert">Administration is temporarily unavailable.</p>
            <button className="button button-secondary" type="button" onClick={sessionStatus === "error" ? retrySession : reload}>Try again</button>
          </div>
        )}
        {settings && draft && (
          <>
            <Overview policy={settings.policy} accounts={settings.accounts} />
            <nav className={styles.sectionNav} aria-label="Operations sections">
              <a href="#service-policy">Service policy</a>
              <a href="#application-access">Application access</a>
              <a href="#service-checks">Service checks</a>
            </nav>
            <section className={`panel ${styles.section}`} id="service-policy" aria-labelledby="policy-title" tabIndex={-1}>
              <header className={styles.sectionHeader}>
                <div>
                  <h2 id="policy-title">Storage and sharing policy</h2>
                  <p className={styles.description}>These settings apply across this workspace.</p>
                </div>
                <span className={`status-pill ${changed ? styles.attention : styles.neutral}`}>
                  {changed ? "Unsaved changes" : `Policy ${settings.policy.version}`}
                </span>
              </header>
              <form className={styles.policyForm} onSubmit={savePolicy}>
                <fieldset className={styles.fileTypes} disabled={saving}>
                  <legend>Allowed file types</legend>
                  <p className={styles.description}>Applies to new uploads and revisions. Previously stored files remain available.</p>
                  <div className={styles.fileTypeList}>
                    {fileFormats.map(({ mimeType, label }) => (
                      <label key={mimeType}>
                        <input type="checkbox" checked={draft.allowedMimeTypes.includes(mimeType)} onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setDraft((previous) => previous && ({
                            ...previous,
                            allowedMimeTypes: checked ? [...previous.allowedMimeTypes, mimeType]
                              : previous.allowedMimeTypes.filter((allowed) => allowed !== mimeType),
                          }));
                        }} />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className={styles.policyFields}>
                  <div className={styles.control}>
                    <label htmlFor="quota">Storage quota in bytes</label>
                    <input id="quota" type="number" min={1} max={settings.policy.capacityBytes} step={1} required
                      value={draft.quota} onChange={(event) => setDraft({ ...draft, quota: event.currentTarget.value })}
                      disabled={saving} aria-describedby="quota-help" />
                    <p id="quota-help" className={styles.description}>
                      Deployment limit {formatSize(settings.policy.capacityBytes)} per employee. Usage includes retained versions and Trash.
                      A lower quota can block new uploads.
                    </p>
                  </div>
                  <div className={styles.control}>
                    <label htmlFor="link-expiry">Share link lifetime in days</label>
                    <input id="link-expiry" type="number" min={1} max={365} step={1} required
                      value={draft.linkExpiry} onChange={(event) => setDraft({ ...draft, linkExpiry: event.currentTarget.value })}
                      disabled={saving} aria-describedby="expiry-help" />
                    <p id="expiry-help" className={styles.description}>Applies to links created after you save.</p>
                  </div>
                  <div className={styles.control}>
                    <label htmlFor="retention">Trash recovery window in days</label>
                    <input id="retention" type="number" min={1} max={365} step={1} required
                      value={draft.retention} onChange={(event) => setDraft({ ...draft, retention: event.currentTarget.value })}
                      disabled={saving} aria-describedby="retention-help" />
                    <p id="retention-help" className={styles.description}>Applies to items moved to Trash after you save.</p>
                  </div>
                </div>
                {policyNotice && <p className={`notice notice-${policyNotice.kind}`}
                  role={policyNotice.kind === "error" ? "alert" : "status"}>{policyNotice.message}</p>}
                <div className={styles.formActions}>
                  <button className="button button-primary" type="submit" disabled={saving || !changed}>
                    {saving ? "Saving policy…" : "Save policy"}
                  </button>
                  {changed && <button className="button button-secondary" type="button" disabled={saving} onClick={() => {
                    setDraft(policyDraft(settings.policy));
                    setPolicyNotice(undefined);
                  }}>Discard changes</button>}
                </div>
              </form>
            </section>
            <AccountsPanel accounts={settings.accounts} actorId={actorId} notice={accountNotice} select={setSelected} />
          </>
        )}
        {canCheckServices && <ServiceChecks />}
      </main>
      {selected && settings && (
        <AccountDialog account={selected} onClose={() => setSelected(undefined)} onConfirm={() => updateAccount(selected)} />
      )}
    </AppShell>
  );
}

const accountLabels = {
  active: "Active",
  suspended: "Suspended",
  directory: "Directory access required",
} as const;

type AccountStatus = keyof typeof accountLabels;

function accountStatus(account: Account): AccountStatus {
  if (!account.directoryEligible) return "directory";
  return account.active ? "active" : "suspended";
}

function Overview({ policy, accounts }: { policy: Policy; accounts: Account[] }) {
  const active = accounts.filter((account) => accountStatus(account) === "active").length;
  const suspended = accounts.filter((account) => accountStatus(account) === "suspended").length;

  return (
    <dl className={styles.overview} aria-label="Workspace operations summary">
      <div className={`panel ${styles.metric}`}>
        <dt>Active accounts</dt>
        <dd><strong>{active}</strong><span>Out of {accounts.length} in this directory</span></dd>
      </div>
      <div className={`panel ${styles.metric}`}>
        <dt>Suspended accounts</dt>
        <dd><strong>{suspended}</strong><span>Managed in the application</span></dd>
      </div>
      <div className={`panel ${styles.metric}`}>
        <dt>Storage quota</dt>
        <dd><strong>{formatSize(policy.quotaBytes)}</strong><span>Per employee</span></dd>
      </div>
    </dl>
  );
}

const pageSize = 12;

function AccountsPanel({ accounts, actorId, notice, select }: {
  accounts: Account[];
  actorId?: string;
  notice?: string;
  select: (account: Account) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AccountStatus | "all">("all");
  const [page, setPage] = useState(1);
  const query = search.trim().toLocaleLowerCase();
  const matches = accounts.filter((account) => (filter === "all" || accountStatus(account) === filter)
    && (account.displayName.toLocaleLowerCase().includes(query) || account.username.toLocaleLowerCase().includes(query)));
  const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * pageSize;
  const shown = matches.slice(start, start + pageSize);

  return (
    <section className={`panel ${styles.section}`} id="application-access" aria-labelledby="accounts-title" tabIndex={-1}>
      <header className={styles.sectionHeader}>
        <div>
          <h2 id="accounts-title">Application access</h2>
          <p className={styles.description}>Suspend or reactivate eligible employees in this app. Directory access is managed by your organization.</p>
        </div>
      </header>
      <div className={styles.accountControls}>
        <div className={styles.control}>
          <label htmlFor="account-search">Search accounts</label>
          <input id="account-search" type="search" placeholder="Name or username" value={search}
            onChange={(event) => { setSearch(event.currentTarget.value); setPage(1); }} />
        </div>
        <div className={styles.control}>
          <label htmlFor="account-status">Account status</label>
          <select id="account-status" value={filter}
            onChange={(event) => { setFilter(event.currentTarget.value as AccountStatus | "all"); setPage(1); }}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="directory">Directory access required</option>
          </select>
        </div>
      </div>
      {notice && <p className="notice notice-success" role="status">{notice}</p>}
      {shown.length > 0 ? (
        <>
          <p className={styles.resultCount} role="status">Showing {start + 1}–{start + shown.length} of {matches.length}</p>
          <ul className={styles.accountList}>
            {shown.map((account) => {
              const name = account.displayName || account.username;
              const self = account.id === actorId;
              const status = accountStatus(account);
              const tone = status === "active" ? styles.positive : status === "suspended" ? styles.attention : styles.neutral;
              const action = account.active ? "Suspend" : "Reactivate";
              return (
                <li key={account.id}>
                  <div className={styles.accountName}>
                    <strong>{name}</strong>
                    <span>{account.username}{self && " · Your account"}</span>
                  </div>
                  <span className={`status-pill ${tone}`}>{accountLabels[status]}</span>
                  {!self && account.directoryEligible && <button className="button button-secondary" type="button"
                    aria-label={`${action} ${name}`} onClick={() => select(account)}>{action}</button>}
                </li>
              );
            })}
          </ul>
          {totalPages > 1 && (
            <nav className={styles.pagination} aria-label="Account pages">
              <button className="button button-secondary" type="button" disabled={current === 1}
                onClick={() => setPage(current - 1)}>Previous</button>
              <span>Page {current} of {totalPages}</span>
              <button className="button button-secondary" type="button" disabled={current === totalPages}
                onClick={() => setPage(current + 1)}>Next</button>
            </nav>
          )}
        </>
      ) : (
        <p className={styles.empty} role="status">{accounts.length ? "No accounts match these filters." : "This directory has no accounts yet."}</p>
      )}
    </section>
  );
}

function AccountDialog({ account, onClose, onConfirm }: {
  account: Account;
  onClose: () => void;
  onConfirm: () => Promise<string | undefined>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const title = account.active ? "Suspend account" : "Reactivate account";

  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.getElementById("account-search")?.focus();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    const problem = await onConfirm();
    if (problem) {
      setError(problem);
      setSaving(false);
    }
  }

  return (
    <dialog className="item-dialog" ref={ref} aria-labelledby="account-action-title" aria-describedby="account-action-detail"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
      <form onSubmit={submit}>
        <h2 id="account-action-title">{title}</h2>
        <p className="dialog-item-name">{account.displayName || account.username}</p>
        <p id="account-action-detail" className="panel-description">{account.active
          ? "This ends their sessions and blocks new sign-ins. Access to links they own pauses while the account is suspended."
          : "The employee can sign in again with their organization account."}</p>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button button-secondary" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={saving}>{saving ? "Updating…" : title}</button>
        </div>
      </form>
    </dialog>
  );
}
