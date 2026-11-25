export const notificationLoopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function readNotificationOrigin() {
  let origin: URL;
  try {
    origin = new URL(process.env.APP_ORIGIN?.trim() || "");
  } catch {
    throw new Error("APP_ORIGIN is required to create notification links.");
  }

  if (origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash
      || (origin.protocol !== "https:" && !(origin.protocol === "http:" && notificationLoopbackHosts.has(origin.hostname)))) {
    throw new Error("Notification APP_ORIGIN must be an HTTPS or loopback HTTP origin.");
  }
  return origin;
}
