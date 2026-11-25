import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

type AuthTokenCookie = "se_session" | "se_login_attempt";
type AuthCookie = AuthTokenCookie | "se_logout_attempt";
const AUTH_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOGOUT_MAX_AGE = 5 * 60;
export const logoutStatePrefix = "logout.";

export function newAuthToken() {
  return randomBytes(32).toString("base64url");
}

export function hashAuthToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cookieName(name: AuthCookie, secure: boolean) {
  return secure ? `__Host-${name}` : name;
}

function readCookie(request: FastifyRequest, name: AuthCookie, secure: boolean) {
  const prefix = `${cookieName(name, secure)}=`;
  const values = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));

  return values?.length === 1 ? values[0].slice(prefix.length) : undefined;
}

export function readAuthCookie(request: FastifyRequest, name: AuthTokenCookie, secure: boolean) {
  const token = readCookie(request, name, secure);
  return token && AUTH_TOKEN.test(token) ? token : undefined;
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

function logoutSignature(session: string, nonce: string, deadline: string) {
  return createHmac("sha256", session).update(`cloud-storage:logout:${nonce}:${deadline}`).digest("base64url");
}

export function newLogoutAttempt(session: string, secure: boolean) {
  const nonce = newAuthToken();
  const deadline = String(Math.floor(Date.now() / 1000) + LOGOUT_MAX_AGE);
  return {
    state: logoutStatePrefix + nonce,
    cookie: authCookie("se_logout_attempt", `${nonce}.${deadline}.${logoutSignature(session, nonce, deadline)}`,
      LOGOUT_MAX_AGE, secure),
  };
}

export function matchesLogoutAttempt(request: FastifyRequest, state: string, session: string, secure: boolean) {
  const cookie = readCookie(request, "se_logout_attempt", secure);
  const match = cookie && /^([A-Za-z0-9_-]{43})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(cookie);
  if (!match) return false;

  const [, nonce, deadline, signature] = match;
  const now = Math.floor(Date.now() / 1000);
  if (state !== logoutStatePrefix + nonce || Number(deadline) <= now || Number(deadline) > now + LOGOUT_MAX_AGE) {
    return false;
  }
  return timingSafeEqual(Buffer.from(signature), Buffer.from(logoutSignature(session, nonce, deadline)));
}
