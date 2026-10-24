// Ranges of large shared GPU buffers (vertex or index data) that last across renderer rebuilds:
// first fit over each chunk's free list, merged back on free. A streaming step keeps the meshes
// that are still in range where they are and uploads only the new ones (a rebuild used to encode
// and upload every mesh again: 1.1 GB on High in Rattay).

export interface Range {
  buf: GPUBuffer;
  at: number;
  bytes: number;
}

interface Chunk {
  buf: GPUBuffer;
  size: number;
  /** free [offset, length] ranges, sorted by offset, never adjacent */
  free: [number, number][];
}

export class GeometryStore {
  private chunks: Chunk[] = [];

  private device: GPUDevice;
  private bufferUsage: number;
  private chunkSize: number;
  private align: number;

  /** `align`: offsets are multiples of it (the vertex size, so a range starts on a vertex). */
  constructor(device: GPUDevice, bufferUsage: number, chunkSize: number, align: number) {
    this.device = device;
    this.bufferUsage = bufferUsage;
    this.chunkSize = chunkSize;
    this.align = align;
  }

  alloc(bytes: number): Range {
    const need = Math.max(this.align, Math.ceil(bytes / this.align) * this.align);
    for (const c of this.chunks) {
      for (let k = 0; k < c.free.length; k++) {
        const f = c.free[k];
        if (f[1] < need) continue;
        const at = f[0];
        if (f[1] === need) c.free.splice(k, 1);
        else { f[0] += need; f[1] -= need; }
        return { buf: c.buf, at, bytes: need };
      }
    }
    // a new chunk (larger than the usual size for a mesh that doesn't fit one)
    const size = Math.max(this.chunkSize, need);
    const c: Chunk = { buf: this.device.createBuffer({ size, usage: this.bufferUsage | GPUBufferUsage.COPY_DST }), size, free: need < size ? [[need, size - need]] : [] };
    this.chunks.push(c);
    return { buf: c.buf, at: 0, bytes: need };
  }

  free(r: Range): void {
    const c = this.chunks.find((x) => x.buf === r.buf);
    if (!c) return;
    const l = c.free;
    let k = 0;
    while (k < l.length && l[k][0] < r.at) k++;
    l.splice(k, 0, [r.at, r.bytes]);
    // merge with the neighbours
    if (k + 1 < l.length && l[k][0] + l[k][1] === l[k + 1][0]) { l[k][1] += l[k + 1][1]; l.splice(k + 1, 1); }
    if (k > 0 && l[k - 1][0] + l[k - 1][1] === l[k][0]) { l[k - 1][1] += l[k][1]; l.splice(k, 1); }
  }

  /** Give back chunks nothing uses any more (keeping one). */
  trim(): void {
    for (let k = this.chunks.length - 1; k >= 0 && this.chunks.length > 1; k--) {
      const c = this.chunks[k];
      if (c.free.length === 1 && c.free[0][0] === 0 && c.free[0][1] === c.size) { c.buf.destroy(); this.chunks.splice(k, 1); }
    }
  }

  /** Bytes held in chunks, and of those in use. */
  get occupancy(): { held: number; used: number } {
    let held = 0, free = 0;
    for (const c of this.chunks) { held += c.size; for (const f of c.free) free += f[1]; }
    return { held, used: held - free };
  }

  destroy(): void {
    for (const c of this.chunks) c.buf.destroy();
    this.chunks = [];
  }
}
