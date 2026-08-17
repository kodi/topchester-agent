#!/usr/bin/env bun
import { runTopchesterCli } from "./cli.js";
import { claimHerdrLifecycleOwnership, runHerdrLifecycleGuardIfRequested } from "./integrations/herdr.js";

if (!(await runHerdrLifecycleGuardIfRequested())) {
  claimHerdrLifecycleOwnership();
  await runTopchesterCli();
}
