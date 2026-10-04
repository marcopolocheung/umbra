/**
 * Array-based binary min-heap, shared by every router in the app.
 *
 * Extracted verbatim from `routing.ts`, where it had served the walking
 * `dijkstra` and the `paretoRoutes` A* frontier since they were written. It
 * moved here unchanged so `trainDijkstra` could stop being the one router still
 * scanning an array for its minimum: the transit search state is
 * `(station, route boarded)` — 955 of them for the published NYC subway, and
 * 27,662 once bus shards load. `findBestTrainRoute` runs up to 25 of these
 * searches per route calculation, which is 14.2 s of argmin scanning against
 * 563 ms of heap.
 *
 * No decrease-key. Every caller uses lazy deletion instead — push the improved
 * cost and skip the stale entry on pop — which is why the comparator is
 * injected rather than the heap knowing anything about what it orders.
 */

/** Simple array-based binary min-heap. */
export class MinHeap<T> {
  private data: T[] = [];
  constructor(private cmp: (a: T, b: T) => number) {}

  push(item: T): void {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.data.length;
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cmp(this.data[i], this.data[parent]) < 0) {
        [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  private _sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.cmp(this.data[l], this.data[smallest]) < 0) smallest = l;
      if (r < n && this.cmp(this.data[r], this.data[smallest]) < 0) smallest = r;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

/**
 * `MinHeap` specialised to integer payloads ordered by a numeric key, stored in
 * parallel growable arrays — no comparator call and no `{ id, key }` object
 * per push. `paretoRoutes` pushes one entry per accepted label (~1M on a
 * cross-borough time-aware search), where those two costs were ~15% of the run.
 *
 * The sift logic is `MinHeap`'s line for line (strict `<`, left child checked
 * before right), so for the same push/pop sequence it pops the same payloads in
 * the same order — equal keys included, which is what keeps routes identical.
 */
export class NumericMinHeap {
  private keys = new Float64Array(1024);
  private ids = new Int32Array(1024);
  private n = 0;

  push(id: number, key: number): void {
    if (this.n === this.keys.length) {
      const keys = new Float64Array(this.n * 2);
      keys.set(this.keys);
      this.keys = keys;
      const ids = new Int32Array(this.n * 2);
      ids.set(this.ids);
      this.ids = ids;
    }
    this.keys[this.n] = key;
    this.ids[this.n] = id;
    this._bubbleUp(this.n++);
  }

  /** The payload with the smallest key; -1 when empty. */
  pop(): number {
    if (this.n === 0) return -1;
    const top = this.ids[0];
    this.n--;
    if (this.n > 0) {
      this.keys[0] = this.keys[this.n];
      this.ids[0] = this.ids[this.n];
      this._sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.n;
  }

  private _swap(i: number, j: number): void {
    const k = this.keys[i];
    this.keys[i] = this.keys[j];
    this.keys[j] = k;
    const id = this.ids[i];
    this.ids[i] = this.ids[j];
    this.ids[j] = id;
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[i] < this.keys[parent]) {
        this._swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  private _sinkDown(i: number): void {
    const n = this.n;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.keys[l] < this.keys[smallest]) smallest = l;
      if (r < n && this.keys[r] < this.keys[smallest]) smallest = r;
      if (smallest === i) break;
      this._swap(i, smallest);
      i = smallest;
    }
  }
}
