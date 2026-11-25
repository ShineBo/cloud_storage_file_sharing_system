"use client";

import { Brand } from "./app-shell";

export function SessionEntry({
  status, message, retry,
}: {
  status: "loading" | "signed-out" | "error";
  message?: string;
  retry: () => void;
}) {
  return <>
    <header className="site-header entry-header"><div className="header-content"><Brand /></div></header>
    <main className="sign-in">
      <section className="sign-in-card" aria-labelledby="entry-title">
        <div className="sign-in-copy">
          <h1 id="entry-title">Your files.<br />Your workspace.</h1>
          <p className="entry-description">Sign in with your organization account to open and share work files.</p>
          {status === "loading" && <p className="entry-status" role="status">Checking your session…</p>}
          {status === "error" && <>
            <p className="notice notice-error" role="alert">We couldn’t check your session. Check your connection and try again.</p>
            <button className="button button-secondary" onClick={retry}>Try again</button>
          </>}
          {status === "signed-out" && <>
            {message && <p className="notice notice-error" role="alert">{message}</p>}
            <a className="button button-primary" href="/api/auth/login">Sign in</a>
          </>}
        </div>
        <div className="sign-in-art" aria-hidden="true">
          <div className="art-orbit" />
          <div className="art-document art-document-back" />
          <div className="art-document art-document-front"><i /><i /><i /></div>
          <div className="art-mark"><span className="folder-icon" /></div>
        </div>
      </section>
    </main>
  </>;
}
