import { ConfigError } from "./errors.js";

export interface Config {
  /** Site origin, e.g. https://your-site.atlassian.net — no trailing slash. */
  siteUrl: string;
  email: string;
  apiToken: string;
}

const REQUIRED = [
  "ATLASSIAN_SITE_URL",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN",
] as const;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        "Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens",
    );
  }

  let url: URL;
  try {
    url = new URL(env.ATLASSIAN_SITE_URL!.trim());
  } catch {
    throw new ConfigError(
      "ATLASSIAN_SITE_URL must be a full URL like https://your-site.atlassian.net",
    );
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("ATLASSIAN_SITE_URL must use https");
  }

  return {
    siteUrl: url.origin,
    email: env.ATLASSIAN_EMAIL!.trim(),
    apiToken: env.ATLASSIAN_API_TOKEN!.trim(),
  };
}
