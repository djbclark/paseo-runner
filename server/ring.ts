/** Fixed-capacity byte ring with monotonic cursors: cursor N is the Nth byte ever written. */
export class RingBuffer {
  private readonly buffer: Buffer;
  private total = 0;

  constructor(readonly capacity: number) {
    this.buffer = Buffer.allocUnsafe(capacity);
  }

  get end(): number {
    return this.total;
  }

  /** Cursor of the oldest byte still held. */
  get start(): number {
    return Math.max(0, this.total - this.capacity);
  }

  get truncated(): boolean {
    return this.total > this.capacity;
  }

  write(chunk: Uint8Array): void {
    const source = chunk.length > this.capacity ? chunk.subarray(chunk.length - this.capacity) : chunk;
    // Bytes skipped by the oversize slice still advance the cursor.
    this.total += chunk.length - source.length;
    const offset = this.total % this.capacity;
    const first = Math.min(source.length, this.capacity - offset);
    this.buffer.set(source.subarray(0, first), offset);
    if (first < source.length) this.buffer.set(source.subarray(first), 0);
    this.total += source.length;
  }

  /** Bytes from `cursor` (clamped to what is held) to the end, and the cursor they start at. */
  read(cursor: number): { data: Buffer; start: number } {
    const start = Math.min(Math.max(cursor, this.start), this.total);
    const out = Buffer.allocUnsafe(this.total - start);
    const from = start % this.capacity;
    const first = Math.min(out.length, this.capacity - from);
    this.buffer.copy(out, 0, from, from + first);
    if (first < out.length) this.buffer.copy(out, first, 0, out.length - first);
    return { data: out, start };
  }
}
