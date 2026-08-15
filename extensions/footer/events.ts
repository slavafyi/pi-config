export const FOOTER_INVALIDATE_EVENT = "footer:invalidate";

interface EventEmitter {
  emit(channel: string, data: unknown): void;
}

export function emitFooterInvalidate(events: EventEmitter): void {
  events.emit(FOOTER_INVALIDATE_EVENT, undefined);
}
