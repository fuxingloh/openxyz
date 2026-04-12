import { join } from "node:path";

export interface ChannelEntry {
  adapter: unknown;
  agent: string;
  allowlist: Set<string> | undefined;
}

export async function scanChannels(cwd: string): Promise<Record<string, ChannelEntry>> {
  const glob = new Bun.Glob("channels/[!_]*.ts");
  const channels: Record<string, ChannelEntry> = {};

  for await (const rel of glob.scan({ cwd })) {
    const file = rel.split("/").pop()!;
    const name = file.replace(/\.ts$/, "");
    const mod = await import(join(cwd, rel));
    if (!mod.default) {
      console.warn(`[openxyz] channels/${file} has no default export, skipping`);
      continue;
    }
    channels[name] = {
      adapter: mod.default,
      agent: mod.agent ?? "general",
      allowlist: mod.allowlist ? new Set(mod.allowlist) : undefined,
    };
  }

  return channels;
}
