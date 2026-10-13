export type AgentEvalClientId = "codex" | "claude-code" | "gemini-cli";

export interface AgentEvalClient {
  readonly id: AgentEvalClientId;
  readonly setupClient: "codex" | "claude_code" | "gemini_cli";
  readonly commandVariable: string;
  readonly defaultCommand: string;
  readonly command: string;
}

export interface PreparedAgentEvalClient {
  readonly environment: Readonly<Record<string, string>>;
  readonly skillDirectory: string;
  readonly arguments: (
    prompt: string,
    approvedTools: readonly string[],
  ) => readonly string[] | Promise<readonly string[]>;
}

export function selectAgentEvalClient(value?: string): AgentEvalClient;

export function agentEvalEnvironment(options: {
  readonly account: string;
  readonly runId: string;
  readonly client: Pick<PreparedAgentEvalClient, "environment">;
}): Record<string, string>;

export function prepareAgentEvalClient(
  client: AgentEvalClient,
  options: {
    readonly evaluationRoot: string;
    readonly account: string;
    readonly model?: string;
    readonly authPaths: string[];
  },
): Promise<PreparedAgentEvalClient>;
