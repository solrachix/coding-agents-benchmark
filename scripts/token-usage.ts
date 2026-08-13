export interface TokenUsage {
  source: "opencode_json" | "codex_summary" | "copilot_sdk" | "unavailable";
  sessionId?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  aiCredits?: number;
  premiumRequestCost?: number;
  modelMetrics?: Record<string, { inputTokens: number; outputTokens: number; aiCredits: number }>;
}

type CopilotMetrics = {
  totalNanoAiu?: number;
  totalPremiumRequestCost?: number;
  modelMetrics?: Record<string, {
    totalNanoAiu?: number;
    usage?: { inputTokens?: number; outputTokens?: number };
  } | null>;
};

export function copilotMetricsToTokenUsage(metrics: CopilotMetrics): TokenUsage {
  const modelMetrics: NonNullable<TokenUsage["modelMetrics"]> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  for (const [model, metric] of Object.entries(metrics.modelMetrics ?? {})) {
    if (!metric) continue;
    const input = numberOrZero(metric.usage?.inputTokens);
    const output = numberOrZero(metric.usage?.outputTokens);
    const aiCredits = numberOrZero(metric.totalNanoAiu) / 1e9;
    inputTokens += input;
    outputTokens += output;
    modelMetrics[model] = { inputTokens: input, outputTokens: output, aiCredits };
  }
  const aiCredits = numberOrZero(metrics.totalNanoAiu) / 1e9;
  return {
    source: "copilot_sdk",
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    aiCredits,
    premiumRequestCost: numberOrZero(metrics.totalPremiumRequestCost),
    modelMetrics,
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseCount(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const grouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(trimmed);
  const normalized = grouped ? trimmed.replace(/[.,]/g, "") : trimmed.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function roundCost(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export function parseTokenUsage(log: string, harness: "opencode" | "codex"): TokenUsage {
  if (harness === "opencode") {
    const aggregate = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    };
    let steps = 0;
    let sessionId: string | undefined;

    for (const line of log.split("\n")) {
      try {
        const event = JSON.parse(line) as {
          type?: string;
          sessionID?: string;
          part?: {
            tokens?: {
              total?: number;
              input?: number;
              output?: number;
              reasoning?: number;
              cache?: { read?: number; write?: number };
            };
            cost?: number;
          };
        };
        if (event.type !== "step_finish" || !event.part?.tokens) continue;
        sessionId ??= event.sessionID;
        const tokens = event.part.tokens;
        aggregate.totalTokens += numberOrZero(tokens.total);
        aggregate.inputTokens += numberOrZero(tokens.input);
        aggregate.outputTokens += numberOrZero(tokens.output);
        aggregate.reasoningTokens += numberOrZero(tokens.reasoning);
        aggregate.cacheReadTokens += numberOrZero(tokens.cache?.read);
        aggregate.cacheWriteTokens += numberOrZero(tokens.cache?.write);
        aggregate.cost += numberOrZero(event.part.cost);
        steps++;
      } catch {
        // OpenCode also emits non-JSON tool output in the same stream.
      }
    }

    if (steps === 0) return { source: "unavailable" };
    return {
      source: "opencode_json",
      sessionId,
      totalTokens: aggregate.totalTokens,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      reasoningTokens: aggregate.reasoningTokens,
      cacheReadTokens: aggregate.cacheReadTokens,
      cacheWriteTokens: aggregate.cacheWriteTokens,
      cost: roundCost(aggregate.cost),
    };
  }

  const match = log.match(/tokens\s+used\s*[:\n]\s*([\d.,]+)/i);
  const totalTokens = match ? parseCount(match[1]) : null;
  return totalTokens === null ? { source: "unavailable" } : { source: "codex_summary", totalTokens };
}
