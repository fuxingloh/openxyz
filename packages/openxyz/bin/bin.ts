#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json";

import start from "./cmds/start";
import build from "./cmds/build";

const cli = new Command();

cli.name("openxyz").description("AI agent harness for agentic workflows").version(pkg.version);
cli.addCommand(start);
cli.addCommand(build);

await cli.parseAsync();
