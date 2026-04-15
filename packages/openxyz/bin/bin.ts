#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json";

import start from "./cmds/start";
import build from "./cmds/build";

const cli = new Command();

// TODO(?): add description
cli.name("openxyz").version(pkg.version);
cli.addCommand(start);
cli.addCommand(build);

await cli.parseAsync();
