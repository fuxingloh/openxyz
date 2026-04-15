import { OpenXyz } from "@openxyz/harness/openxyz";
import { Command } from "commander";
import { scanTemplate } from "../scan";
import { createState } from "../../state";

export default new Command("start").option("-p, --port <port>", "Port to listen on").action(action);

async function action(): Promise<void> {
  const template = await scanTemplate(process.cwd());
  if (Object.keys(template.channels).length === 0) {
    console.error("[openxyz] no channels found under channels/*.ts — nothing to run");
    process.exit(1);
  }

  const openxyz = new OpenXyz(template);
  const state = await createState(template.cwd);
  await openxyz.init({ state });
  console.log("openxyz running. Ctrl-C to quit.");

  await new Promise<void>((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });

  await openxyz.stop();
  process.exit(0);
}
