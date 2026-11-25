"use client";

import { useState } from "react";
import { localDateTime } from "../local-date-time";
import styles from "./admin.module.css";

const checks = [
  { path: "/api/health", title: "API response", detail: "Checks whether the application API answers.",
    expected: "ok", success: "Responding" },
  { path: "/api/ready", title: "Service readiness", detail: "Checks whether the API reaches PostgreSQL and can serve requests.",
    expected: "ready", success: "Ready" },
] as const;

type Check = (typeof checks)[number];
type Result = { ok: boolean; label: string };

async function checkService(check: Check, signal: AbortSignal): Promise<Result> {
  try {
    const response = await fetch(check.path, { cache: "no-store", signal });
    if (!response.ok) return { ok: false, label: `Unavailable (${response.status})` };
    const body = await response.json().catch(() => undefined);
    return body?.status === check.expected
      ? { ok: true, label: check.success }
      : { ok: false, label: "Unexpected response" };
  } catch {
    return { ok: false, label: "No response" };
  }
}

export function ServiceChecks() {
  const [checking, setChecking] = useState(false);
  const [snapshot, setSnapshot] = useState<{ results: Result[]; at: Date }>();

  async function refresh() {
    setChecking(true);
    const signal = AbortSignal.timeout(8_000);
    const results = await Promise.all(checks.map((check) => checkService(check, signal)));
    setSnapshot({ results, at: new Date() });
    setChecking(false);
  }

  return (
    <section className={`panel ${styles.section}`} id="service-checks" aria-labelledby="service-checks-title" tabIndex={-1}>
      <header className={styles.sectionHeader}>
        <div>
          <h2 id="service-checks-title">Service checks</h2>
          <p className={styles.description}>Run a point-in-time check from this browser. Review backups, email and uptime separately.</p>
        </div>
        <button className="button button-secondary" type="button" onClick={refresh} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </header>
      <div aria-live="polite" aria-busy={checking}>
        <ul className={styles.checkList}>
          {checks.map(({ title, detail }, index) => {
            const result = snapshot?.results[index];
            const tone = checking || !result ? styles.neutral : result.ok ? styles.positive : styles.problem;
            return (
              <li key={title} className={styles.checkRow}>
                <div>
                  <h3>{title}</h3>
                  <p className={styles.description}>{detail}</p>
                </div>
                <span className={`status-pill ${tone}`}>{checking ? "Checking" : result?.label ?? "Not checked"}</span>
              </li>
            );
          })}
        </ul>
        {snapshot && !checking && (
          <p className={styles.checkTime}>
            Last checked <time dateTime={snapshot.at.toISOString()}>{localDateTime.format(snapshot.at)}</time>
          </p>
        )}
      </div>
    </section>
  );
}
