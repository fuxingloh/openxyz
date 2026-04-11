#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json";

import start from "./start";

const cli = new Command();

// TODO(@fuxingloh): add description
cli.name("openxyz").version(pkg.version);
cli.addCommand(start);

await cli.parseAsync();
