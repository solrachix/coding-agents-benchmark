export interface AggregationInput {
  key: string;
  score: number | null;
  structuralScore?: number;
  functionalScore?: number;
  functionalMax?: number;
  uiStatus?: string;
  scoreStatus?: string;
  harnessError?: string;
  functionalStatus?: "passed" | "failed" | "evaluator_error";
  duration: number;
  cost?: number;
  aiCredits?: number;
}

export interface AggregatedResult {
  key: string;
  runs: number;
  successes: number;
  mean: number | null;
  median: number | null;
  minimum: number | null;
  maximum: number | null;
  range: number | null;
  p25: number | null;
  p75: number | null;
  iqr: number | null;
  standardDeviation: number | null;
  coefficientOfVariation: number | null;
  successRate: number;
  harnessFailures: number;
  uiUnverified: number;
  functionalFailures: number;
  catastrophicModelFailures: number;
  evaluatorErrors: number;
  meanDuration: number | null;
  meanCost: number | null;
  meanAiCredits: number | null;
  meanScorePerMinute: number | null;
  meanScorePerDollar: number | null;
  meanScorePerCredit: number | null;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return round(sorted[lo]);
  return round(sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo));
}

function standardDeviation(values: number[]): number | null {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return round(Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length));
}

export function aggregateExecutions(inputs: AggregationInput[]): AggregatedResult[] {
  const groups = new Map<string, AggregationInput[]>();
  for (const input of inputs) {
    const group = groups.get(input.key) ?? [];
    group.push(input);
    groups.set(input.key, group);
  }

  return [...groups].map(([key, executions]) => {
    const scored = executions.filter((execution) => execution.score !== null) as Array<AggregationInput & { score: number }>;
    const scores = scored.map((execution) => execution.score);
    const durations = executions.filter((execution) => Number.isFinite(execution.duration)).map((execution) => execution.duration);
    const costs = executions.flatMap((execution) => execution.cost === undefined ? [] : [execution.cost]);
    const credits = executions.flatMap((execution) => execution.aiCredits === undefined ? [] : [execution.aiCredits]);
    const p25 = percentile(scores, 0.25);
    const p75 = percentile(scores, 0.75);
    const mean = average(scores);
    const sd = standardDeviation(scores);
    const scorePerMinute = scored.flatMap((execution) => execution.duration > 0 ? [execution.score / (execution.duration / 60)] : []);
    const scorePerDollar = scored.flatMap((execution) => execution.cost !== undefined && execution.cost > 0 ? [execution.score / execution.cost] : []);
    const scorePerCredit = scored.flatMap((execution) => execution.aiCredits !== undefined && execution.aiCredits > 0 ? [execution.score / execution.aiCredits] : []);
    const minimum = scores.length ? Math.min(...scores) : null;
    const maximum = scores.length ? Math.max(...scores) : null;

    return {
      key,
      runs: executions.length,
      successes: scores.length,
      mean,
      median: median(scores),
      minimum,
      maximum,
      range: minimum !== null && maximum !== null ? round(maximum - minimum) : null,
      p25,
      p75,
      iqr: p25 !== null && p75 !== null ? round(p75 - p25) : null,
      standardDeviation: sd,
      coefficientOfVariation: mean && sd !== null ? round((sd / mean) * 100) : null,
      successRate: round((scores.length / executions.length) * 100),
      harnessFailures: executions.filter((execution) => Boolean(execution.harnessError)).length,
      evaluatorErrors: executions.filter((execution) => execution.functionalStatus === "evaluator_error").length,
      uiUnverified: executions.filter((execution) => execution.scoreStatus === "ui_unverified").length,
      functionalFailures: executions.filter((execution) => !execution.harnessError && execution.functionalStatus !== "evaluator_error" && execution.functionalMax && (execution.functionalScore ?? 0) < execution.functionalMax).length,
      catastrophicModelFailures: executions.filter((execution) => !execution.harnessError && execution.score !== null && execution.score < 70).length,
      meanDuration: average(durations),
      meanCost: average(costs),
      meanAiCredits: average(credits),
      meanScorePerMinute: average(scorePerMinute),
      meanScorePerDollar: average(scorePerDollar),
      meanScorePerCredit: average(scorePerCredit),
    };
  });
}
