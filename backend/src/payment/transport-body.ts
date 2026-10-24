/* Portions adapted from caiovicentino/jev-risk-check-provider, commit 5d894da4aa44d2bed9e47f42c8e9a70f2978975b.
Changes: vendored into the private payment transport; no hosted service calls.
MIT License

Copyright (c) 2026 Caio Vicentino

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
// Bounded reads of third-party response bodies: at most `maxBytes`, and never past `stop`.

/** A response body: a web stream (fetch), or only `text()` (a minimal custom-fetch response). */
export interface BodySource {
  readonly body?: ReadableStream<Uint8Array> | null | undefined;
  text?: (() => Promise<string>) | undefined;
}

export interface LimitedRead {
  /** At most `maxBytes`. */
  data: Buffer;
  /** The body was longer than `maxBytes`: the rest was not read. */
  overflow: boolean;
  /** `stop` fired (a deadline or a cancellation) before the body ended. */
  stopped: boolean;
  /** The body could not be read (e.g. the connection dropped). */
  failed: boolean;
}

const STOPPED: unique symbol = Symbol("stopped");

/** Reads a body within `maxBytes` and until `stop` aborts. Never throws, and never waits on the body once stopped. */
export async function readLimited(source: BodySource, maxBytes: number, stop: AbortSignal): Promise<LimitedRead> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const done = (state: Partial<LimitedRead> = {}): LimitedRead => ({ data: Buffer.concat(chunks), overflow: false, stopped: false, failed: false, ...state });
  const halted = new Promise<typeof STOPPED>((resolve) => {
    if (stop.aborted) resolve(STOPPED);
    else stop.addEventListener("abort", () => resolve(STOPPED), { once: true });
  });

  const body = source.body;
  if (body && typeof body.getReader === "function") {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = body.getReader();
    } catch {
      return done({ failed: true });
    }
    // Not awaited: a stream whose cancel never settles must not hang the caller.
    const cancel = (): void => void reader.cancel().catch(() => undefined);
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), halted]);
        if (next === STOPPED) {
          cancel();
          return done({ stopped: true });
        }
        if (next.done) return done();
        const value: unknown = next.value;
        if (!(value instanceof Uint8Array)) {
          cancel();
          return done({ failed: true });
        }
        if (bytes + value.byteLength > maxBytes) {
          chunks.push(value.subarray(0, maxBytes - bytes));
          bytes = maxBytes;
          cancel();
          return done({ overflow: true });
        }
        chunks.push(value);
        bytes += value.byteLength;
      }
    } catch {
      cancel();
      return done(stop.aborted ? { stopped: true } : { failed: true });
    }
  }
  if (typeof source.text === "function") {
    try {
      const pending = source.text();
      pending.catch(() => undefined);
      const text = await Promise.race([pending, halted]);
      if (text === STOPPED) return done({ stopped: true });
      const data = Buffer.from(String(text), "utf8");
      chunks.push(data.subarray(0, maxBytes));
      return done({ overflow: data.byteLength > maxBytes });
    } catch {
      return done(stop.aborted ? { stopped: true } : { failed: true });
    }
  }
  return done();
}
