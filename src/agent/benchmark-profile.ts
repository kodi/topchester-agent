export const BENCHMARK_PROFILES = ["terminal-bench"] as const;

export type BenchmarkProfile = (typeof BENCHMARK_PROFILES)[number];

export function parseBenchmarkProfile(value: string): BenchmarkProfile {
  if ((BENCHMARK_PROFILES as readonly string[]).includes(value)) {
    return value as BenchmarkProfile;
  }

  throw new Error(`Unsupported benchmark profile '${value}'. Supported profiles: ${BENCHMARK_PROFILES.join(", ")}.`);
}
