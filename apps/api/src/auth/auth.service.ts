import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { DatabaseService } from "../database.service";
import { authCookie, hashAuthToken, newAuthToken, readAuthCookie } from "./auth-cookies";
import { OidcService, type OidcAttempt } from "./oidc.service";

const LOGIN_MAX_AGE = 10 * 60;
const SESSION_MAX_AGE = 8 * 60 * 60;
const SHARE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function shareLoginPath(value: unknown) {
  return typeof value === "string" && SHARE_ID.test(value) ? `/shared/${value.toLowerCase()}` : "/";
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly oidc: OidcService,
  ) {}

  async beginLogin(request: FastifyRequest, share: unknown) {
    const shareId = typeof share === "string" && SHARE_ID.test(share) ? share : null;
    const { authorizationUrl, attempt } = await this.oidc.begin();
    const secure = this.oidc.secureCookies;
    const previous = readAuthCookie(request, "se_login_attempt", secure);
    const token = newAuthToken();

    await this.database.query(
      `
        WITH expired AS (
          DELETE FROM oidc_login_attempts WHERE expires_at <= now() OR token_hash = $6
        )
        INSERT INTO oidc_login_attempts (token_hash, state, nonce, code_verifier, expires_at, share_id)
        VALUES ($1, $2, $3, $4, now() + $5::integer * interval '1 second', $7)
      `,
      [
        hashAuthToken(token),
        attempt.state,
        attempt.nonce,
        attempt.code_verifier,
        LOGIN_MAX_AGE,
        previous ? hashAuthToken(previous) : null,
        shareId,
      ],
    );

    return {
      location: authorizationUrl,
      cookie: authCookie("se_login_attempt", token, LOGIN_MAX_AGE, secure),
    };
  }

  async finishLogin(request: FastifyRequest) {
    const secure = this.oidc.secureCookies;
    const attemptToken = readAuthCookie(request, "se_login_attempt", secure);
    const callback = this.oidc.callbackUrl(request.url);
    const states = callback.searchParams.getAll("state");

    if (!attemptToken || states.length !== 1) {
      return undefined;
    }

    // Take a matching attempt once, even if callbacks race each other.
    const attempts = await this.database.query<OidcAttempt & { share_id: string | null }>(
      `
        DELETE FROM oidc_login_attempts
        WHERE token_hash = $1 AND state = $2 AND expires_at > now()
        RETURNING state, nonce, code_verifier, share_id
      `,
      [hashAuthToken(attemptToken), states[0]],
    );
    const attempt = attempts.rows[0];
    if (!attempt || (!callback.searchParams.has("error") && callback.searchParams.getAll("code").length !== 1)) {
      return undefined;
    }

    const location = attempt.share_id ? `/shared/${attempt.share_id}` : "/";
    const identity = await this.oidc.identity(callback, attempt).catch(() => null);
    if (identity === null) return { location, outcome: "unavailable" } as const;
    if (!identity) return { location, outcome: "denied" } as const;

    const token = newAuthToken();
    const previous = readAuthCookie(request, "se_session", secure);
    const session = await this.database.query<{ token_hash: string }>(
      `
        WITH eligible AS (
          SELECT issuer, subject FROM employees
          WHERE issuer = $2 AND subject = $3 AND active
          FOR SHARE
        ), created AS (
          INSERT INTO auth_sessions (token_hash, issuer, subject, expires_at)
          SELECT $1, issuer, subject, now() + $4::integer * interval '1 second'
          FROM eligible
          RETURNING token_hash
        ), expired AS (
          DELETE FROM auth_sessions
          WHERE expires_at <= now() OR (token_hash = $5 AND EXISTS (SELECT 1 FROM created))
        )
        SELECT token_hash FROM created
      `,
      [
        hashAuthToken(token),
        identity.issuer,
        identity.subject,
        SESSION_MAX_AGE,
        previous ? hashAuthToken(previous) : null,
      ],
    );
    if (!session.rows[0]) return { location, outcome: "denied" } as const;
    return { location, cookie: authCookie("se_session", token, SESSION_MAX_AGE, secure) } as const;
  }

  async requireUser(
    request: FastifyRequest,
    transaction?: Pick<DatabaseService, "query">,
  ): Promise<AuthenticatedUser> {
    if (!request.headers.cookie) {
      throw new UnauthorizedException();
    }
    const token = readAuthCookie(request, "se_session", this.oidc.secureCookies);
    const issuer = process.env.OIDC_ISSUER?.trim();
    if (!token || !issuer) {
      throw new UnauthorizedException();
    }

    const result = await (transaction ?? this.database).query<AuthenticatedUser>(
      `
        SELECT employee.id, employee.username, employee.display_name AS "displayName"
        FROM auth_sessions AS session
        JOIN employees AS employee
          ON employee.issuer = session.issuer AND employee.subject = session.subject
        WHERE session.token_hash = $1 AND session.issuer = $2
          AND session.expires_at > clock_timestamp() AND employee.active
        ${transaction ? "FOR SHARE OF session" : ""}
      `,
      [hashAuthToken(token), issuer],
    );
    const user = result.rows[0];
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }

  async profile(request: FastifyRequest) {
    const user = await this.requireUser(request);
    const { rows: [capabilities] } = await this.database.query<{
      administration: boolean;
      reviewActivity: boolean;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM policy_admins WHERE employee_id = $1) AS administration,
         EXISTS (SELECT 1 FROM audit_reviewers WHERE employee_id = $1) AS "reviewActivity"`,
      [user.id],
    );
    return { ...user, capabilities };
  }

  requireSameOrigin(request: FastifyRequest) {
    if (request.headers.origin !== this.oidc.applicationOrigin.origin) {
      throw new ForbiddenException("A same-origin request is required.");
    }
  }

  clearLoginCookie() {
    return authCookie("se_login_attempt", "", 0, this.oidc.secureCookies);
  }

  async signOut(request: FastifyRequest) {
    this.requireSameOrigin(request);
    const secure = this.oidc.secureCookies;
    const session = readAuthCookie(request, "se_session", secure);
    const attempt = readAuthCookie(request, "se_login_attempt", secure);

    if (session || attempt) {
      await this.database.query(
        `
          WITH discarded AS (
            DELETE FROM oidc_login_attempts WHERE token_hash = $2
          )
          DELETE FROM auth_sessions WHERE token_hash = $1
        `,
        [session ? hashAuthToken(session) : null, attempt ? hashAuthToken(attempt) : null],
      );
    }

    const location = session ? await this.oidc.browserLogoutUrl().catch(() => undefined) : undefined;
    return { location, cookies: [authCookie("se_session", "", 0, secure), this.clearLoginCookie()] };
  }
}
