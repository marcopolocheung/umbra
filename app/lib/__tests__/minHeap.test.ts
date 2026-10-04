import { describe, expect, it } from "vitest";
import { MinHeap, NumericMinHeap } from "../minHeap";

describe("MinHeap", () => {
  it("pops in comparator order, not insertion order", () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    for (const n of [5, 3, 9, 1, 7, 1, 8]) heap.push(n);
    const popped: number[] = [];
    while (heap.size > 0) popped.push(heap.pop() as number);
    expect(popped).toEqual([1, 1, 3, 5, 7, 8, 9]);
  });

  it("is empty-safe", () => {
    const heap = new MinHeap<number>((a, b) => a - b);
    expect(heap.size).toBe(0);
    expect(heap.pop()).toBeUndefined();
  });

  it("honours a comparator over a compound key", () => {
    // The shape both routers use: order on one field of a record.
    const heap = new MinHeap<{ id: string; cost: number }>((a, b) => a.cost - b.cost);
    heap.push({ id: "far", cost: 900 });
    heap.push({ id: "near", cost: 10 });
    heap.push({ id: "mid", cost: 300 });
    expect(heap.pop()?.id).toBe("near");
    expect(heap.pop()?.id).toBe("mid");
    expect(heap.pop()?.id).toBe("far");
  });

  it("can be made stable with a sequence tie-break", () => {
    // A bare binary heap gives no order among equal keys. `trainDijkstra`
    // depends on equal costs popping in insertion order, because that is what
    // the argmin scan it replaced did, and a route the rider is shown must not
    // change with the container. This is how that guarantee is bought.
    const heap = new MinHeap<{ tag: string; cost: number; seq: number }>(
      (a, b) => a.cost - b.cost || a.seq - b.seq,
    );
    let seq = 0;
    for (const tag of ["a", "b", "c", "d", "e", "f"]) {
      heap.push({ tag, cost: 1, seq: seq++ });
    }
    const order: string[] = [];
    while (heap.size > 0) order.push((heap.pop() as { tag: string }).tag);
    expect(order).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("interleaves pushes and pops correctly", () => {
    // Dijkstra's actual access pattern: pop the frontier, push successors.
    const heap = new MinHeap<number>((a, b) => a - b);
    heap.push(10);
    heap.push(4);
    expect(heap.pop()).toBe(4);
    heap.push(7);
    heap.push(2);
    expect(heap.pop()).toBe(2);
    heap.push(6);
    expect(heap.pop()).toBe(6);
    expect(heap.pop()).toBe(7);
    expect(heap.pop()).toBe(10);
    expect(heap.size).toBe(0);
  });
});

describe("NumericMinHeap", () => {
  it("pops exactly what MinHeap pops, equal keys and growth included", () => {
    // `paretoRoutes` swapped one for the other on the promise that no route
    // changes, and with lazy deletion the pop order *is* the search order. A
    // bare binary heap's order among equal keys depends on its sift details, so
    // this interleaves pushes and pops over heavily tied keys, past the initial
    // capacity, and requires the two to agree payload for payload.
    let seed = 12345;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const ref = new MinHeap<{ id: number; key: number }>((a, b) => a.key - b.key);
    const heap = new NumericMinHeap();
    const fromRef: number[] = [];
    const fromNumeric: number[] = [];
    let id = 0;
    for (let step = 0; step < 20_000; step++) {
      if (next() < 0.6 || ref.size === 0) {
        const key = Math.floor(next() * 50);
        ref.push({ id, key });
        heap.push(id, key);
        id++;
      } else {
        fromRef.push(ref.pop()!.id);
        fromNumeric.push(heap.pop());
      }
      expect(heap.size).toBe(ref.size);
    }
    while (ref.size > 0) {
      fromRef.push(ref.pop()!.id);
      fromNumeric.push(heap.pop());
    }
    expect(id).toBeGreaterThan(1024);
    expect(fromNumeric).toEqual(fromRef);
  });

  it("returns -1 when empty", () => {
    const heap = new NumericMinHeap();
    expect(heap.pop()).toBe(-1);
    heap.push(3, 1.5);
    expect(heap.pop()).toBe(3);
    expect(heap.pop()).toBe(-1);
  });
});
