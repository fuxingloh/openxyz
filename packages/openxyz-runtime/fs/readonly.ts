import type { CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";

type ReadFileOpt = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOpt = Parameters<IFileSystem["writeFile"]>[2];
type DirentEntry = Awaited<ReturnType<NonNullable<IFileSystem["readdirWithFileTypes"]>>>[number];

/**
 * Wraps an `IFileSystem` and makes it read-only. Reads forward; every
 * mutation throws `EACCES`. Used for the build-packed home drive — the
 * deployed snapshot is an immutable artifact; the agent can't write to it.
 */
export class ReadOnlyFs implements IFileSystem {
  constructor(private readonly inner: IFileSystem) {}

  readFile(path: string, options?: ReadFileOpt) {
    return this.inner.readFile(path, options);
  }
  readFileBuffer(path: string) {
    return this.inner.readFileBuffer(path);
  }
  exists(path: string) {
    return this.inner.exists(path);
  }
  stat(path: string): Promise<FsStat> {
    return this.inner.stat(path);
  }
  lstat(path: string): Promise<FsStat> {
    return this.inner.lstat(path);
  }
  readdir(path: string) {
    return this.inner.readdir(path);
  }
  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return (await this.inner.readdirWithFileTypes?.(path)) ?? [];
  }
  resolvePath(base: string, path: string) {
    return this.inner.resolvePath(base, path);
  }
  getAllPaths() {
    return this.inner.getAllPaths();
  }
  readlink(path: string) {
    return this.inner.readlink(path);
  }
  realpath(path: string) {
    return this.inner.realpath(path);
  }

  async writeFile(_path: string, _content: FileContent, _options?: WriteFileOpt): Promise<void> {
    throw eacces("writeFile");
  }
  async appendFile(_path: string, _content: FileContent, _options?: WriteFileOpt): Promise<void> {
    throw eacces("appendFile");
  }
  async mkdir(_path: string, _options?: MkdirOptions): Promise<void> {
    throw eacces("mkdir");
  }
  async rm(_path: string, _options?: RmOptions): Promise<void> {
    throw eacces("rm");
  }
  async cp(_src: string, _dest: string, _options?: CpOptions): Promise<void> {
    throw eacces("cp");
  }
  async mv(_src: string, _dest: string): Promise<void> {
    throw eacces("mv");
  }
  async chmod(_path: string, _mode: number): Promise<void> {
    throw eacces("chmod");
  }
  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw eacces("symlink");
  }
  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw eacces("link");
  }
  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    throw eacces("utimes");
  }
}

function eacces(op: string): Error {
  const err = new Error(`EACCES: read-only filesystem, ${op}`) as Error & { code: string };
  err.code = "EACCES";
  return err;
}
