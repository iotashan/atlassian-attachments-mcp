import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlassianClient } from "./http.js";
import { AtlassianApiError } from "./errors.js";

const CONFIG = {
  siteUrl: "https://example.atlassian.net",
  email: "me@example.com",
  apiToken: "tok123",
};

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AtlassianClient", () => {
  it("sends Basic auth built from email:token", async () => {
    const fetchMock = mockFetch(Response.json({ ok: true }));
    await new AtlassianClient(CONFIG).json("/rest/api/3/myself");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.atlassian.net/rest/api/3/myself");
    expect((init.headers as Headers).get("authorization")).toBe(
      "Basic " + Buffer.from("me@example.com:tok123").toString("base64"),
    );
  });

  it("never lets caller headers displace auth", async () => {
    const fetchMock = mockFetch(Response.json({}));
    await new AtlassianClient(CONFIG).json("/x", {
      headers: new Headers({ Authorization: "Bearer stolen" }),
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get("authorization")).toMatch(/^Basic /);
  });

  it("returns undefined for 204 No Content", async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(
      new AtlassianClient(CONFIG).json("/x", { method: "DELETE" }),
    ).resolves.toBeUndefined();
  });

  it("rejects paths without a leading slash", async () => {
    mockFetch(Response.json({}));
    await expect(new AtlassianClient(CONFIG).json("oops")).rejects.toThrow(
      /must start with/,
    );
  });

  it("maps 401 to a credential hint", async () => {
    mockFetch(new Response("", { status: 401 }));
    const err = await new AtlassianClient(CONFIG)
      .json("/x")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtlassianApiError);
    expect((err as AtlassianApiError).status).toBe(401);
    expect((err as AtlassianApiError).message).toMatch(/ATLASSIAN_API_TOKEN/);
  });

  it("surfaces Jira errorMessages bodies", async () => {
    mockFetch(
      Response.json(
        { errorMessages: ["Issue does not exist"] },
        { status: 404 },
      ),
    );
    await expect(new AtlassianClient(CONFIG).json("/x")).rejects.toThrow(
      /Issue does not exist/,
    );
  });

  it("includes Retry-After on 429", async () => {
    mockFetch(
      new Response("", { status: 429, headers: { "retry-after": "30" } }),
    );
    await expect(new AtlassianClient(CONFIG).json("/x")).rejects.toThrow(
      /Retry after 30s/,
    );
  });

  it("sets the CSRF bypass header on multipart uploads", async () => {
    const fetchMock = mockFetch(Response.json([{ id: "1" }]));
    await new AtlassianClient(CONFIG).uploadMultipart(
      "/rest/api/3/issue/PROJ-1/attachments",
      new FormData(),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Atlassian-Token"]).toBe("no-check");
    expect(init.method).toBe("POST");
  });

  it("returns the raw response for downloads", async () => {
    mockFetch(new Response("binary-bytes", { status: 200 }));
    const res = await new AtlassianClient(CONFIG).download(
      "/rest/api/3/attachment/content/10001",
    );
    expect(await res.text()).toBe("binary-bytes");
  });
});
