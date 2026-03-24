import { trimTerminalBuffer } from '../types/app';

interface TerminalStreamDataEvent {
  type: 'data';
  paneId: string;
  data: string;
}

interface TerminalStreamClearEvent {
  type: 'clear';
  paneId: string;
}

type TerminalStreamEvent = TerminalStreamDataEvent | TerminalStreamClearEvent;
type TerminalStreamListener = (event: TerminalStreamEvent) => void;

const bufferByPaneId = new Map<string, string>();
const listenersByPaneId = new Map<string, Set<TerminalStreamListener>>();

export function pushTerminalData(paneId: string, data: string): void {
  bufferByPaneId.set(paneId, trimTerminalBuffer(`${bufferByPaneId.get(paneId) ?? ''}${data}`));
  emitToPane(paneId, {
    type: 'data',
    paneId,
    data,
  });
}

export function clearTerminalStream(paneId: string): void {
  bufferByPaneId.set(paneId, '');
  emitToPane(paneId, {
    type: 'clear',
    paneId,
  });
}

export function getTerminalBuffer(paneId: string): string {
  return bufferByPaneId.get(paneId) ?? '';
}

export function subscribeToTerminalStream(paneId: string, listener: TerminalStreamListener): () => void {
  const existingListeners = listenersByPaneId.get(paneId) ?? new Set<TerminalStreamListener>();
  existingListeners.add(listener);
  listenersByPaneId.set(paneId, existingListeners);

  return () => {
    const paneListeners = listenersByPaneId.get(paneId);
    if (!paneListeners) {
      return;
    }

    paneListeners.delete(listener);
    if (!paneListeners.size) {
      listenersByPaneId.delete(paneId);
    }
  };
}

function emitToPane(paneId: string, event: TerminalStreamEvent): void {
  listenersByPaneId.get(paneId)?.forEach((listener) => {
    listener(event);
  });
}
