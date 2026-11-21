import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";

type AuthCookie = "se_session" | "se_login_attempt";

export function newAuthToken() {
  return randomBytes(32).toString("base64url");
}

export function hashAuthToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cookieName(name: AuthCookie, secure: boolean) {
  return secure ? `__Host-${name}` : name;
}

export function readAuthCookie(
  request: FastifyRequest,
  name: AuthCookie,
  secure: boolean,
) {
  const prefix = `${cookieName(name, secure)}=`;
  const values = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));

  if (values?.length !== 1) {
    return undefined;
  }

  const token = values[0].slice(prefix.length);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function authCookie(
  name: AuthCookie,
  value: string,
  maxAge: number,
  secure: boolean,
) {
  const security = secure ? "; Secure" : "";
  const path = secure ? "/" : name === "se_session" ? "/api" : "/api/auth";
  return `${cookieName(name, secure)}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${security}`;
}
