#!/usr/bin/env node
import { cwd } from "node:process";
import { Command } from "commander";
import { createAppContext } from "./app/context.js";

const program = new Command();

program.name("topchester").description("KB-first terminal coding agent").version("0.0.0");

program
  .option("-c, --config <path>", "explicit config file path")
  .option("--workspace <path>", "workspace root", cwd());

program.action(() => {
  const context = createContextFromOptions();

  console.log("Topchester interactive mode: not implemented yet");
  printStartupSummary(context);
});

program
  .command("dev")
  .description("start local development mode")
  .action(() => {
    const context = createContextFromOptions();

    console.log("Topchester local dev mode");
    printStartupSummary(context);
  });

const kbCommand = program.command("kb").description("knowledge base commands");

kbCommand
  .command("init")
  .description("initialize a project knowledge base")
  .action(() => {
    const context = createContextFromOptions();

    console.log("KB init: not implemented yet");
    console.log(`workspace: ${context.workspaceRoot}`);
  });

kbCommand
  .command("compile")
  .description("compile the project knowledge base")
  .action(() => {
    const context = createContextFromOptions();

    console.log("KB compile: not implemented yet");
    console.log(`workspace: ${context.workspaceRoot}`);
  });

kbCommand
  .command("status")
  .description("show KB status placeholder")
  .action(() => {
    const context = createContextFromOptions();

    console.log("KB status: not implemented yet");
    console.log(`workspace: ${context.workspaceRoot}`);
  });

program.parse();

function printStartupSummary(context: ReturnType<typeof createAppContext>) {
  const assignments = context.config.models?.assignments ?? {};
  const providers = context.config.models?.providers ?? {};

  console.log(`workspace: ${context.workspaceRoot}`);
  console.log(`default model purpose: ${context.config.models?.defaultPurpose ?? "agent.primary"}`);

  if (Object.keys(assignments).length === 0) {
    console.log("model assignments: none configured");
  } else {
    console.log("model assignments:");
    for (const [purpose, modelRef] of Object.entries(assignments)) {
      console.log(`  ${purpose}: ${modelRef}`);
    }
  }

  if (Object.keys(providers).length === 0) {
    console.log("providers: none configured");
  } else {
    console.log("providers:");
    for (const [providerId, provider] of Object.entries(providers)) {
      const auth = provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : provider.apiKey ? "inline" : "none";
      console.log(`  ${providerId}: ${provider.type} ${provider.baseURL} auth=${auth}`);
    }
  }
}

function createContextFromOptions() {
  const options = program.opts<{ config?: string; workspace: string }>();

  return createAppContext({
    workspaceRoot: options.workspace,
    configPath: options.config,
  });
}
