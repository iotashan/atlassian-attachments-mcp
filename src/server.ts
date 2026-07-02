import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AtlassianClient } from "./http.js";
import type { Sandbox } from "./sandbox.js";

const pkg = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export interface ServerContext {
  client: AtlassianClient;
  sandbox: Sandbox;
}

export function createServer(context: ServerContext): McpServer {
  const server = new McpServer({
    name: "atlassian-attachments-mcp",
    version: pkg.version,
  });

  server.registerTool(
    "get_attachment_limits",
    {
      title: "Get attachment limits",
      description:
        "Report whether attachments are enabled on the Jira site and the maximum upload size in bytes. Jira only.",
      inputSchema: {},
    },
    () =>
      run(async () => {
        const meta = await context.client.json<{
          enabled: boolean;
          uploadLimit: number;
        }>("/rest/api/3/attachment/meta");
        return JSON.stringify(meta);
      }),
  );

  return server;
}

/** Uniform tool-result envelope: errors become isError text, never throws. */
async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
