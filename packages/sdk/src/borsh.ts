/** Minimal Borsh writer matching the Rust layout of the signed oracle report exactly. */
export class BorshWriter {
  private chunks: number[] = [];
  u8(v: number) {
    this.chunks.push(v & 0xff);
    return this;
  }
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.chunks.push((v >>> (8 * i)) & 0xff);
    return this;
  }
  uint(v: bigint, bytes: number) {
    if (v < 0n || v >= 1n << BigInt(bytes * 8)) throw new Error(`borsh: u${bytes * 8} out of range: ${v}`);
    for (let i = 0; i < bytes; i++) this.chunks.push(Number((v >> BigInt(8 * i)) & 0xffn));
    return this;
  }
  u64(v: bigint | string | number) {
    return this.uint(BigInt(v), 8);
  }
  u128(v: bigint | string | number) {
    return this.uint(BigInt(v), 16);
  }
  string(s: string) {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    for (const x of b) this.chunks.push(x);
    return this;
  }
  vec<T>(items: T[], f: (w: BorshWriter, t: T) => void) {
    this.u32(items.length);
    for (const it of items) f(this, it);
    return this;
  }
  option<T>(v: T | null | undefined, f: (w: BorshWriter, t: T) => void) {
    if (v === null || v === undefined) return this.u8(0);
    this.u8(1);
    f(this, v);
    return this;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}
