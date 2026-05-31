#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { runCli } from "./index";

void runCli({
  argv: process.argv.slice(2),
  env: process.env,
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  configDir: process.env.ARC_CONFIG_DIR ?? join(homedir(), ".arc-vault"),
}).then((code) => process.exit(code));
