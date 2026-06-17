import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { reportsRoot } from "./paths.ts";
import type { RunReport } from "./types.ts";

export async function writeRunReport(report: RunReport, output?: string): Promise<string> {
  const reportPath = output ? resolve(output) : resolve(report.runPath, "report.json");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(dirname(reportPath), "summary.md"), formatRunSummary(report));
  return reportPath;
}

export function formatRunSummary(report: RunReport): string {
  const lines = [
    `# Mini-Bench Run ${report.runId}`,
    "",
    `- task: ${report.taskId}`,
    `- status: ${report.status}`,
    `- mode: ${report.mode}`,
    `- durationMs: ${report.durationMs}`,
    `- workspace: ${report.workspacePath}`,
    `- changedFiles: ${report.changedFiles.length > 0 ? report.changedFiles.join(", ") : "none"}`,
    "",
    "## Verifier",
    "",
    `- passed: ${report.verifier.passed}`,
    `- score: ${report.verifier.score}`,
    "",
    ...report.verifier.assertions.map(
      (assertion) =>
        `- ${assertion.passed ? "PASS" : "FAIL"} ${assertion.name}${assertion.message ? `: ${assertion.message}` : ""}`
    ),
    "",
  ];

  if (report.agent) {
    lines.push("## Agent", "");
    lines.push(`- exitCode: ${report.agent.exitCode}`);
    lines.push(`- timedOut: ${report.agent.timedOut}`);
    lines.push(`- stdout: ${report.agent.stdoutPath}`);
    lines.push(`- stderr: ${report.agent.stderrPath}`);
    lines.push(`- outputJsonEvents: ${report.agent.eventsPath}`);
    if (report.agent.eventsSourcePath) {
      lines.push(`- eventsSource: ${report.agent.eventsSourcePath}`);
    }
    if (report.agent.topchesterArtifactsPath) {
      lines.push(`- topchesterArtifacts: ${report.agent.topchesterArtifactsPath}`);
    }
    if (report.agent.debugLogPath) {
      lines.push(`- debugLog: ${report.agent.debugLogPath}`);
    }
    if (report.agent.sessionEventPaths.length > 0) {
      lines.push(`- sessionEvents: ${report.agent.sessionEventPaths.join(", ")}`);
    }
    lines.push(`- eventCount: ${report.agent.eventCount}`);
    lines.push(`- taskPlans: ${report.agent.taskPlanCount}`);
    lines.push(`- todoUpdates: ${report.agent.todoUpdateCount}`);
    lines.push(`- statuses: ${report.agent.statusCount}`);
    lines.push(
      `- toolCalls: ${Object.keys(report.agent.toolCalls).length > 0 ? JSON.stringify(report.agent.toolCalls) : "none"}`
    );
    lines.push(
      `- messageRoles: ${Object.keys(report.agent.messageRoles).length > 0 ? JSON.stringify(report.agent.messageRoles) : "none"}`
    );
    lines.push(
      `- eventKinds: ${Object.keys(report.agent.eventKinds).length > 0 ? JSON.stringify(report.agent.eventKinds) : "none"}`
    );
    if (report.agent.stdoutTail.trim()) {
      lines.push("", "### Stdout Tail", "", "```text", report.agent.stdoutTail.trimEnd(), "```");
    }
    if (report.agent.stderrTail.trim()) {
      lines.push("", "### Stderr Tail", "", "```text", report.agent.stderrTail.trimEnd(), "```");
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function reportIndexPath(): string {
  return resolve(reportsRoot, "latest-report.json");
}
