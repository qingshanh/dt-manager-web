export const PHONE_INVENTORY_SAFETY_REFRESH_MS = 15 * 60 * 1000;

type PhonePurchaseNoticeLike = {
  type?: number | string | null;
  msgType?: number | string | null;
  content?: string | null;
  senderId?: string | null;
  fromNumber?: string | null;
  conversationId?: string | null;
  rawInfo?: string | null;
};

type PhoneInventoryRefreshState = {
  now: number;
  lastRefreshAt: number | null;
  pendingPurchase: boolean;
};

export function shouldRefreshPhoneInventory(input: {
  now: number;
  lastRefreshAt: number | null;
  pendingPurchase: boolean;
}) {
  return input.pendingPurchase
    || input.lastRefreshAt === null
    || input.now - input.lastRefreshAt >= PHONE_INVENTORY_SAFETY_REFRESH_MS;
}

export function shouldContinueDirectPhoneInventoryListen(
  input: PhoneInventoryRefreshState & {
    stopped: boolean;
    hasDedicatedSlots: boolean;
  }
) {
  return !input.stopped
    && input.hasDedicatedSlots
    && !shouldRefreshPhoneInventory(input);
}

export function shouldRefreshDirectPhoneInventoryAfterPoll(
  input: PhoneInventoryRefreshState & {
    stopped: boolean;
    listened: boolean;
  }
) {
  return !input.stopped
    && input.listened
    && shouldRefreshPhoneInventory(input);
}

export function shouldCommitDirectPhoneInventoryRefresh(input: { stopped: boolean }) {
  return !input.stopped;
}

export function hasPhonePurchaseNotice(messages: PhonePurchaseNoticeLike[]) {
  return messages.some((message) => {
    const type = Number(message.type ?? message.msgType);
    if (type === 1048578) {
      return true;
    }
    if (/\b(?:msgType|type)["']?\s*[:=]\s*1048578\b/i.test(message.rawInfo ?? "")) {
      return true;
    }

    const sender = `${message.senderId ?? message.fromNumber ?? ""}`.trim().toLowerCase();
    const isTeam = message.conversationId === "10000"
      || sender === "2684354560"
      || sender.includes("团队")
      || sender.includes("talku team")
      || sender.includes("dingtone team");
    const content = message.content?.trim() ?? "";
    return isTeam && /^\+?\d[\d\s()-]{6,20}\s*:\s*\d+(?:\.\d+)?$/.test(content);
  });
}

export function hasDirectPushPhonePurchaseNotice(message: PhonePurchaseNoticeLike) {
  return hasPhonePurchaseNotice([{
    msgType: message.msgType,
    content: message.content,
    fromNumber: message.fromNumber,
    rawInfo: message.rawInfo
  }]);
}

export function buildDirectPhoneInventoryIdentity(account: {
  dtUserId: string;
  token: string;
  deviceId?: string | null;
  appVariant?: "dingtone" | "dingdong";
}) {
  return {
    dtUserId: account.dtUserId,
    token: account.token,
    deviceId: account.deviceId,
    appVariant: account.appVariant
  };
}
