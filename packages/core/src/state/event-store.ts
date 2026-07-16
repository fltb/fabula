// ============================================================================
// EventStore — Append-only event log
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NarrativeEvent } from '../types/index.js';

export class EventStore {
  private events: NarrativeEvent[] = [];
  private eventsByOrder: Map<number, NarrativeEvent> = new Map();

  /** Append an event to the store */
  commit(event: NarrativeEvent): void {
    // Validate: no duplicate narrative orders
    if (this.eventsByOrder.has(event.narrativeOrder)) {
      throw new Error(
        `Event with narrativeOrder ${event.narrativeOrder} already exists: ${this.eventsByOrder.get(event.narrativeOrder)?.id}`,
      );
    }
    this.events.push(event);
    this.eventsByOrder.set(event.narrativeOrder, event);
  }

  /** Get all events sorted by narrative order */
  getAll(): NarrativeEvent[] {
    return [...this.events].sort((a, b) => a.narrativeOrder - b.narrativeOrder);
  }

  /** Get events in a range of narrative orders */
  getRange(fromOrder: number, toOrder: number): NarrativeEvent[] {
    return this.getAll().filter(
      (e) => e.narrativeOrder >= fromOrder && e.narrativeOrder <= toOrder,
    );
  }

  /** Get an event by ID */
  getById(id: string): NarrativeEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Get the last committed narrative order */
  getLastOrder(): number {
    if (this.events.length === 0) return 0;
    return Math.max(...this.events.map((e) => e.narrativeOrder));
  }

  /** Get event count */
  get count(): number {
    return this.events.length;
  }

  /** Load events from an array (for testing/recovery) */
  load(events: NarrativeEvent[]): void {
    this.events = [...events];
    this.eventsByOrder.clear();
    for (const e of this.events) {
      this.eventsByOrder.set(e.narrativeOrder, e);
    }
  }

  /** Persist event log to disk as JSON lines */
  saveToDisk(dirPath: string): void {
    const filePath = path.join(dirPath, 'event_log.jsonl');
    const lines = this.getAll().map((e) => JSON.stringify(e));
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  }

  /** Load event log from disk */
  loadFromDisk(dirPath: string): void {
    const filePath = path.join(dirPath, 'event_log.jsonl');
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    this.events = lines.map((line) => JSON.parse(line) as NarrativeEvent);
    this.eventsByOrder.clear();
    for (const e of this.events) {
      this.eventsByOrder.set(e.narrativeOrder, e);
    }
  }
}
