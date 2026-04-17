import type { CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";

type ReadFileOpt = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOpt = Parameters<IFileSystem["writeFile"]>[2];
type DirentEntry = Awaited<ReturnType<NonNullable<IFileSystem["readdirWithFileTypes"]>>>[number];

/**
 * Wraps an `IFileSystem` and makes paths matching any of the supplied globs
 * invisible — reads, writes, stats, and directory traversal behave as if the
 * path does not exist.
 *
 * Patterns use `Bun.Glob` semantics, plus an ancestor check: a path is
 * ignored if the path itself *or any parent directory* matches any glob.
 * That way `".openxyz"` alone hides the directory and everything under it,
 * no separate `".openxyz/**"` entry needed.
 */
export class IgnoredFs implements IFileSystem {
  readonly #globs: Bun.Glob[];

  constructor(
    ignores: string[],
    private readonly inner: IFileSystem,
  ) {
    this.#globs = ignores.map((p) => new Bun.Glob(p));
  }

  #isIgnored(path: string): boolean {
    let p = path.replace(/^\/+/, "");
    while (p !== "") {
      if (this.#globs.some((g) => g.match(p))) return true;
      const slash = p.lastIndexOf("/");
      if (slash === -1) break;
      p = p.slice(0, slash);
    }
    return false;
  }

  async readFile(path: string, options?: ReadFileOpt) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.readFile(path, options);
  }
  async readFileBuffer(path: string) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.readFileBuffer(path);
  }
  async writeFile(path: string, content: FileContent, options?: WriteFileOpt) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.writeFile(path, content, options);
  }
  async appendFile(path: string, content: FileContent, options?: WriteFileOpt) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.appendFile(path, content, options);
  }
  async exists(path: string) {
    if (this.#isIgnored(path)) return false;
    return this.inner.exists(path);
  }
  async stat(path: string): Promise<FsStat> {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.stat(path);
  }
  async lstat(path: string): Promise<FsStat> {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.lstat(path);
  }
  async mkdir(path: string, options?: MkdirOptions) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.mkdir(path, options);
  }
  async readdir(path: string): Promise<string[]> {
    if (this.#isIgnored(path)) throw enoent(path);
    const entries = await this.inner.readdir(path);
    return entries.filter((name) => !this.#isIgnored(joinRel(path, name)));
  }
  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    if (this.#isIgnored(path)) throw enoent(path);
    const entries = (await this.inner.readdirWithFileTypes?.(path)) ?? [];
    return entries.filter((e) => !this.#isIgnored(joinRel(path, e.name)));
  }
  async rm(path: string, options?: RmOptions) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.rm(path, options);
  }
  async cp(src: string, dest: string, options?: CpOptions) {
    if (this.#isIgnored(src)) throw enoent(src);
    if (this.#isIgnored(dest)) throw enoent(dest);
    return this.inner.cp(src, dest, options);
  }
  async mv(src: string, dest: string) {
    if (this.#isIgnored(src)) throw enoent(src);
    if (this.#isIgnored(dest)) throw enoent(dest);
    return this.inner.mv(src, dest);
  }
  resolvePath(base: string, path: string) {
    return this.inner.resolvePath(base, path);
  }
  getAllPaths() {
    return this.inner.getAllPaths().filter((p) => !this.#isIgnored(p));
  }
  async chmod(path: string, mode: number) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.chmod(path, mode);
  }
  async symlink(target: string, linkPath: string) {
    if (this.#isIgnored(linkPath)) throw enoent(linkPath);
    return this.inner.symlink(target, linkPath);
  }
  async link(existingPath: string, newPath: string) {
    if (this.#isIgnored(existingPath)) throw enoent(existingPath);
    if (this.#isIgnored(newPath)) throw enoent(newPath);
    return this.inner.link(existingPath, newPath);
  }
  async readlink(path: string) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.readlink(path);
  }
  async realpath(path: string) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.realpath(path);
  }
  async utimes(path: string, atime: Date, mtime: Date) {
    if (this.#isIgnored(path)) throw enoent(path);
    return this.inner.utimes(path, atime, mtime);
  }
}

function enoent(path: string): Error {
  const err = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string };
  err.code = "ENOENT";
  return err;
}

function joinRel(dir: string, name: string): string {
  if (dir === "" || dir === "/" || dir === ".") return name;
  return dir.replace(/\/+$/, "") + "/" + name;
}
