import { join } from "node:path";

export async function scanChannels(cwd: string): Promise<Record<string, unknown>> {
  const glob = new Bun.Glob("channels/*.ts");
  const out: Record<string, unknown> = {};

  for await (const rel of glob.scan({ cwd })) {
    const file = rel.split("/").pop()!;
    if (file.startsWith("_")) continue;
    const name = file.replace(/\.ts$/, "");
    const mod = await import(join(cwd, rel));
    if (!mod.default) {
      console.warn(`[openxyz] channels/${file} has no default export, skipping`);
      continue;
    }
    out[name] = mod.default;
  }

  return out;
}
