import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash";
import { IgnoredFs } from "./ignored.ts";

const files = {
  "package.json": `{"name":"test"}`,
  ".env": "SECRET=1",
  ".env.local": "KEY=2",
  ".env.production": "KEY=3",
  ".openxyz/build/server.ts": "export {}",
  ".openxyz/cache/foo.json": "{}",
  ".vercel/output/config.json": "{}",
  "src/index.ts": "export {}",
  "src/.env": "NESTED_SECRET=1",
};

function mkFs() {
  return new IgnoredFs(["**/.env*", ".openxyz", ".vercel"], new InMemoryFs(files));
}

describe("IgnoredFs", () => {
  test("readFile — blocks matched file", async () => {
    expect(mkFs().readFile(".env.local")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("readFile — blocks file under matched ancestor dir", async () => {
    expect(mkFs().readFile(".openxyz/build/server.ts")).rejects.toMatchObject({ code: "ENOENT" });
    expect(mkFs().readFile(".vercel/output/config.json")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("readFile — allows unrelated files", async () => {
    expect(await mkFs().readFile("package.json")).toBe(files["package.json"]);
    expect(await mkFs().readFile("src/index.ts")).toBe(files["src/index.ts"]);
  });

  test("exists — false for matched paths", async () => {
    expect(await mkFs().exists(".env")).toBe(false);
    expect(await mkFs().exists(".openxyz")).toBe(false);
    expect(await mkFs().exists(".openxyz/build")).toBe(false);
    expect(await mkFs().exists(".openxyz/build/server.ts")).toBe(false);
    expect(await mkFs().exists(".vercel/output/config.json")).toBe(false);
  });

  test("exists — true for unrelated paths", async () => {
    expect(await mkFs().exists("package.json")).toBe(true);
    expect(await mkFs().exists("src/index.ts")).toBe(true);
  });

  test("readdir — hides matched entries at root", async () => {
    const entries = await mkFs().readdir(".");
    expect(entries).not.toContain(".env");
    expect(entries).not.toContain(".env.local");
    expect(entries).not.toContain(".env.production");
    expect(entries).not.toContain(".openxyz");
    expect(entries).not.toContain(".vercel");
    expect(entries).toContain("package.json");
    expect(entries).toContain("src");
  });

  test("readdir — on matched dir throws ENOENT", async () => {
    expect(mkFs().readdir(".openxyz")).rejects.toMatchObject({ code: "ENOENT" });
    expect(mkFs().readdir(".vercel")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("stat — throws ENOENT for matched paths", async () => {
    expect(mkFs().stat(".env")).rejects.toMatchObject({ code: "ENOENT" });
    expect(mkFs().stat(".openxyz")).rejects.toMatchObject({ code: "ENOENT" });
    expect(mkFs().stat(".openxyz/build")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("writeFile — blocks writes into matched dir", async () => {
    expect(mkFs().writeFile(".env.test", "X=1")).rejects.toMatchObject({ code: "ENOENT" });
    expect(mkFs().writeFile(".openxyz/new.txt", "hi")).rejects.toMatchObject({ code: "ENOENT" });
    expect(mkFs().writeFile(".vercel/out.txt", "hi")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("nested .env — blocked by **/.env* pattern", async () => {
    expect(await mkFs().exists("src/.env")).toBe(false);
    expect(mkFs().readFile("src/.env")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("leading slash — normalized", async () => {
    expect(await mkFs().exists("/.env")).toBe(false);
    expect(mkFs().readFile("/.openxyz/build/server.ts")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("similar-but-different names — not blocked", async () => {
    const fs = new IgnoredFs(
      ["**/.env*", ".openxyz", ".vercel"],
      new InMemoryFs({
        "envs.ts": "ok",
        "openxyzish.md": "ok",
        "notvercel.txt": "ok",
      }),
    );
    expect(await fs.exists("envs.ts")).toBe(true);
    expect(await fs.exists("openxyzish.md")).toBe(true);
    expect(await fs.exists("notvercel.txt")).toBe(true);
  });

  test("getAllPaths — filters matched paths", () => {
    const paths = mkFs().getAllPaths();
    expect(paths.every((p) => !p.includes(".env"))).toBe(true);
    expect(paths.every((p) => !p.startsWith(".openxyz"))).toBe(true);
    expect(paths.every((p) => !p.startsWith(".vercel"))).toBe(true);
    expect(paths).toContain("/package.json");
    expect(paths).toContain("/src/index.ts");
  });

  test("empty ignores list — nothing blocked", async () => {
    const fs = new IgnoredFs([], new InMemoryFs(files));
    expect(await fs.readFile(".env.local")).toBe(files[".env.local"]);
    expect(await fs.exists(".openxyz")).toBe(true);
  });
});
