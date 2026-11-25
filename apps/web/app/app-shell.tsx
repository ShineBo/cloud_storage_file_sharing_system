"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useState } from "react";

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  capabilities?: { administration: boolean; reviewActivity: boolean };
};

export function useSession() {
  const [session, setSession] = useState<{
    status: "loading" | "signed-out" | "error" | "signed-in";
    user: SessionUser | null;
  }>({ status: "loading", user: null });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setSession({ status: "loading", user: null });
    setAttempt((previous) => previous + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function readSession() {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          if (!controller.signal.aborted) setSession({ status: "signed-out", user: null });
          return;
        }
        if (!response.ok) throw new Error("Session unavailable.");
        const { user } = await response.json() as { user: SessionUser };
        if (!controller.signal.aborted) setSession({ status: "signed-in", user });
      } catch {
        if (!controller.signal.aborted) setSession({ status: "error", user: null });
      }
    }
    void readSession();
    return () => controller.abort();
  }, [attempt]);

  return { ...session, retry };
}

const pages = {
  files: { href: "/files", label: "My files", icon: "files" },
  sharing: { href: "/sharing", label: "Shared", icon: "sharing" },
  trash: { href: "/trash", label: "Trash", icon: "trash" },
  admin: { href: "/admin", label: "Administration", icon: "admin" },
  security: { href: "/security", label: "Security activity", icon: "security" },
} as const;

type Section = keyof typeof pages;

export function homeFor(user: SessionUser) {
  if (user.capabilities?.administration) return pages.admin.href;
  if (user.capabilities?.reviewActivity) return pages.security.href;
  return pages.files.href;
}

export function Brand({ href = "/" }: { href?: string }) {
  return <Link className="brand shell-brand" href={href}>
    <span className="brand-icon" aria-hidden="true"><span className="folder-icon" /></span>
    <span>Cloud Storage</span>
  </Link>;
}

export function AppShell({
  user, section, children, navigationLocked = false,
}: {
  user?: SessionUser | null;
  section: Section;
  children: ReactNode;
  navigationLocked?: boolean;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const locked = navigationLocked || signingOut;

  async function signOut() {
    if (locked) return;
    setSigningOut(true);
    setSignOutError(false);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok && response.status !== 401) throw new Error("Sign-out failed.");
      window.location.replace(response.headers.get("X-Sign-Out-Location") ?? "/");
    } catch {
      setSignOutError(true);
      setSigningOut(false);
    }
  }

  if (!user) return <>
    <header className="site-header"><div className="header-content"><Brand /></div></header>
    {children}
  </>;

  const name = user.displayName || user.username;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toUpperCase();
  const adminSections: Section[] = [];
  const personalSections: Section[] = ["files", "sharing", "trash"];
  if (user.capabilities?.administration) adminSections.push("admin");
  if (user.capabilities?.reviewActivity) adminSections.push("security");
  const roles = [
    user.capabilities?.administration ? "IT administrator" : "",
    user.capabilities?.reviewActivity ? "Security reviewer" : "",
  ].filter(Boolean).join(" · ") || "Employee";

  const navLink = (key: Section) => {
    const page = pages[key];
    return <Link key={key} className="shell-link" href={page.href}
      aria-current={key === section ? "page" : undefined} aria-disabled={locked || undefined}
      onClick={(event) => { if (locked) event.preventDefault(); }}>
      <span className={`nav-icon nav-icon-${page.icon}`} aria-hidden="true" />
      {page.label}
    </Link>;
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#app-content">Skip to content</a>
      <aside className="shell-sidebar">
        {locked ? <span className="brand shell-brand">
          <span className="brand-icon" aria-hidden="true"><span className="folder-icon" /></span>Cloud Storage
        </span> : <Brand href={homeFor(user)} />}
        <nav className="shell-nav" aria-label="Workspace pages">
          {adminSections.length > 0 && <div className="shell-nav-group">
            <span className="shell-nav-label">Operations</span>
            {adminSections.map(navLink)}
          </div>}
          <div className="shell-nav-group">
            <span className="shell-nav-label">Workspace</span>
            {personalSections.map(navLink)}
          </div>
        </nav>
      </aside>
      <div id="app-content" className="shell-content" tabIndex={-1}>
        <header className="shell-topbar">
          <span className="shell-location">{pages[section].label}</span>
          <div className="shell-account">
            <span className="shell-avatar" aria-hidden="true">{initials}</span>
            <div className="shell-identity">
              <strong>{name}</strong>
              <span>{roles}</span>
            </div>
            <button className="button button-secondary shell-signout" type="button" disabled={locked} onClick={signOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </header>
        {signOutError && <p className="notice notice-error shell-error" role="alert">
          Sign-out could not be confirmed. Try signing out again.
        </p>}
        {children}
      </div>
    </div>
  );
}
