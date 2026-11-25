import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import * as oidc from "openid-client";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CALLBACK_PATH = "/api/auth/callback";
const CALLBACK_DENIAL_CODES = new Set([
  "OAUTH_INVALID_RESPONSE",
  "OAUTH_JSON_ATTRIBUTE_COMPARISON",
  "OAUTH_JWT_CLAIM_COMPARISON",
  "OAUTH_JWT_TIMESTAMP_CHECK_FAILED",
]);
const OIDC_DENIALS = new Set(["access_denied", "interaction_required", "login_required"]);

export interface OidcAttempt {
  state: string;
  nonce: string;
  code_verifier: string;
}

function readUrl(name: string, value: string | undefined) {
  let url: URL | undefined;
  try {
    url = value ? new URL(value) : undefined;
  } catch {
    // Treat malformed and missing URLs as configuration errors.
  }

  if (!url || url.username || url.password || url.search || url.hash) {
    throw new ServiceUnavailableException(`${name} is not configured correctly.`);
  }
  return url;
}

function isLoopbackHttp(url: URL) {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

function underIssuer(url: URL, issuer: URL) {
  const path = issuer.pathname.replace(/\/$/, "");
  return (
    url.origin === issuer.origin &&
    !url.username &&
    !url.password &&
    (url.pathname === path || url.pathname.startsWith(`${path}/`))
  );
}

function loopbackFetch(issuer: URL, backchannel?: URL): oidc.CustomFetch {
  return (target, options) => {
    const url = new URL(target);
    if (!underIssuer(url, issuer)) {
      throw new ServiceUnavailableException("Unexpected local identity endpoint.");
    }

    // Keep discovery, validation, and browser redirects on the same issuer.
    // Inside Compose only the transport destination changes.
    const destination = new URL(backchannel ?? url);
    destination.pathname = url.pathname;
    destination.search = url.search;
    const body = options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body;
    return fetch(destination, { ...options, body, redirect: "error" });
  };
}

@Injectable()
export class OidcService {
  private configuration?: Promise<oidc.Configuration>;

  get applicationOrigin() {
    const url = readUrl("APP_ORIGIN", process.env.APP_ORIGIN);
    if (url.pathname !== "/" || (url.protocol !== "https:" && !isLoopbackHttp(url))) {
      throw new ServiceUnavailableException("APP_ORIGIN must be an HTTPS or loopback HTTP origin.");
    }
    return url;
  }

  get secureCookies() {
    return this.applicationOrigin.protocol === "https:";
  }

  callbackUrl(requestUrl?: string) {
    const url = new URL(CALLBACK_PATH, this.applicationOrigin);
    if (requestUrl) {
      // Take only the query from the request. The redirect URI is configured.
      url.search = new URL(requestUrl, this.applicationOrigin).search;
    }
    return url;
  }

  async begin() {
    const configuration = await this.getConfiguration();
    const attempt: OidcAttempt = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      code_verifier: oidc.randomPKCECodeVerifier(),
    };
    const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.callbackUrl().href,
      scope: "openid",
      code_challenge: await oidc.calculatePKCECodeChallenge(attempt.code_verifier),
      code_challenge_method: "S256",
      state: attempt.state,
      nonce: attempt.nonce,
      prompt: "login",
    });
    return { attempt, authorizationUrl: authorizationUrl.href };
  }

  async browserLogoutUrl(state: string) {
    if (process.env.OIDC_BROWSER_LOGOUT !== "true") return undefined;

    const configuration = await this.getConfiguration();
    const { issuer, end_session_endpoint: endpoint } = configuration.serverMetadata();
    const clientId = process.env.OIDC_CLIENT_ID?.trim();
    if (!clientId || !endpoint || !underIssuer(new URL(endpoint), new URL(issuer))) return undefined;

    return oidc.buildEndSessionUrl(configuration, {
      client_id: clientId,
      post_logout_redirect_uri: this.callbackUrl().href,
      state,
    }).href;
  }

  async identity(callback: URL, attempt: OidcAttempt) {
    const configuration = await this.getConfiguration();
    let claims: oidc.IDToken | undefined;
    try {
      const tokens = await oidc.authorizationCodeGrant(configuration, callback, {
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        pkceCodeVerifier: attempt.code_verifier,
      });
      claims = tokens.claims();
    } catch (error) {
      if (
        (error instanceof oidc.AuthorizationResponseError && OIDC_DENIALS.has(error.error)) ||
        (error instanceof oidc.ResponseBodyError && error.error === "invalid_grant") ||
        (error instanceof oidc.ClientError && error.code && CALLBACK_DENIAL_CODES.has(error.code))
      ) {
        return undefined;
      }
      throw error;
    }

    if (!claims?.sub || claims.iss !== configuration.serverMetadata().issuer) {
      return undefined;
    }
    return { issuer: claims.iss, subject: claims.sub };
  }

  private getConfiguration() {
    this.configuration ??= this.discover().catch((error: unknown) => {
      this.configuration = undefined;
      throw error;
    });
    return this.configuration;
  }

  private async discover() {
    const issuer = readUrl("OIDC_ISSUER", process.env.OIDC_ISSUER);
    const localHttp = isLoopbackHttp(issuer) && isLoopbackHttp(this.applicationOrigin);
    if (issuer.protocol !== "https:" && !localHttp) {
      throw new ServiceUnavailableException("OIDC_ISSUER requires HTTPS outside local development.");
    }

    let backchannel: URL | undefined;
    if (process.env.OIDC_BACKCHANNEL_URL) {
      backchannel = readUrl("OIDC_BACKCHANNEL_URL", process.env.OIDC_BACKCHANNEL_URL);
      if (!localHttp || backchannel.href !== "http://identity:8080/") {
        throw new ServiceUnavailableException("OIDC_BACKCHANNEL_URL is limited to the local identity service.");
      }
    }

    const clientId = process.env.OIDC_CLIENT_ID?.trim();
    const secret = process.env.OIDC_CLIENT_SECRET;
    if (!clientId || !secret) {
      throw new ServiceUnavailableException("The OIDC client is not configured.");
    }

    const options: oidc.DiscoveryRequestOptions = {
      timeout: 5,
      execute: [oidc.enableNonRepudiationChecks],
    };
    if (localHttp) {
      options.execute = [oidc.enableNonRepudiationChecks, oidc.allowInsecureRequests];
      options[oidc.customFetch] = loopbackFetch(issuer, backchannel);
    }
    const configuration = await oidc.discovery(issuer, clientId, secret, undefined, options);

    const metadata = configuration.serverMetadata();
    if (
      metadata.issuer !== process.env.OIDC_ISSUER?.trim() ||
      !metadata.authorization_endpoint ||
      (localHttp && !underIssuer(new URL(metadata.authorization_endpoint), issuer))
    ) {
      throw new ServiceUnavailableException("The identity provider did not match its configured issuer.");
    }
    return configuration;
  }
}
