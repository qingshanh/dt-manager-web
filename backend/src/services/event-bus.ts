import { EventEmitter } from "node:events";

export type AppEvent =
  | { adminId: number; type: "heartbeat"; payload: { time: string; accountId?: number } }
  | { adminId: number; type: "account_status"; payload: { accountId: number; status: string; message?: string } }
  | {
      adminId: number;
      type: "new_message";
      payload: {
        id?: number;
        accountId: number;
        accountNickname: string;
        from: string | null;
        toNumber: string | null;
        content: string;
        msgType?: string;
        receivedAt: string;
      };
    };

class AppEventBus extends EventEmitter {
  emitEvent(event: AppEvent) {
    this.emit("event", event);
  }
}

export const eventBus = new AppEventBus();
