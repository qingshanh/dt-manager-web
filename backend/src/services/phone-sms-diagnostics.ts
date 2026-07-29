export type PhoneSmsFilterStatus = "allowed" | "blocked" | "not_returned";
export type PhoneSmsRoutingStatus = "ready" | "incomplete" | "not_applicable";
export type PhoneSmsListenerStatus = "active" | "disabled" | "unhealthy" | "starting" | "not_applicable";
export type PhoneSmsDeliveryEvidence = "received" | "unverified";
export type PhoneSmsDeliveryStatus =
  | "received"
  | "filter_blocked"
  | "phone_inactive"
  | "routing_incomplete"
  | "listener_disabled"
  | "listener_unhealthy"
  | "listener_starting"
  | "unverified";

export type PhoneSmsReceptionDiagnostic = {
  filterStatus: PhoneSmsFilterStatus;
  routingStatus: PhoneSmsRoutingStatus;
  listenerStatus: PhoneSmsListenerStatus;
  deliveryEvidence: PhoneSmsDeliveryEvidence;
  deliveryStatus: PhoneSmsDeliveryStatus;
  repairable: boolean;
  severity: "success" | "warning" | "error" | "default";
  summary: string;
  receivedCount: number;
  lastReceivedAt: string | null;
};

export function buildPhoneSmsReceptionDiagnostic(input: {
  status: "active" | "paused" | "expired" | "cancelled" | "pending";
  expiredTime?: string | null;
  providerId?: number | null;
  packageServiceId?: string | null;
  allowReceiveSms?: boolean;
  receivedCount: number;
  lastReceivedAt: string | null;
  monitorEnabled: boolean;
  monitorRunning: boolean;
  monitorStatus?: string | null;
  monitorListenActive: boolean;
}): PhoneSmsReceptionDiagnostic {
  const filterStatus: PhoneSmsFilterStatus =
    input.allowReceiveSms === true ? "allowed" : input.allowReceiveSms === false ? "blocked" : "not_returned";
  const inactive = input.status !== "active" || isExpired(input.expiredTime);
  const routingStatus: PhoneSmsRoutingStatus = inactive
    ? "not_applicable"
    : !input.providerId || !input.packageServiceId?.trim()
      ? "incomplete"
      : "ready";
  const listenerStatus: PhoneSmsListenerStatus = inactive
    ? "not_applicable"
    : !input.monitorEnabled
      ? "disabled"
      : !input.monitorRunning || input.monitorStatus === "stopped" || input.monitorStatus === "error"
        ? "unhealthy"
        : !input.monitorListenActive
          ? "starting"
          : "active";
  const deliveryEvidence: PhoneSmsDeliveryEvidence = input.receivedCount > 0 ? "received" : "unverified";
  const base = {
    filterStatus,
    routingStatus,
    listenerStatus,
    deliveryEvidence,
    receivedCount: Math.max(0, input.receivedCount),
    lastReceivedAt: input.lastReceivedAt
  };

  if (inactive) {
    return {
      ...base,
      deliveryStatus: "phone_inactive",
      repairable: false,
      severity: "default",
      summary: "号码当前不是可收信状态"
    };
  }
  if (filterStatus === "blocked") {
    return {
      ...base,
      deliveryStatus: "filter_blocked",
      repairable: true,
      severity: "error",
      summary: "App 的来信过滤设置明确关闭，可自动修复"
    };
  }
  if (routingStatus === "incomplete") {
    return {
      ...base,
      deliveryStatus: "routing_incomplete",
      repairable: false,
      severity: "warning",
      summary: "号码服务商路由资料不完整，需要重新同步号码"
    };
  }
  if (listenerStatus === "disabled") {
    return {
      ...base,
      deliveryStatus: "listener_disabled",
      repairable: false,
      severity: "warning",
      summary: "账户监听未开启，App 可能收信但面板不会实时入库"
    };
  }
  if (listenerStatus === "unhealthy") {
    return {
      ...base,
      deliveryStatus: "listener_unhealthy",
      repairable: false,
      severity: "error",
      summary: "账户短信监听未正常运行，可尝试重启监听"
    };
  }
  if (listenerStatus === "starting") {
    return {
      ...base,
      deliveryStatus: "listener_starting",
      repairable: false,
      severity: "warning",
      summary: "账户短信监听正在建立连接，请稍后再次诊断"
    };
  }
  if (input.receivedCount > 0) {
    return {
      ...base,
      deliveryStatus: "received",
      repairable: false,
      severity: "success",
      summary: "面板已有该号码的真实收信记录"
    };
  }
  return {
    ...base,
    deliveryStatus: "unverified",
    repairable: false,
    severity: "warning",
    summary: "过滤和监听看起来正常，但尚无到站记录；需要发送测试短信验证服务商路由"
  };
}

function isExpired(value: string | null | undefined) {
  if (!value) {
    return false;
  }
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? numeric > 1_000_000_000_000
      ? numeric
      : numeric * 1000
    : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}
