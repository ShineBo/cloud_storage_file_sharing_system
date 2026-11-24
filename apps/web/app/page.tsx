"use client";

import { useCallback, useEffect, useState } from "react";
import { Header, Workspace, type User } from "./workspace";

type Session =
  | { status: "loading" | "error" }
  | { status: "signed-out"; message?: string }
  | { status: "signed-in"; user: User };

function callbackMessage() {
  const status = new URLSearchParams(window.location.search).get("auth");
  if (status === "denied") {
    return "This organization account does not have access. Sign in with an approved account or contact your administrator.";
  }
  if (status === "unavailable") {
    return "Sign-in is temporarily unavailable. Try again in a moment.";
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
    return <Workspace key={session.user.id} user={session.user} onSessionExpired={expireSession} />;
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
