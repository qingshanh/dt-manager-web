export const MESSAGE_READ_STATE_EVENT = 'dt:message-read-state-changed';

export function notifyMessageReadStateChanged() {
  window.dispatchEvent(new Event(MESSAGE_READ_STATE_EVENT));
}
