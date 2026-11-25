"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { homeFor, useSession } from "./app-shell";
import { SessionEntry } from "./session-entry";

function callbackMessage() {
  if (typeof window === "undefined") return;
  const status = new URLSearchParams(window.location.search).get("auth");
  if (status === "denied") return "This organization account lacks access. Sign in with an approved account or contact your administrator.";
  if (status === "unavailable") return "Sign-in is temporarily unavailable. Try again in a moment.";
}

export default function HomePage() {
  const { status, user, retry } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (user) router.replace(homeFor(user));
  }, [router, user]);

  return <SessionEntry status={status === "signed-in" ? "loading" : status}
    message={status === "signed-out" ? callbackMessage() : undefined} retry={retry} />;
}
