"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { fileFormats, formatSize, responseMessage } from "../file-transfer";
import { Header } from "../workspace";

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
  | { status: "ready"; policy: Policy; accounts: Account[]; actorId: string };
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
  const [state, setState] = useState<State>({ status: "loading" });
  const [draft, setDraft] = useState<Draft>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [policyNotice, setPolicyNotice] = useState<Notice>();
  const [accountNotice, setAccountNotice] = useState<string>();
  const [selected, setSelected] = useState<Account>();

  useEffect(() => {
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
        const [{ policy }, accountsResponse, sessionResponse] = await Promise.all([
          response.json() as Promise<{ policy: Policy }>,
          fetch("/api/admin/accounts", options),
          fetch("/api/auth/me", options),
        ]);
        if (controller.signal.aborted) return;
        const blockedAfterLoad = blockedStatus(accountsResponse.status) ?? blockedStatus(sessionResponse.status);
        if (blockedAfterLoad) {
          setState({ status: blockedAfterLoad });
          return;
        }
        if (!accountsResponse.ok || !sessionResponse.ok) throw new Error("Accounts unavailable.");
        const [{ accounts }, { user }] = await Promise.all([
          accountsResponse.json() as Promise<{ accounts: Account[] }>,
          sessionResponse.json() as Promise<{ user: { id: string } }>,
        ]);
        if (controller.signal.aborted) return;
        setDraft(policyDraft(policy));
        setState({ status: "ready", policy, accounts, actorId: user.id });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    }
    void loadAdministration();
    return () => controller.abort();
  }, [loadAttempt]);

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

  return (
    <>
      <Header />
      <main className="workspace management-page">
        <a className="shared-back" href="/">My files</a>
        <div className="workspace-heading"><h1>Administration</h1></div>
        {state.status === "loading" && <p className="entry-status" role="status">Loading administration…</p>}
        {state.status === "signed-out" && (
          <p className="notice notice-error" role="alert">Sign in with your administrator account to open this page.</p>
        )}
        {state.status === "forbidden" && (
          <p className="notice notice-error" role="alert">Only authorized IT administrators can manage the workspace policy and accounts.</p>
        )}
        {state.status === "error" && (
          <div className="panel management-panel">
            <p className="notice notice-error" role="alert">Administration is temporarily unavailable.</p>
            <button className="button button-secondary" type="button" onClick={reload}>Try again</button>
          </div>
        )}
        {state.status === "ready" && draft && (
          <div className="management-grid">
            <section className="panel management-panel" aria-labelledby="policy-title">
              <h2 id="policy-title">Storage and sharing policy</h2>
              <form className="policy-form" onSubmit={savePolicy}>
                <fieldset className="policy-types" disabled={saving}>
                  <legend>Allowed file types</legend>
                  <p className="panel-description">Applies to new uploads and revisions. Previously stored files remain available.</p>
                  <div className="policy-type-list">
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
                <div className="policy-control">
                  <label htmlFor="quota">Storage quota in bytes</label>
                  <input id="quota" type="number" min={1} max={state.policy.capacityBytes} step={1} required
                    value={draft.quota} onChange={(event) => setDraft({ ...draft, quota: event.currentTarget.value })}
                    disabled={saving} aria-describedby="quota-help" />
                  <p id="quota-help" className="panel-description">
                    Deployment limit {formatSize(state.policy.capacityBytes)} per employee. Quota includes retained versions and items in Trash.
                  </p>
                </div>
                <div className="policy-control">
                  <label htmlFor="link-expiry">Share link lifetime in days</label>
                  <input id="link-expiry" type="number" min={1} max={365} step={1} required
                    value={draft.linkExpiry} onChange={(event) => setDraft({ ...draft, linkExpiry: event.currentTarget.value })}
                    disabled={saving} aria-describedby="expiry-help" />
                  <p id="expiry-help" className="panel-description">Applies to links created after you save.</p>
                </div>
                <div className="policy-control">
                  <label htmlFor="retention">Trash recovery window in days</label>
                  <input id="retention" type="number" min={1} max={365} step={1} required
                    value={draft.retention} onChange={(event) => setDraft({ ...draft, retention: event.currentTarget.value })}
                    disabled={saving} aria-describedby="retention-help" />
                  <p id="retention-help" className="panel-description">Applies to items moved to Trash after you save.</p>
                </div>
                {policyNotice && <p className={`notice notice-${policyNotice.kind}`}
                  role={policyNotice.kind === "error" ? "alert" : "status"}>{policyNotice.message}</p>}
                <button className="button button-primary" type="submit" disabled={saving}>
                  {saving ? "Saving policy…" : "Save policy"}
                </button>
              </form>
            </section>
            <section className="panel management-panel" aria-labelledby="accounts-title">
              <h2 id="accounts-title">Application access</h2>
              {accountNotice && <p className="notice notice-success" role="status">{accountNotice}</p>}
              <ul className="management-list">
                {state.accounts.map((account) => {
                  const name = account.displayName || account.username;
                  const self = account.id === state.actorId;
                  const label = account.active ? "Suspend" : "Reactivate";
                  return (
                    <li key={account.id}>
                      <div className="file-info">
                        <span className="file-name">{name}</span>
                        <span className="file-meta">{account.username}{" · "}{!account.directoryEligible ? "Directory access required"
                          : account.active ? "Active" : "Suspended"}{self && " · Your account"}</span>
                      </div>
                      {!self && account.directoryEligible && <button className="button button-secondary" type="button"
                        aria-label={`${label} ${name}`} onClick={() => setSelected(account)}>{label}</button>}
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        )}
      </main>
      {selected && state.status === "ready" && (
        <AccountDialog account={selected} onClose={() => setSelected(undefined)} onConfirm={() => updateAccount(selected)} />
      )}
    </>
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
    dialog?.showModal();
    return () => dialog?.close();
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
    <dialog className="item-dialog" ref={ref} aria-labelledby="account-action-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
      <form onSubmit={submit}>
        <h2 id="account-action-title">{title}</h2>
        <p className="dialog-item-name">{account.displayName || account.username}</p>
        <p className="panel-description">{account.active
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
