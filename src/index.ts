#!/usr/bin/env bun
import { runCLI } from "./cli";
import { CliError } from "./cli/client";
import { startServer } from "./server";

const [command, ...args] = Bun.argv.slice(2);

try {
  if (!command || command === "serve") {
    await startServer(args);
  } else {
    await runCLI(command, args);
  }
} catch (error) {
  if (error instanceof CliError) {
    console.error(`notify: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`notify: ${error.message}`);
    if (process.env.LOG_LEVEL === "debug") console.error(error.stack);
  } else {
    console.error("notify: unexpected error", error);
  }
  process.exitCode = 1;
}
