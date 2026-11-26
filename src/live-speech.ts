import { MAX_SEGMENTED_TEXT_LENGTH } from './text-cleaner.js';
import type { Config } from './types.js';

export type AssistantFrame =
  | { type: 'start'; attemptId: string }
  | { type: 'chunk'; attemptId: string; chunk: { type: string; text?: string } }
  | { type: 'end'; attemptId: string; outcome: { kind: string; eventType?: string } };

export interface PendingSpeech {
  seq: number;
  messageId: string;
  text: string;
  attemptId?: string;
  signal?: AbortSignal;
  config?: Config;
}

interface Attempt {
  id: string;
  controller: AbortController;
  raw: string;
  fenced: boolean;
  overflow: boolean;
  committed?: { id: string; text: string };
  emitted: boolean;
  settings: Config;
}

const sentences = new Intl.Segmenter('zh', { granularity: 'sentence' });
const ending = /[.!?。！？…][」』”’"'）)\]]*\s*$/u;

export class LiveSpeechQueue {
  readonly items: PendingSpeech[] = [];
  readonly cancelled: string[] = [];
  sequence = 0;
  private attempt?: Attempt;

  add(messageId: string, text: string, attempt?: Attempt): void {
    if (!text.trim() || this.items.some(item => item.messageId === messageId)) return;
    this.items.push({ seq: ++this.sequence, messageId, text, ...(attempt ? {
      attemptId: attempt.id, signal: attempt.controller.signal, config: attempt.settings,
    } : {}) });
    if (this.items.length > 32) this.items.shift();
  }

  commit(messageId: string, text: string, live: boolean): void {
    if (live && this.attempt) this.attempt.committed = { id: messageId, text };
    else this.add(messageId, text, undefined);
  }

  accept(frame: AssistantFrame, config: Config): void {
    if (!config.autoPlay || !config.liveReply) {
      if (this.attempt) this.withdraw(this.attempt);
      this.attempt = undefined;
      return;
    }
    if (frame.type === 'start') {
      if (this.attempt) this.withdraw(this.attempt);
      this.attempt = { id: frame.attemptId, raw: '', fenced: false, overflow: false,
        emitted: false, controller: new AbortController(), settings: config };
      return;
    }
    const active = this.attempt;
    if (!active || active.id !== frame.attemptId) return;
    if (frame.type === 'chunk') {
      if (frame.chunk.type === 'text-delta' && frame.chunk.text) this.consume(active, frame.chunk.text, false);
      return;
    }
    if (frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message') {
      this.consume(active, '', true);
      if (!active.emitted && active.committed) this.add(active.committed.id, active.committed.text, active);
    } else {
      this.withdraw(active);
    }
    this.attempt = undefined;
  }

  private withdraw(attempt: Attempt): void {
    attempt.controller.abort();
    this.cancelled.push(attempt.id);
    if (this.cancelled.length > 16) this.cancelled.shift();
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].attemptId === attempt.id) this.items.splice(i, 1);
    }
  }

  private consume(attempt: Attempt, delta: string, final: boolean): void {
    if (attempt.overflow) return;
    attempt.raw += delta;
    if (attempt.raw.length > MAX_SEGMENTED_TEXT_LENGTH) {
      attempt.raw = '';
      attempt.overflow = true;
      return;
    }
    const emit = (text: string) => {
      if (!text.trim()) return;
      attempt.emitted = true;
      this.add(`${attempt.id}:${this.sequence + 1}`, text, attempt);
    };
    for (;;) {
      const marker = attempt.raw.indexOf('```');
      if (marker < 0) break;
      if (!attempt.fenced) emit(attempt.raw.slice(0, marker));
      attempt.raw = attempt.raw.slice(marker + 3);
      attempt.fenced = !attempt.fenced;
    }
    if (attempt.fenced) {
      attempt.raw = final ? '' : attempt.raw.match(/`{1,2}$/)?.[0] ?? '';
      return;
    }
    let consumed = 0;
    for (const { segment, index } of sentences.segment(attempt.raw)) {
      if (!final && !ending.test(segment) && index + segment.length === attempt.raw.length) break;
      emit(segment);
      consumed = index + segment.length;
    }
    attempt.raw = attempt.raw.slice(consumed);
  }
}
