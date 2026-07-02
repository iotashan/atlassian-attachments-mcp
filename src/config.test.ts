import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { ConfigError } from "./errors.js";

const VALID = {
  ATLASSIAN_SITE_URL: "https://example.atlassian.net",
  ATLASSIAN_EMAIL: "me@example.com",
  ATLASSIAN_API_TOKEN: "tok123",
};

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    expect(loadConfig(VALID)).toEqual({
      siteUrl: "https://example.atlassian.net",
      email: "me@example.com",
      apiToken: "tok123",
    });
  });

  it("lists every missing variable in one error", () => {
    expect(() => loadConfig({})).toThrowError(
      /ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN/,
    );
  });

  it("treats blank values as missing", () => {
    expect(() => loadConfig({ ...VALID, ATLASSIAN_API_TOKEN: "  " })).toThrow(
      ConfigError,
    );
  });

  it("normalizes the site URL to its origin", () => {
    const config = loadConfig({
      ...VALID,
      ATLASSIAN_SITE_URL: "https://example.atlassian.net/some/path/",
    });
    expect(config.siteUrl).toBe("https://example.atlassian.net");
  });

  it("rejects non-https URLs", () => {
    expect(() =>
      loadConfig({ ...VALID, ATLASSIAN_SITE_URL: "http://example.atlassian.net" }),
    ).toThrowError(/https/);
  });

  it("rejects garbage URLs", () => {
    expect(() =>
      loadConfig({ ...VALID, ATLASSIAN_SITE_URL: "example.atlassian.net" }),
    ).toThrow(ConfigError);
  });
});
