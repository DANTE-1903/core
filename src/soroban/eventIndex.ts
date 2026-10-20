/**
 * EventIndex — an in-memory index for ContractEvent objects.
 *
 * Uses a djb2 hash for O(1) insertion and collision tracking.
 * Supports rich filtering via EventIndexFilter predicates.
 */

import type { ContractEvent } from "./subscribeContractEvents";
import type { EventIndexFilter } from "./types";

/** djb2 hash function — returns a hex string */
function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

function stableEventKey(event: ContractEvent): string {
  const value = (event as Record<string, unknown>).value;
  const topics = (event as Record<string, unknown>).topics;
  return JSON.stringify([
    event.id ?? (event as Record<string, unknown>).pagingToken ?? null,
    event.contractId ?? (event as Record<string, unknown>).contract_id ?? null,
    (event as Record<string, unknown>).ledger ?? null,
    event.name ?? (event as Record<string, unknown>).eventType ?? null,
    topics ?? null,
    value ?? null,
  ]);
}

function hashKey(event: ContractEvent): string {
  return djb2Hash(stableEventKey(event));
}

/**
 * An in-memory index for fast lookup and deduplication of ContractEvent objects.
 *
 * - `add(event)` — insert, tracking hash collisions separately.
 * - `query(filter)` — retrieve events matching an EventIndexFilter.
 * - `deduplicate()` — remove exact duplicates (by fullKey), return count removed.
 * - `size()` — total number of stored events (primary + collisions).
 * - `clear()` — remove all events.
 */
export class EventIndex {
  private readonly primary = new Map<string, ContractEvent>();
  private readonly collisions = new Map<string, ContractEvent[]>();

  constructor(private readonly capacity = 0) {}

  /** Insert an event; returns true when it was already present. */
  add(event: ContractEvent): boolean {
    const h = hashKey(event);

    if (!this.primary.has(h)) {
      this.primary.set(h, event);
      this.enforceCapacity();
      return false;
    }

    // Hash is already occupied — check for true equality vs collision
    const existing = this.primary.get(h)!;
    if (stableEventKey(existing) === stableEventKey(event)) {
      // Exact duplicate — do not store again
      return true;
    }

    // Genuine hash collision — stash in collisions list
    if (!this.collisions.has(h)) {
      this.collisions.set(h, []);
    }
    this.collisions.get(h)!.push(event);
    this.enforceCapacity();
    return false;
  }

  private enforceCapacity(): void {
    if (this.capacity <= 0) return;
    const events = this.allEvents();
    if (events.length <= this.capacity) return;
    const retained = events.slice(events.length - this.capacity);
    this.primary.clear();
    this.collisions.clear();
    for (const event of retained) {
      const hash = hashKey(event);
      const existing = this.primary.get(hash);
      if (!existing) this.primary.set(hash, event);
      else this.collisions.set(hash, [...(this.collisions.get(hash) ?? []), event]);
    }
  }

  has(event: ContractEvent): boolean {
    const key = stableEventKey(event);
    return this.allEvents().some((entry) => stableEventKey(entry) === key);
  }

  /** Return all events (primary + collisions) as a flat array. */
  private allEvents(): ContractEvent[] {
    const result: ContractEvent[] = [];
    for (const event of this.primary.values()) {
      result.push(event);
    }
    for (const list of this.collisions.values()) {
      for (const event of list) {
        result.push(event);
      }
    }
    return result;
  }

  /**
   * Query events using an EventIndexFilter.
   *
   * All specified filter fields must match (AND semantics).
   * The `topics` field matches if the event contains any of the provided topics (OR).
   */
  query(filter?: EventIndexFilter): ContractEvent[] {
    let events = this.allEvents();

    if (!filter) return events;

    if (filter.contractId !== undefined) {
      const cid = filter.contractId;
      events = events.filter((e) => String(e.contractId ?? "") === cid);
    }

    if (filter.name !== undefined) {
      const name = filter.name;
      events = events.filter((e) => String(e.name ?? "") === name);
    }

    if (filter.topics !== undefined && filter.topics.length > 0) {
      const filterTopics = filter.topics;
      events = events.filter((e) => {
        const eventTopics = Array.isArray(e.topics) ? e.topics : [];
        return filterTopics.some((ft) => eventTopics.includes(ft));
      });
    }

    if (filter.minLedger !== undefined) {
      const min = filter.minLedger;
      events = events.filter((e) => {
        const ledger = (e as any).ledger;
        return typeof ledger === "number" && ledger >= min;
      });
    }

    if (filter.maxLedger !== undefined) {
      const max = filter.maxLedger;
      events = events.filter((e) => {
        const ledger = (e as any).ledger;
        return typeof ledger === "number" && ledger <= max;
      });
    }

    if (filter.predicate !== undefined) {
      const predicate = filter.predicate;
      events = events.filter((e) => predicate(e));
    }

    return events;
  }

  /**
   * Remove exact duplicate events (same fullKey).
   *
   * @returns The number of duplicate events removed.
   */
  deduplicate(): number {
    const all = this.allEvents();
    const seen = new Map<string, ContractEvent>();

    for (const event of all) {
      const fk = stableEventKey(event);
      if (!seen.has(fk)) {
        seen.set(fk, event);
      }
    }

    const removed = all.length - seen.size;

    // Rebuild index from deduplicated set
    this.primary.clear();
    this.collisions.clear();

    for (const event of seen.values()) {
      const h = hashKey(event);
      if (!this.primary.has(h)) {
        this.primary.set(h, event);
      } else {
        if (!this.collisions.has(h)) {
          this.collisions.set(h, []);
        }
        this.collisions.get(h)!.push(event);
      }
    }

    return removed;
  }

  /** Total number of stored events (primary + all collision entries). */
  size(): number {
    let count = this.primary.size;
    for (const list of this.collisions.values()) {
      count += list.length;
    }
    return count;
  }

  /** Remove all events from the index. */
  clear(): void {
    this.primary.clear();
    this.collisions.clear();
  }
}

export function hashString(value: string): string {
  return djb2Hash(value);
}

export function hashEvent(event: ContractEvent): string {
  return hashKey(event);
}

/** Return only events not already present in the index, adding each new event. */
export function filterNewEvents<T extends ContractEvent>(index: EventIndex, events: T[]): T[] {
  const fresh: T[] = [];
  for (const event of events) {
    if (!index.add(event)) fresh.push(event);
  }
  return fresh;
}
