"use client";

import { useCallback, useState } from "react";
import { useSession } from "../app-shell";
import { SessionEntry } from "../session-entry";
import { Workspace } from "../workspace";

export default function FilesPage() {
  const { user, status, retry } = useSession();
  const [expired, setExpired] = useState(false);
  const expireSession = useCallback(() => setExpired(true), []);

  if (user && !expired) return <Workspace key={user.id} user={user} onSessionExpired={expireSession} />;

  return <SessionEntry status={expired || status === "signed-in" ? "signed-out" : status}
    message={expired ? "Your session ended. Sign in again to open your files." : undefined} retry={retry} />;
}
