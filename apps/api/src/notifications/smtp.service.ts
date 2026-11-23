import { Injectable } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";
import { OidcService } from "../auth/oidc.service";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SINGLE_ADDRESS = /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

export function readMailbox(value: string | null | undefined) {
  const address = value?.trim();
  return address && address.length <= 254 && SINGLE_ADDRESS.test(address) ? address : undefined;
}

@Injectable()
export class SmtpService {
  private sender?: { address: string; transport: Transporter };

  constructor(private readonly oidc: OidcService) {}

  async send(to: string, subject: string, text: string, messageKey: string) {
    const { address, transport } = this.sender ??= this.configure();
    const recipient = readMailbox(to);
    if (!recipient) throw new Error("A trusted mailbox is required.");
    const fromDomain = address.slice(address.lastIndexOf("@") + 1);
    const result = await transport.sendMail({
      from: address,
      to: recipient,
      subject,
      text,
      messageId: `<${messageKey}@${fromDomain}>`,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (result.accepted?.length !== 1) throw new Error("SMTP did not accept the message.");
  }

  private configure() {
    const host = process.env.SMTP_HOST?.trim();
    const address = readMailbox(process.env.SMTP_FROM);
    const mode = process.env.SMTP_TLS?.trim() || "starttls";
    const port = Number(process.env.SMTP_PORT?.trim() || (mode === "implicit" ? 465 : 587));
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASSWORD;
    if (!host || !address || !Number.isInteger(port) || port < 1 || port > 65535 || Boolean(user) !== Boolean(pass)) {
      throw new Error("SMTP is not configured correctly.");
    }
    if (mode !== "plain" && mode !== "starttls" && mode !== "implicit") {
      throw new Error("SMTP TLS mode is invalid.");
    }
    if (mode === "plain" && (user || !LOOPBACK.has(this.oidc.applicationOrigin.hostname) ||
      (host !== "mailpit" && !LOOPBACK.has(host)))) {
      throw new Error("Cleartext SMTP is limited to the local mail service.");
    }

    return {
      address,
      transport: nodemailer.createTransport({
        host,
        port,
        secure: mode === "implicit",
        requireTLS: mode === "starttls",
        ignoreTLS: mode === "plain",
        auth: user && pass ? { user, pass } : undefined,
        tls: { minVersion: "TLSv1.2" },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
        dnsTimeout: 5000,
      }),
    };
  }
}
