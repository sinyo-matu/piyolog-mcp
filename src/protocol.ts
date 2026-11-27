/** The only OAuth scope this server grants: read-only access to the records. */
export const MCP_SCOPE = "mcp:read";

/** Tool security schemes advertised to MCP clients (ChatGPT reads these). */
export const MCP_OAUTH_SCHEMES = [{ type: "oauth2" as const, scopes: [MCP_SCOPE] }];

/** Request headers MCP clients may send cross-origin. */
export const MCP_CORS_ALLOW_HEADERS =
  "Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, Last-Event-ID";
