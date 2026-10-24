// Just enough of the browser's origin private file system (OPFS) for Node tests, over a folder on
// disk: directory and file handles, getFile() as a Blob, and createWritable() writing to a swap
// file that replaces the file on close (as in Chrome).

import { openAsBlob } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

type Writable = {
  write(data: Uint8Array | string | { type: "write"; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

const notFound = (name: string) => Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });

function fileHandle(path: string, name: string) {
  return {
    kind: "file" as const,
    name,
    async getFile(): Promise<File> {
      return Object.assign(await openAsBlob(path), { name, lastModified: 0, webkitRelativePath: "" }) as unknown as File;
    },
    async createWritable(): Promise<Writable> {
      const swap = `${path}.crswap-${process.pid}-${Math.random().toString(36).slice(2)}`;
      const fh = await open(swap, "w");
      let at = 0;
      return {
        async write(data) {
          if (typeof data === "string") data = new TextEncoder().encode(data);
          if (data instanceof Uint8Array) {
            await fh.write(data, 0, data.byteLength, at);
            at += data.byteLength;
          } else {
            await fh.write(data.data, 0, data.data.byteLength, data.position);
            at = data.position + data.data.byteLength;
          }
        },
        async close() {
          await fh.close();
          await rename(swap, path);
        },
        async abort() {
          await fh.close().catch(() => {});
          await rm(swap, { force: true });
        },
      };
    },
  };
}

export function nodeOpfs(path: string, name = ""): FileSystemDirectoryHandle {
  const dir = {
    kind: "directory" as const,
    name,
    async getDirectoryHandle(n: string, o?: { create?: boolean }) {
      const p = join(path, n);
      const s = await stat(p).catch(() => null);
      if (!s) {
        if (!o?.create) throw notFound(n);
        await mkdir(p, { recursive: true });
      } else if (!s.isDirectory()) throw Object.assign(new Error(`${n} is a file`), { name: "TypeMismatchError" });
      return nodeOpfs(p, n);
    },
    async getFileHandle(n: string, o?: { create?: boolean }) {
      const p = join(path, n);
      const s = await stat(p).catch(() => null);
      if (!s) {
        if (!o?.create) throw notFound(n);
        await (await open(p, "w")).close();
      } else if (s.isDirectory()) throw Object.assign(new Error(`${n} is a folder`), { name: "TypeMismatchError" });
      return fileHandle(p, n);
    },
    async removeEntry(n: string, o?: { recursive?: boolean }) {
      const p = join(path, n);
      if (!(await stat(p).catch(() => null))) throw notFound(n);
      await rm(p, { recursive: !!o?.recursive });
    },
    async *entries() {
      for (const d of await readdir(path, { withFileTypes: true })) {
        if (d.name.includes(".crswap-")) continue;
        yield [d.name, d.isDirectory() ? nodeOpfs(join(path, d.name), d.name) : fileHandle(join(path, d.name), d.name)] as const;
      }
    },
    async *keys() {
      for (const d of await readdir(path)) if (!d.includes(".crswap-")) yield d;
    },
  };
  return dir as unknown as FileSystemDirectoryHandle;
}

/** navigator.storage.getDirectory() answers with `root`. */
export function installNodeOpfs(root: FileSystemDirectoryHandle): void {
  const storage = { getDirectory: async () => root, estimate: async () => ({}), persist: async () => true };
  Object.defineProperty(globalThis.navigator, "storage", { value: storage, configurable: true });
}
