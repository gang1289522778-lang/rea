/** Run source-owned producer controls and the public CLI/MCP verification lane. */
export function verifyGhidraPrototypeDiagnostics(options: {
  readonly installation: { readonly analyzeHeadlessPath: string };
  readonly entrypoint?: string;
}): Promise<unknown>;

/** Retain the public transport and workspace when binary cleanup is incomplete. */
export function retirePrototypePublicClient(options: {
  readonly client: Pick<
    import("@modelcontextprotocol/client").Client,
    "callTool" | "close"
  >;
  readonly opened: boolean;
  readonly workspace: string;
  readonly primaryFailure?: unknown;
  readonly onCleanupComplete: () => Promise<void>;
}): Promise<void>;
