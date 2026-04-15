import { type MountConfig } from "just-bash";

export type Permission = "read-write" | "read-only";

export interface Drive {
  mountConfig(mountPoint: string): MountConfig;
}
