import Java from "frida-java-bridge";

let hooksInstalled = false;
let waiters = [];
let latestBalanceResponse = null;
let latestPrivateNumberEvent = null;
let edgeRequestCallbackClass = null;
let edgeRequestSequence = 0;
let edgeRequestPending = {};

function sendLog(level, message, data) {
  send({
    type: "bridge-log",
    level: level,
    message: message,
    data: data === undefined ? null : data
  });
}

function replySuccess(requestId, data) {
  send({
    type: "bridge-result",
    id: requestId,
    ok: true,
    data: data
  });
}

function replyError(requestId, error) {
  const payload = error && typeof error === "object" ? error : { message: String(error) };
  send({
    type: "bridge-result",
    id: requestId,
    ok: false,
    error: payload
  });
}

function publishBridgeEvent(name, data) {
  send({
    type: "bridge-event",
    name: name,
    data: data === undefined ? null : data
  });
}

function cleanString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function normalizePhoneDigits(value) {
  const text = cleanString(value);
  return text ? text.replace(/\D/g, "") : "";
}

function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return null;
}

function readField(obj, fieldName) {
  if (!obj) {
    return null;
  }
  try {
    const raw = obj[fieldName];
    if (raw && typeof raw === "object" && "value" in raw) {
      return raw.value;
    }
    return raw;
  } catch (_error) {
    try {
      let clazz = obj.getClass();
      while (clazz) {
        try {
          const field = clazz.getDeclaredField(fieldName);
          field.setAccessible(true);
          const raw = field.get(obj);
          if (raw && typeof raw === "object" && "value" in raw) {
            return raw.value;
          }
          return raw;
        } catch (_fieldError) {
          clazz = clazz.getSuperclass();
        }
      }
      return null;
    } catch (_reflectError) {
      return null;
    }
  }
}

function cloneJavaObject(obj) {
  return tryCall(() => obj.clone(), obj);
}

function tryCall(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (_error) {
    return fallback;
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeJavaForTransport(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value;
  }
  const jsType = typeof value;
  if (jsType === "string" || jsType === "number" || jsType === "boolean") {
    return value;
  }

  const parsed = tryCall(() => {
    const Gson = Java.use("com.google.gson.Gson");
    const json = String(Gson.$new().toJson(value));
    return json ? JSON.parse(json) : null;
  }, undefined);
  if (parsed !== undefined) {
    return parsed;
  }

  return serializeJavaValue(value, 0);
}

function buildEdgeRequestCallbackClass() {
  if (edgeRequestCallbackClass) {
    return edgeRequestCallbackClass;
  }

  const DtRequestCallBack = Java.use("me.tzim.im.core.edgehttp.DtRequestCallBack");
  edgeRequestCallbackClass = Java.registerClass({
    name: `com.codex.bridge.EdgeRequestCallback${Date.now()}`,
    superClass: DtRequestCallBack,
    fields: {
      requestId: "java.lang.String"
    },
    methods: {
      onRequestSuccessful(response) {
        const requestId = cleanString(this.requestId.value);
        const pending = requestId ? edgeRequestPending[requestId] : null;
        if (!pending) {
          return;
        }
        delete edgeRequestPending[requestId];
        clearTimeout(pending.timeoutId);
        pending.resolve(serializeJavaForTransport(response));
      },
      onRequestFailed(reason) {
        const requestId = cleanString(this.requestId.value);
        const pending = requestId ? edgeRequestPending[requestId] : null;
        if (!pending) {
          return;
        }
        delete edgeRequestPending[requestId];
        clearTimeout(pending.timeoutId);
        const payload = serializeJavaForTransport(reason);
        pending.reject({
          message:
            cleanString(tryCall(() => reason.getReason(), null)) ||
            cleanString(payload && payload.reason) ||
            cleanString(tryCall(() => reason.toString(), null)) ||
            "Edge request failed",
          statusCode: 502,
          code: 502,
          detail: payload
        });
      }
    }
  });
  return edgeRequestCallbackClass;
}

function requestEdgeJson(path, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    Java.perform(() => {
      let requestId = null;
      try {
        const DtHttpUtil = Java.use("me.tzim.im.core.edgehttp.DtHttpUtil");
        const DtRequestParams = Java.use("me.tzim.im.core.edgehttp.DtRequestParams");
        const JString = Java.use("java.lang.String");
        const CallbackClass = buildEdgeRequestCallbackClass();
        const requestParams = DtRequestParams.$new();

        requestId = `edge_${Date.now()}_${(edgeRequestSequence += 1)}`;
        requestParams.setPath(path);
        requestParams.setTimeout(timeoutMs);
        if (params && typeof params === "object") {
          Object.keys(params).forEach((key) => {
            const value = params[key];
            if (value === null || value === undefined || value === "") {
              return;
            }
            requestParams.add(key, String(value));
          });
        }

        const callback = CallbackClass.$new();
        callback.requestId.value = JString.$new(requestId);
        const timeoutId = setTimeout(() => {
          const pending = edgeRequestPending[requestId];
          if (!pending) {
            return;
          }
          delete edgeRequestPending[requestId];
          pending.reject({
            message: `Timed out waiting for edge request ${path}`,
            statusCode: 504,
            code: 504
          });
        }, timeoutMs + 2_000);

        edgeRequestPending[requestId] = { resolve: resolve, reject: reject, timeoutId: timeoutId };
        DtHttpUtil.INSTANCE.edgeRequest(path, requestParams, callback);
      } catch (error) {
        if (requestId && edgeRequestPending[requestId]) {
          clearTimeout(edgeRequestPending[requestId].timeoutId);
          delete edgeRequestPending[requestId];
        }
        reject(toBridgeError(error));
      }
    });
  });
}

function unwrapEdgeData(value) {
  if (!isPlainRecord(value)) {
    return value;
  }
  if (value.data !== undefined && value.data !== null) {
    return value.data;
  }
  if (value.result !== undefined && value.result !== null) {
    return value.result;
  }
  if (value.content !== undefined && value.content !== null) {
    return value.content;
  }
  return value;
}

async function getPointRuntimeContext() {
  return runInJava(() => {
    const DtAppInfo = tryCall(() => Java.use("me.dingtone.app.im.manager.DtAppInfo"), null);
    const PointManager = tryCall(() => Java.use("me.dingtone.app.im.mvp.modules.point.manager.PointManager"), null);
    const SharedPreferencesUtilForPoint = tryCall(
      () => Java.use("me.dingtone.app.im.mvp.modules.point.util.SharedPreferencesUtilForPoint"),
      null
    );
    const DTUserInfo = tryCall(() => Java.use("me.dingtone.app.im.mvp.modules.webactivity.eventdt.data.client.DTUserInfo"), null);
    const appInfo = DtAppInfo ? DtAppInfo.getInstance() : null;
    const pointManager = PointManager ? PointManager.getInstance() : null;
    return {
      appId: cleanString(tryCall(() => (DTUserInfo ? DTUserInfo.getProductId() : null), null)),
      dtUserId: cleanString(tryCall(() => (appInfo ? appInfo.getUserID() : null), null)),
      dingtoneId: cleanString(tryCall(() => (appInfo ? appInfo.getDingtoneID() : null), null)),
      pointUid:
        cleanString(tryCall(() => (pointManager ? pointManager.getUid() : null), null)) ||
        cleanString(tryCall(() => (SharedPreferencesUtilForPoint ? SharedPreferencesUtilForPoint.getUid() : null), null)),
      pointSystemOpen: toBoolean(tryCall(() => (pointManager ? pointManager.isPointSystemOpen() : null), null)),
      pointSystemActivated: toBoolean(tryCall(() => (pointManager ? pointManager.isPointSystemActivation() : null), null))
    };
  });
}

async function fetchPointExtras(timeoutMs) {
  const context = await getPointRuntimeContext().catch(() => ({}));
  const result = {
    context: context,
    dtUserId: cleanString(context && context.dtUserId),
    pointUid: cleanString(context && context.pointUid),
    gameUid: null,
    pointSummaryResponse: null,
    pointGradeInfoResponse: null,
    pointUserInfoResponse: null,
    pointStoreResponse: null,
    gameHomePageResponse: null,
    gamePointRedeemInfoResponse: null,
    errors: {}
  };

  if (cleanString(context && context.appId)) {
    result.pointSummaryResponse = await requestEdgeJson("/point/summary", { appId: context.appId }, timeoutMs).catch((error) => {
      result.errors.pointSummary = toBridgeError(error);
      return null;
    });
    const pointSummaryData = unwrapEdgeData(result.pointSummaryResponse);
    result.pointUid = cleanString(pointSummaryData && pointSummaryData.uid) || result.pointUid;
  }

  const userId = cleanString(context && context.dtUserId);
  const gameAppId = cleanString(context && context.appId);
  if (!result.pointUid && !(userId && gameAppId)) {
    return result;
  }

  const [pointGradeInfoResponse, pointUserInfoResponse, pointStoreResponse, gameHomePageResponse] = await Promise.all([
    result.pointUid
      ? requestEdgeJson("/point/gradeinfo", { uid: result.pointUid }, timeoutMs).catch((error) => {
          result.errors.pointGradeInfo = toBridgeError(error);
          return null;
        })
      : Promise.resolve(null),
    result.pointUid
      ? requestEdgeJson("/point/userinfo", { uid: result.pointUid, zone: 800 }, timeoutMs).catch((error) => {
          result.errors.pointUserInfo = toBridgeError(error);
          return null;
        })
      : Promise.resolve(null),
    result.pointUid
      ? requestEdgeJson("/pointstore/entrance", { uid: result.pointUid, lang: "cn", osType: 2 }, timeoutMs).catch((error) => {
          result.errors.pointStore = toBridgeError(error);
          return null;
        })
      : Promise.resolve(null),
    userId && gameAppId
      ? requestEdgeJson("/game/homePage", { userId: userId, appId: gameAppId, zone: -800, timeStamp: Date.now() }, timeoutMs).catch((error) => {
          result.errors.gameHomePage = toBridgeError(error);
          return null;
        })
      : Promise.resolve(null)
  ]);

  result.pointGradeInfoResponse = pointGradeInfoResponse;
  result.pointUserInfoResponse = pointUserInfoResponse;
  result.pointStoreResponse = pointStoreResponse;
  result.gameHomePageResponse = gameHomePageResponse;

  const gameHomePageData = unwrapEdgeData(gameHomePageResponse);
  result.gameUid = cleanString(gameHomePageData && gameHomePageData.uid);
  if (result.gameUid) {
    result.gamePointRedeemInfoResponse = await requestEdgeJson(
      "/game/point/redeemInfo",
      { uid: result.gameUid, timeStamp: Date.now() },
      timeoutMs
    ).catch((error) => {
      result.errors.gamePointRedeemInfo = toBridgeError(error);
      return null;
    });
  }
  return result;
}

function listToArray(list, maxItems) {
  if (!list) {
    return [];
  }
  const result = [];
  const size = tryCall(() => list.size(), 0);
  const cap = typeof maxItems === "number" ? Math.min(size, maxItems) : size;
  for (let index = 0; index < cap; index += 1) {
    result.push(list.get(index));
  }
  return result;
}

function getForegroundActivity() {
  const DTApplication = tryCall(() => Java.use("me.dingtone.app.im.manager.DTApplication"), null);
  const currentByApp = tryCall(() => (DTApplication ? DTApplication.getInstance().getCurrentActivity() : null), null);
  if (currentByApp) {
    return currentByApp;
  }
  const ActivityThread = tryCall(() => Java.use("android.app.ActivityThread"), null);
  const activityThread = tryCall(() => (ActivityThread ? ActivityThread.currentActivityThread() : null), null);
  const activities = tryCall(() => (activityThread ? activityThread.mActivities.value : null), null);
  const records = tryCall(() => (activities ? activities.values().toArray() : []), []);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const activity = readField(record, "activity");
    const paused = toBoolean(readField(record, "paused"));
    if (activity && !paused) {
      return activity;
    }
  }
  return records.length > 0 ? readField(records[0], "activity") : null;
}

function getCurrentAndroidPackageName() {
  const ActivityThread = tryCall(() => Java.use("android.app.ActivityThread"), null);
  const app = tryCall(() => (ActivityThread ? ActivityThread.currentApplication() : null), null);
  const context = app || getForegroundActivity();
  return cleanString(tryCall(() => (context ? context.getPackageName() : null), null));
}

function inferAppVariantFromPackageName(packageName) {
  if (packageName === "me.dingtone.app.im") {
    return "dingdong";
  }
  if (packageName === "me.talkyou.app.im") {
    return "dingtone";
  }
  return null;
}

function captureAdBuyActivityState() {
  return new Promise((resolve) => {
    Java.perform(() => {
      const currentActivity = getForegroundActivity();
      if (currentActivity) {
        const activityName = cleanString(tryCall(() => currentActivity.getClass().getName(), null));
        if (activityName && activityName.indexOf("AdBuyPhoneNumberChoose") >= 0) {
          resolve(buildAdBuyActivityState(currentActivity));
          return;
        }
      }

      const candidates = [
        "me.dingtone.app.im.phonenumberadbuy.choose.AdBuyPhoneNumberChooseActivity",
        "me.dingtone.app.im.phonenumberadbuy.choose.AdBuyPhoneNumberChooseWithUSActivity",
        "me.dingtone.app.im.phonenumberadbuy.choose.AdBuyPhoneNumberChooseWithAreaCodeActivity",
        "me.dingtone.app.im.phonenumberadbuy.choose.AdBuyPhoneNumberChooseWithCountryActivity",
        "me.dingtone.app.im.phonenumberadbuy.choose.AdBuyPhoneNumberChooseWithUSSearchActivity"
      ];
      let resolved = false;
      const finish = (value) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };

      let pending = candidates.length;
      candidates.forEach((className) => {
        try {
          Java.choose(className, {
            onMatch(instance) {
              finish(buildAdBuyActivityState(instance));
              return "stop";
            },
            onComplete() {
              pending -= 1;
              if (pending === 0) {
                finish({
                  activity: cleanString(tryCall(() => (currentActivity ? currentActivity.getClass().getName() : null), null)),
                  count: 0,
                  phones: []
                });
              }
            }
          });
        } catch (_error) {
          pending -= 1;
          if (pending === 0) {
            finish({
              activity: cleanString(tryCall(() => (currentActivity ? currentActivity.getClass().getName() : null), null)),
              count: 0,
              phones: []
            });
          }
        }
      });
    });
  });
}

function buildAdBuyActivityState(activity) {
  if (!activity) {
    return { activity: null, count: 0, phones: [] };
  }
  const activityName = cleanString(tryCall(() => activity.getClass().getName(), null));
  const adapter = readField(activity, "listAdapter");
  if (!adapter) {
    return {
      activity: activityName,
      count: 0,
      phones: []
    };
  }
  const count = toNumber(tryCall(() => adapter.getCount(), null)) || 0;
  const phones = [];
  const limit = Math.min(count, 10);
  for (let index = 0; index < limit; index += 1) {
    const item = tryCall(() => adapter.getItem(index), null);
    const payload = buildCandidatePhonePayload(item);
    if (payload) {
      phones.push(payload);
    }
  }
  return {
    activity: activityName,
    count,
    phones
  };
}

function waitForEvent(name, timeoutMs, predicate) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      waiters = waiters.filter((item) => item.timeoutId !== timeoutId);
      reject({
        message: `Timed out waiting for ${name}`,
        statusCode: 504,
        code: 504
      });
    }, timeoutMs);

    waiters.push({
      name: name,
      predicate: predicate,
      timeoutId: timeoutId,
      resolve: resolve
    });
  });
}

function emitEvent(name, payload) {
  if (name === "request_private_number") {
    latestPrivateNumberEvent = payload;
    publishBridgeEvent(name, payload);
  }
  const next = [];
  for (let index = 0; index < waiters.length; index += 1) {
    const waiter = waiters[index];
    if (waiter.name !== name) {
      next.push(waiter);
      continue;
    }
    let matched = false;
    try {
      matched = waiter.predicate ? waiter.predicate(payload) : true;
    } catch (_error) {
      matched = false;
    }
    if (matched) {
      clearTimeout(waiter.timeoutId);
      waiter.resolve(payload);
    } else {
      next.push(waiter);
    }
  }
  waiters = next;
}

function runInJava(fn) {
  return new Promise((resolve, reject) => {
    Java.perform(() => {
      try {
        resolve(fn());
      } catch (error) {
        reject(toBridgeError(error));
      }
    });
  });
}

function runOnMainThread(fn) {
  return new Promise((resolve, reject) => {
    Java.perform(() => {
      Java.scheduleOnMainThread(() => {
        try {
          resolve(fn());
        } catch (error) {
          reject(toBridgeError(error));
        }
      });
    });
  });
}

function toBridgeError(error) {
  if (error && typeof error === "object" && error.message) {
    return {
      message: String(error.message),
      statusCode: typeof error.statusCode === "number" ? error.statusCode : 500,
      code: typeof error.code === "number" ? error.code : 500
    };
  }
  return {
    message: String(error),
    statusCode: 500,
    code: 500
  };
}

function serializeJavaValue(value, depth) {
  if (value === null || value === undefined) {
    return null;
  }
  if (depth > 4) {
    return cleanString(value) || String(value);
  }
  const jsType = typeof value;
  if (jsType === "string" || jsType === "number" || jsType === "boolean") {
    return value;
  }
  try {
    const className = value.getClass().getName().toString();
    if (className === "java.lang.String") {
      return String(value);
    }
    if (
      className === "java.lang.Integer" ||
      className === "java.lang.Long" ||
      className === "java.lang.Short" ||
      className === "java.lang.Float" ||
      className === "java.lang.Double"
    ) {
      return Number(String(value));
    }
    if (className === "java.lang.Boolean") {
      return String(value) === "true";
    }
    if (className.indexOf("java.util.ArrayList") === 0 || className.indexOf("java.util.List") === 0) {
      return listToArray(value, 100).map((item) => serializeJavaValue(item, depth + 1));
    }
  } catch (_error) {
    return cleanString(value) || String(value);
  }
  return serializeJavaObject(value, depth + 1);
}

function serializeJavaObject(obj, depth) {
  if (obj === null || obj === undefined) {
    return null;
  }
  const payload = {};
  try {
    payload.__className = obj.$className || obj.getClass().getName().toString();
  } catch (_error) {
    payload.__className = null;
  }
  try {
    const fields = obj.getClass().getDeclaredFields();
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      field.setAccessible(true);
      const name = field.getName().toString();
      payload[name] = serializeJavaValue(field.get(obj), depth + 1);
    }
  } catch (error) {
    payload.__serializeError = String(error);
  }
  return payload;
}

function writeField(obj, fieldName, value) {
  if (!obj) {
    return;
  }
  const field = obj[fieldName];
  if (field && typeof field === "object" && "value" in field) {
    field.value = value;
    return;
  }
  obj[fieldName] = value;
}

function collectRecords(value, depth, bucket, visited) {
  if (depth > 5 || value === null || value === undefined) {
    return bucket;
  }
  if (!bucket) {
    bucket = [];
  }
  if (!visited) {
    visited = [];
  }
  if (visited.indexOf(value) >= 0) {
    return bucket;
  }
  visited.push(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectRecords(value[index], depth + 1, bucket, visited);
    }
    return bucket;
  }

  let record = null;
  if (typeof value === "object") {
    if (value.getClass && typeof value.getClass === "function") {
      record = serializeJavaObject(value, 0);
    } else {
      record = value;
    }
  }

  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return bucket;
  }

  bucket.push(record);
  const keys = Object.keys(record);
  for (let index = 0; index < keys.length; index += 1) {
    collectRecords(record[keys[index]], depth + 1, bucket, visited);
  }
  return bucket;
}

function pickStringFromRecords(records, keys) {
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    if (!record || typeof record !== "object") {
      continue;
    }
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const value = cleanString(record[keys[keyIndex]]);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function pickNumberFromRecords(records, keys) {
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    if (!record || typeof record !== "object") {
      continue;
    }
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const value = toNumber(record[keys[keyIndex]]);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

function findNextGradeThreshold(walletGradeList, currentGrade) {
  const nextGrade = Math.min(4, Math.max(0, (currentGrade || 0) + 1));
  return (
    toNumber(readField(walletGradeList, `_$${nextGrade}`)) ||
    toNumber(readField(walletGradeList, `_${nextGrade}`)) ||
    toNumber(readField(walletGradeList, String(nextGrade)))
  );
}

function buildOwnedPhonePayload(item) {
  if (!item) {
    return null;
  }
  const expireTime = toNumber(readField(item, "expireTime"));
  const suspendFlag = toBoolean(readField(item, "suspendFlag"));
  const isExpire = toNumber(readField(item, "isExpire"));
  let status = "active";
  if (suspendFlag) {
    status = "paused";
  } else if (isExpire === 1 || (expireTime !== null && expireTime > 0 && expireTime * 1000 <= Date.now())) {
    status = "expired";
  }
  return {
    phoneNumber: cleanString(readField(item, "phoneNumber")),
    countryCode: toNumber(readField(item, "countryCode")),
    providerId: toNumber(readField(item, "providerId")),
    displayName: cleanString(readField(item, "displayName")),
    status: status,
    purchaseType: toNumber(readField(item, "purchaseType")),
    payType: toNumber(readField(item, "payType")),
    validPeriodDays: toNumber(readField(item, "usePeriod")),
    gainTime: cleanString(readField(item, "gainTime")),
    expireTime: cleanString(readField(item, "expireTime")),
    autoRenew: toBoolean(readField(item, "autoRenew")),
    isPrimary: toBoolean(readField(item, "primaryFlag")),
    isGoodNumber: toBoolean(readField(item, "goodNumberLevel")),
    portoutInfo: cleanString(readField(item, "portoutInfo")),
    rawJson: serializeJavaObject(item, 0)
  };
}

function buildCandidatePhonePayload(item) {
  if (!item) {
    return null;
  }
  const rawRecord = isPlainRecord(serializeJavaObject(item, 1)) ? serializeJavaObject(item, 1) : {};
  const displayName =
    cleanString(readField(item, "cityName")) ||
    cleanString(readField(item, "stateName")) ||
    cleanString(rawRecord.cityName) ||
    cleanString(rawRecord.stateName);
  return {
    phoneNumber: cleanString(readField(item, "phoneNumber")) || cleanString(rawRecord.phoneNumber),
    countryCode: toNumber(readField(item, "countryCode")) || toNumber(rawRecord.countryCode),
    areaCode: toNumber(readField(item, "areaCode")) || toNumber(rawRecord.areaCode),
    providerId: toNumber(readField(item, "providerId")) || toNumber(rawRecord.providerId),
    packageServiceId: cleanString(readField(item, "packageServiceId")) || cleanString(rawRecord.packageServiceId),
    category: toNumber(readField(item, "category")) || toNumber(rawRecord.category),
    phoneType: toNumber(readField(item, "phoneType")) || toNumber(rawRecord.phoneType),
    displayName: displayName,
    cityName: cleanString(readField(item, "cityName")) || cleanString(rawRecord.cityName),
    stateName: cleanString(readField(item, "stateName")) || cleanString(rawRecord.stateName),
    isoCountryCode:
      cleanString(readField(item, "isoCountryCode")) ||
      cleanString(readField(item, "isoCC")) ||
      cleanString(rawRecord.isoCountryCode) ||
      cleanString(rawRecord.isoCC),
    goodNumberLevel: toNumber(readField(item, "goodNumberLevel")) || toNumber(rawRecord.goodNumberLevel),
    useHistory: toNumber(readField(item, "useHistory")) || toNumber(rawRecord.useHistory),
    usePeriod: toNumber(readField(item, "usePeriod")) || toNumber(rawRecord.usePeriod),
    price:
      toNumber(readField(item, "orderPrice")) ||
      toNumber(readField(item, "price")) ||
      toNumber(readField(item, "creditNum")) ||
      toNumber(readField(item, "credit")) ||
      toNumber(readField(item, "reserved5")) ||
      toNumber(readField(item, "amount")) ||
      toNumber(readField(item, "cost")) ||
      toNumber(rawRecord.orderPrice) ||
      toNumber(rawRecord.price) ||
      toNumber(rawRecord.creditNum) ||
      toNumber(rawRecord.credit) ||
      toNumber(rawRecord.reserved5) ||
      toNumber(rawRecord.amount) ||
      toNumber(rawRecord.cost),
    rawJson: {
      phoneNumber: cleanString(rawRecord.phoneNumber),
      countryCode: toNumber(rawRecord.countryCode),
      areaCode: toNumber(rawRecord.areaCode),
      providerId: toNumber(rawRecord.providerId),
      packageServiceId: cleanString(rawRecord.packageServiceId),
      cityName: cleanString(rawRecord.cityName),
      stateName: cleanString(rawRecord.stateName),
      isoCountryCode: cleanString(rawRecord.isoCountryCode),
      goodNumberLevel: toNumber(rawRecord.goodNumberLevel),
      useHistory: toNumber(rawRecord.useHistory),
      usePeriod: toNumber(rawRecord.usePeriod),
      orderPrice: toNumber(rawRecord.orderPrice),
      price: toNumber(rawRecord.price),
      creditNum: toNumber(rawRecord.creditNum),
      credit: toNumber(rawRecord.credit),
      reserved5: toNumber(rawRecord.reserved5)
    }
  };
}

function extractRequestPrivateNumberResponse(resp) {
  const phones = tryCall(() => {
    const list = readField(resp, "phones");
    return listToArray(list, 100).map((item) => buildCandidatePhonePayload(item)).filter(Boolean);
  }, []);
  const result = extractRestResponse(resp);
  result.freeChance = toNumber(readField(resp, "freeChance"));
  result.phones = phones;
  return result;
}

function findOwnedPhoneItem(phoneNumber) {
  const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
  return tryCall(() => PrivatePhoneNumberManager.getInstance().getPrivateItemByPrivateNumber(phoneNumber), null);
}

function isSamePhoneNumber(left, right) {
  const leftDigits = normalizePhoneDigits(left);
  const rightDigits = normalizePhoneDigits(right);
  if (!leftDigits || !rightDigits) {
    return false;
  }
  return leftDigits === rightDigits || leftDigits.endsWith(rightDigits) || rightDigits.endsWith(leftDigits);
}

function stripPhoneCountryPrefix(phoneNumber, countryCode) {
  const digits = normalizePhoneDigits(phoneNumber);
  const prefix = cleanString(countryCode);
  if (prefix && digits.indexOf(prefix) === 0 && digits.length > prefix.length + 3) {
    return digits.slice(prefix.length);
  }
  return digits;
}

async function ensureOwnedPhoneItem(phoneNumber, timeoutMs) {
  let item = await runInJava(() => findOwnedPhoneItem(phoneNumber));
  if (item) {
    return item;
  }
  const responsePromise = waitForEvent("phone_list_updated", Math.min(timeoutMs, 15_000), () => true).catch(() => null);
  await runOnMainThread(() => {
    const TpClient = Java.use("me.dingtone.app.im.tp.TpClient");
    const DTGetPrivateNumberListCmd = Java.use("me.dingtone.app.im.datatype.DTGetPrivateNumberListCmd");
    TpClient.getInstance().GetPrivateNumberList(DTGetPrivateNumberListCmd.$new());
  });
  await responsePromise;
  item = await runInJava(() => findOwnedPhoneItem(phoneNumber));
  return item;
}

async function waitForOwnedPhoneItem(phoneNumber, timeoutMs) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(5_000, timeoutMs);
  let lastItem = await runInJava(() => findOwnedPhoneItem(phoneNumber));
  if (lastItem) {
    return lastItem;
  }

  while (Date.now() < deadline) {
    const remaining = Math.max(500, deadline - Date.now());
    await ensureOwnedPhoneItem(phoneNumber, Math.min(remaining, 15_000)).catch(() => null);
    lastItem = await runInJava(() => findOwnedPhoneItem(phoneNumber));
    if (lastItem) {
      return lastItem;
    }
    await delay(Math.min(1_500, Math.max(250, deadline - Date.now())));
  }
  return null;
}

function extractRestResponse(resp) {
  const result = {
    errCode: toNumber(tryCall(() => resp.getErrCode(), null)),
    reason: cleanString(tryCall(() => resp.getReason(), null)),
    result: toNumber(tryCall(() => resp.getResult(), null)),
    commandCookie: toNumber(tryCall(() => resp.getCommandCookie(), null)),
    commandTag: toNumber(tryCall(() => resp.getCommandTag(), null)),
    toString: cleanString(tryCall(() => resp.toString(), null))
  };
  const returnedAccessCode = toNumber(readField(resp, "returnedAccessCode"));
  if (returnedAccessCode !== null) {
    result.returnedAccessCode = returnedAccessCode;
  }
  const confirmCode = cleanString(readField(resp, "confirmCode"));
  if (confirmCode) {
    result.confirmCode = confirmCode;
  }
  const remainNum = toNumber(readField(resp, "remainNum"));
  if (remainNum !== null) {
    result.remainNum = remainNum;
  }
  const userId = cleanString(readField(resp, "userID"));
  if (userId) {
    result.userID = userId;
  }
  const publicUserId = cleanString(readField(resp, "publicUserID"));
  if (publicUserId) {
    result.publicUserID = publicUserId;
  }
  const deviceBaseId = toNumber(readField(resp, "deviceBaseId"));
  if (deviceBaseId !== null) {
    result.deviceBaseId = deviceBaseId;
  }
  return result;
}

function buildSnapshotPayload(extraPayload) {
  const DtAppInfo = Java.use("me.dingtone.app.im.manager.DtAppInfo");
  const TpClient = Java.use("me.dingtone.app.im.tp.TpClient");
  const MyProfileMgr = Java.use("me.dingtone.app.im.manager.MyProfileMgr");
  const DTApplication = Java.use("me.dingtone.app.im.manager.DTApplication");
  const PointManager = tryCall(() => Java.use("me.dingtone.app.im.mvp.modules.point.manager.PointManager"), null);
  const SharedPreferencesUtilForPoint = tryCall(
    () => Java.use("me.dingtone.app.im.mvp.modules.point.util.SharedPreferencesUtilForPoint"),
    null
  );

  const appInfo = DtAppInfo.getInstance();
  const tpClient = TpClient.getInstance();
  const profile = tryCall(() => MyProfileMgr.getMyProfile(), null);
  const pointManager = PointManager ? PointManager.getInstance() : null;
  const pointExtras = isPlainRecord(extraPayload) ? extraPayload : {};
  const pointSummaryResponse = pointExtras.pointSummaryResponse || null;
  const pointGradeInfoResponse = pointExtras.pointGradeInfoResponse || null;
  const pointUserInfoResponse = pointExtras.pointUserInfoResponse || null;
  const pointStoreResponse = pointExtras.pointStoreResponse || null;
  const gameHomePageResponse = pointExtras.gameHomePageResponse || null;
  const gamePointRedeemInfoResponse = pointExtras.gamePointRedeemInfoResponse || null;
  const pointSummaryData = unwrapEdgeData(pointSummaryResponse);
  const pointGradeInfoData = unwrapEdgeData(pointGradeInfoResponse);
  const pointUserInfoData = unwrapEdgeData(pointUserInfoResponse);
  const pointStoreData = unwrapEdgeData(pointStoreResponse);
  const gameHomePageData = unwrapEdgeData(gameHomePageResponse);
  const gamePointRedeemInfoData = unwrapEdgeData(gamePointRedeemInfoResponse);

  const pointGradeInfo = tryCall(() => (pointManager ? pointManager.getPointGradeInfo() : null), null);
  const walletInfo = tryCall(() => (pointManager ? pointManager.getWalletInfo() : null), null);
  const walletInviteConfig = tryCall(() => (pointManager ? pointManager.getWalletInviteConfig() : null), null);
  const walletRateConfig = tryCall(() => (pointManager ? pointManager.getWalletRateConfig() : null), null);
  const walletContent = tryCall(() => (walletInfo ? walletInfo.getContent() : null), null);
  const walletGradeList = tryCall(() => (walletInfo ? walletInfo.getGradeList() : null), null);
  const cachedPointGrade = toNumber(tryCall(() => (pointManager ? pointManager.getPointGrade() : null), null));
  const directPointGrade = toNumber(pointGradeInfoData && pointGradeInfoData.userGrade);
  const pointGrade = directPointGrade !== null ? directPointGrade : cachedPointGrade;
  const pointGradeLevel =
    pointGrade !== null
      ? pointGrade + 1
      : toNumber(tryCall(() => (pointManager ? pointManager.getPointGradeLevel() : null), null));
  const currentGrade = toNumber(tryCall(() => (pointManager ? pointManager.getCurrentGrade() : null), null));
  const appContext = tryCall(() => DTApplication.getInstance(), null);
  const pointUid =
    cleanString(pointExtras.pointUid) ||
    cleanString(pointSummaryData && pointSummaryData.uid) ||
    cleanString(tryCall(() => (pointManager ? pointManager.getUid() : null), null)) ||
    cleanString(tryCall(() => (SharedPreferencesUtilForPoint ? SharedPreferencesUtilForPoint.getUid() : null), null));
  const membershipBenefitCodes =
    Array.isArray(pointGradeInfoData && pointGradeInfoData.benefits) && pointGradeInfoData.benefits.length > 0
      ? pointGradeInfoData.benefits
      : pointGradeInfo
        ? listToArray(tryCall(() => pointGradeInfo.getBenefits(), null), 50)
        : [];
  const membershipBenefits = membershipBenefitCodes
    .map((item) => {
      const code = String(item).padStart(3, "0");
      return {
        code: code,
        name: cleanString(tryCall(() => (pointManager && appContext ? pointManager.getRightsByType(appContext, code) : null), null))
      };
    })
    .filter((item) => item.name);
  const pointStoreProducts =
    Array.isArray(pointStoreData && pointStoreData.products)
      ? pointStoreData.products
          .map((item) => {
            if (!isPlainRecord(item)) {
              return null;
            }
            return {
              id: cleanString(item.id),
              name: cleanString(item.name),
              price: toNumber(item.price),
              stock: toNumber(item.stock)
            };
          })
          .filter((item) => item && item.name)
      : [];
  const gamePointProducts =
    Array.isArray(gamePointRedeemInfoData && gamePointRedeemInfoData.products)
      ? gamePointRedeemInfoData.products
          .map((item) => {
            if (!isPlainRecord(item)) {
              return null;
            }
            return {
              id: cleanString(item.productId),
              name: cleanString(item.productName),
              price: toNumber(item.price),
              stock: toNumber(item.convertibleNum)
            };
          })
          .filter((item) => item && item.name)
      : [];
  const mergedBenefitProducts = [...membershipBenefits];
  [...pointStoreProducts, ...gamePointProducts].forEach((item) => {
    if (!item || !item.name) {
      return;
    }
    const existed = mergedBenefitProducts.some((candidate) => candidate.name === item.name);
    if (!existed) {
      mergedBenefitProducts.push({
        code: item.id || "",
        name: item.stock !== null ? `${item.name}（剩余 ${item.stock}）` : item.name,
        price: item.price
      });
    }
  });

  const balanceDetails = latestBalanceResponse ? collectRecords(latestBalanceResponse, 0) : [];
  const profileRecords = collectRecords(profile, 0);
  const pointRecords = collectRecords(
    {
      pointUid: pointUid,
      pointSummaryResponse: pointSummaryResponse,
      pointSummaryData: pointSummaryData,
      pointGradeInfoResponse: pointGradeInfoResponse,
      pointGradeInfoData: pointGradeInfoData,
      pointUserInfoResponse: pointUserInfoResponse,
      pointUserInfoData: pointUserInfoData,
      pointStoreResponse: pointStoreResponse,
      pointStoreData: pointStoreData,
      pointStoreProducts: pointStoreProducts,
      gameUid: cleanString(pointExtras.gameUid) || cleanString(gameHomePageData && gameHomePageData.uid),
      gameHomePageResponse: gameHomePageResponse,
      gameHomePageData: gameHomePageData,
      gamePointRedeemInfoResponse: gamePointRedeemInfoResponse,
      gamePointRedeemInfoData: gamePointRedeemInfoData,
      gamePointProducts: gamePointProducts,
      pointGradeInfo: pointGradeInfo ? serializeJavaObject(pointGradeInfo, 0) : null,
      walletInfo: walletInfo ? serializeJavaObject(walletInfo, 0) : null,
      walletContent: walletContent ? serializeJavaObject(walletContent, 0) : null,
      walletInviteConfig: walletInviteConfig ? serializeJavaObject(walletInviteConfig, 0) : null,
      walletRateConfig: walletRateConfig ? serializeJavaObject(walletRateConfig, 0) : null,
      membershipBenefits: mergedBenefitProducts,
      pointGrade: pointGrade,
      pointGradeLevel: pointGradeLevel,
      currentGrade: currentGrade,
      pointSystemOpen: toBoolean(tryCall(() => (pointManager ? pointManager.isPointSystemOpen() : null), null)),
      pointSystemActivated: toBoolean(tryCall(() => (pointManager ? pointManager.isPointSystemActivation() : null), null))
    },
    0
  );
  const snapshotRecords = [...balanceDetails, ...profileRecords, ...pointRecords];
  const primaryBalance =
    pickNumberFromRecords(snapshotRecords, [
      "primaryBalance",
      "primary_balance",
      "balance",
      "balanceAmount",
      "balance_amount",
      "availableBalance",
      "available_balance",
      "walletBalance",
      "wallet_balance",
      "coinBalance",
      "coin_balance",
      "creditBalance",
      "credit_balance"
    ]) ?? toNumber(tryCall(() => appInfo.getBalance(), null));
  const progressPointTotal =
    pickNumberFromRecords(snapshotRecords, [
      "progressPointTotal",
      "progress_point_total",
      "totalProgressPoint",
      "total_progress_point",
      "progressTotalPoint",
      "progress_total_point",
      "pointTotal",
      "point_total",
      "nextGradePoint",
      "next_grade_point",
      "nextLevelPoint",
      "next_level_point"
    ]) || findNextGradeThreshold(walletGradeList, pointGrade);
  const directUserGrade =
    toNumber(pointUserInfoData && pointUserInfoData.userGrade) !== null
      ? toNumber(pointUserInfoData && pointUserInfoData.userGrade) + 1
      : pointGradeLevel;

  const snapshot = {
    dtDingtoneId:
      cleanString(profile ? readField(profile, "dingtoneID") : null) ||
      cleanString(tryCall(() => appInfo.getDingtoneID(), null)) ||
      pickStringFromRecords(snapshotRecords, ["dtDingtoneId", "dt_dingtone_id", "dingtoneId", "dingtone_id"]),
    fullName: cleanString(profile ? readField(profile, "fullName") : null) || cleanString(pointUserInfoData && pointUserInfoData.userName),
    gender: toNumber(profile ? readField(profile, "gender") : null),
    birthday: cleanString(profile ? readField(profile, "birthday") : null),
    email:
      cleanString(profile ? readField(profile, "email") : null) || cleanString(tryCall(() => appInfo.getActivatedEmail(), null)),
    phone:
      cleanString(profile ? readField(profile, "phone") : null) || cleanString(tryCall(() => appInfo.getMainWholePhoneNum(), null)),
    aboutMe: cleanString(profile ? readField(profile, "aboutme") : null),
    feeling: cleanString(profile ? readField(profile, "feeling") : null),
    company: cleanString(profile ? readField(profile, "company") : null),
    school: cleanString(profile ? readField(profile, "school") : null),
    country: cleanString(profile ? readField(profile, "address_country") : null),
    state: cleanString(profile ? readField(profile, "address_state") : null),
    city: cleanString(profile ? readField(profile, "address_city") : null),
    primaryBalance: primaryBalance,
    userGrade:
      directUserGrade ||
      pickNumberFromRecords(snapshotRecords, [
        "userGrade",
        "user_grade",
        "grade",
        "vipGrade",
        "vip_grade",
        "memberGrade",
        "member_grade",
        "pointGradeLevel",
        "point_grade_level"
      ]) ||
      pointGradeLevel ||
      pointGrade,
    validPoint:
      toNumber(pointUserInfoData && pointUserInfoData.validPoint) ||
      toNumber(pointGradeInfoData && pointGradeInfoData.validPoint) ||
      pickNumberFromRecords(snapshotRecords, [
        "validPoint",
        "valid_point",
        "usablePoint",
        "usable_point",
        "availablePoint",
        "available_point",
        "tokenNumber",
        "token_number"
      ]) || toNumber(tryCall(() => (pointManager ? pointManager.getValidPoint() : null), null)),
    progressPoint:
      toNumber(pointUserInfoData && pointUserInfoData.historyPoint) ||
      pickNumberFromRecords(snapshotRecords, [
        "progressPoint",
        "progress_point",
        "currentPoint",
        "current_point",
        "levelPoint",
        "level_point",
        "totalPoint",
        "total_point",
        "historyPoint",
        "history_point"
      ]) || null,
    progressPointTotal: progressPointTotal,
    membershipType: pickStringFromRecords(snapshotRecords, ["membershipType", "membership_type", "premiumType", "premium_type", "memberType", "member_type", "walletType", "wallet_type"]),
    membershipLevelLabel:
      pickStringFromRecords(snapshotRecords, ["membershipLevelLabel", "membership_level_label", "levelName", "level_name", "vipLevelName", "vip_level_name", "gradeName", "grade_name"]) ||
      (pointGradeLevel !== null ? `V${pointGradeLevel}` : null),
    profileVerCode: cleanString(profile ? readField(profile, "profileVerCode") : null)
  };

  return {
    account: {
      dtUserId: cleanString(tryCall(() => appInfo.getUserID(), null)),
      dingtoneId: cleanString(tryCall(() => appInfo.getDingtoneID(), null)),
      token: cleanString(tryCall(() => tpClient.getLoginToken(), null)),
      activatedEmail: cleanString(tryCall(() => appInfo.getActivatedEmail(), null)),
      mainPhone: cleanString(tryCall(() => appInfo.getMainWholePhoneNum(), null))
    },
    balance: {
      balance: primaryBalance,
      giftBalance: toNumber(tryCall(() => appInfo.getGiftBalance(), null))
    },
    snapshot: snapshot,
    profile: profile ? serializeJavaObject(profile, 0) : null,
    point: {
      uid: pointUid,
      pointGrade: pointGrade,
      pointGradeLevel: pointGradeLevel,
      currentGrade: currentGrade,
      validPoint: snapshot.validPoint,
      progressPoint: snapshot.progressPoint,
      progressPointTotal: snapshot.progressPointTotal,
      gradeName: pickStringFromRecords(pointRecords, ["gradeName", "grade_name"]),
      privilege: pickStringFromRecords(pointRecords, ["privilege"]),
      membershipBenefits: mergedBenefitProducts,
      pointSummaryResponse: pointSummaryResponse,
      pointSummaryData: pointSummaryData,
      pointGradeInfoResponse: pointGradeInfoResponse,
      pointGradeInfoData: pointGradeInfoData,
      pointUserInfoResponse: pointUserInfoResponse,
      pointUserInfoData: pointUserInfoData,
      pointStoreResponse: pointStoreResponse,
      pointStoreData: pointStoreData,
      pointStoreProducts: pointStoreProducts,
      gameUid: cleanString(pointExtras.gameUid) || cleanString(gameHomePageData && gameHomePageData.uid),
      gameHomePageResponse: gameHomePageResponse,
      gameHomePageData: gameHomePageData,
      gamePointRedeemInfoResponse: gamePointRedeemInfoResponse,
      gamePointRedeemInfoData: gamePointRedeemInfoData,
      gamePointProducts: gamePointProducts,
      errors: pointExtras.errors || null,
      pointSystemOpen: toBoolean(tryCall(() => (pointManager ? pointManager.isPointSystemOpen() : null), null)),
      pointSystemActivated: toBoolean(tryCall(() => (pointManager ? pointManager.isPointSystemActivation() : null), null)),
      pointGradeInfo: pointGradeInfo ? serializeJavaObject(pointGradeInfo, 0) : null,
      walletInfo: walletInfo ? serializeJavaObject(walletInfo, 0) : null,
      walletInviteConfig: walletInviteConfig ? serializeJavaObject(walletInviteConfig, 0) : null,
      walletRateConfig: walletRateConfig ? serializeJavaObject(walletRateConfig, 0) : null
    }
  };
}

function buildPhoneNumberItem(item) {
  if (!item) {
    return null;
  }
  const expireTime = toNumber(readField(item, "expireTime"));
  const suspendFlag = toBoolean(readField(item, "suspendFlag"));
  const isExpire = toNumber(readField(item, "isExpire"));
  let status = "active";
  if (suspendFlag) {
    status = "paused";
  } else if (isExpire === 1 || (expireTime !== null && expireTime > 0 && expireTime * 1000 <= Date.now())) {
    status = "expired";
  }
  return {
    phoneNumber: cleanString(readField(item, "phoneNumber")),
    countryCode: toNumber(readField(item, "countryCode")),
    providerId: toNumber(readField(item, "providerId")),
    displayName: cleanString(readField(item, "displayName")),
    status: status,
    purchaseType: toNumber(readField(item, "purchaseType")),
    payType: toNumber(readField(item, "payType")),
    validPeriodDays: toNumber(readField(item, "usePeriod")),
    gainTime: cleanString(readField(item, "gainTime")),
    expireTime: cleanString(readField(item, "expireTime")),
    autoRenew: toBoolean(readField(item, "autoRenew")),
    isPrimary: toBoolean(readField(item, "primaryFlag")),
    isGoodNumber: toNumber(readField(item, "goodNumberLevel")) !== null ? toNumber(readField(item, "goodNumberLevel")) > 0 : null,
    portoutInfo: cleanString(readField(item, "portoutInfo")),
    rawJson: serializeJavaObject(item, 0)
  };
}

function getPhoneNumbersPayload() {
  const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
  const list = tryCall(() => PrivatePhoneNumberManager.getInstance().getListData(), null);
  return listToArray(list, 100)
    .map((item) => buildPhoneNumberItem(item))
    .filter((item) => item && item.phoneNumber);
}

function buildMessageSummary(message) {
  if (!message) {
    return null;
  }
  return {
    className: cleanString(tryCall(() => message.getClass().getName(), null)),
    msgId: cleanString(tryCall(() => message.getMsgId(), null)),
    msgType: toNumber(tryCall(() => message.getMsgType(), null)),
    senderId: cleanString(tryCall(() => message.getSenderId(), null)),
    conversationId: cleanString(tryCall(() => message.getConversationId(), null)),
    conversationUserId: cleanString(tryCall(() => message.getConversationUserId(), null)),
    content: cleanString(tryCall(() => message.getContent(), null)),
    timeStamp: toNumber(tryCall(() => message.getTimeStamp(), null)),
    isRead: toNumber(tryCall(() => message.getIsRead(), null)),
    rawJson: serializeJavaObject(message, 0)
  };
}

function getSmsConversationsPayload() {
  const ConversationMgr = Java.use("me.dingtone.app.im.conversation.ConversationMgr");
  const list = tryCall(() => ConversationMgr.getInstance().getConversationListData(), null);
  return listToArray(list, 200)
    .filter((item) => toNumber(tryCall(() => item.getConversationType(), null)) === 3)
    .map((item) => ({
      conversationId: cleanString(tryCall(() => item.getConversationId(), null)),
      conversationUserId: cleanString(tryCall(() => item.getConversationUserId(), null)),
      privatePhoneNumber: cleanString(tryCall(() => item.getPrivatePhoneNumber(), null)),
      targetPhoneNumbers: listToArray(tryCall(() => item.getTargetPhoneNumberList(), null), 20).map((value) => cleanString(value)).filter(Boolean),
      totalGeneratedMessageCount: toNumber(tryCall(() => item.getTotalMessageCountGenerated(), null)),
      dtMessage: buildMessageSummary(tryCall(() => item.getDtMessage(), null)),
      inboundSMS: buildMessageSummary(tryCall(() => item.getInboundSMS(), null)),
      sensitiveSMS: buildMessageSummary(tryCall(() => item.getSensitiveSMS(), null))
    }));
}

function dumpSmsMessagesFromDatabase(limit) {
  const DatabaseManager = Java.use("me.dingtone.app.im.database.DatabaseManager");
  const cursor = DatabaseManager.getInstance().getSqliteDB().rawQuery(
    "select _id,conversationId,conversationUserId,type,senderId,msgId,content,timestamp,time,isRead,data1,data2,data3 from dt_message where conversationType = 3 order by _id desc limit " +
      Math.max(1, Math.min(100, limit || 20)),
    null
  );
  const rows = [];
  try {
    while (cursor.moveToNext()) {
      rows.push({
        id: toNumber(cursor.getString(0)),
        conversationId: cleanString(cursor.getString(1)),
        conversationUserId: cleanString(cursor.getString(2)),
        type: toNumber(cursor.getString(3)),
        senderId: cleanString(cursor.getString(4)),
        msgId: cleanString(cursor.getString(5)),
        content: cleanString(cursor.getString(6)),
        timestamp: toNumber(cursor.getString(7)),
        time: toNumber(cursor.getString(8)),
        isRead: toNumber(cursor.getString(9)),
        data1: cleanString(cursor.getString(10)),
        data2: cleanString(cursor.getString(11)),
        data3: cleanString(cursor.getString(12))
      });
    }
  } finally {
    cursor.close();
  }
  return rows;
}

function buildHelperSmsMessageRecordFromSummary(summary) {
  if (!summary) {
    return null;
  }
  const msgId = cleanString(summary.msgId);
  const content = cleanString(summary.content);
  const conversationId = cleanString(summary.conversationId);
  const senderId = cleanString(summary.senderId);
  if (!msgId && !content && !conversationId) {
    return null;
  }
  return {
    id: null,
    conversationId: conversationId,
    conversationUserId: cleanString(summary.conversationUserId),
    type: toNumber(summary.msgType),
    senderId: senderId,
    msgId: msgId,
    content: content,
    timestamp: toNumber(summary.timeStamp),
    time: toNumber(summary.timeStamp),
    isRead: toNumber(summary.isRead),
    data1: senderId,
    data2: null,
    data3: null
  };
}

function buildLoginResult(meta) {
  const DtAppInfo = Java.use("me.dingtone.app.im.manager.DtAppInfo");
  const DTSystemContext = Java.use("me.dingtone.app.im.util.DTSystemContext");
  const TpClient = Java.use("me.dingtone.app.im.tp.TpClient");
  const appInfo = DtAppInfo.getInstance();
  const tpClient = TpClient.getInstance();
  const dtUserId = cleanString(tryCall(() => appInfo.getUserID(), null));
  const token = cleanString(tryCall(() => tpClient.getLoginToken(), null));
  const deviceId = cleanString(tryCall(() => tpClient.getDeviceId(), null));
  const systemDeviceId = cleanString(tryCall(() => DTSystemContext.getDeviceId(), null));
  if (!dtUserId || !token) {
    throw {
      message: "Native login finished but userId/token is still empty",
      statusCode: 502,
      code: 502
    };
  }
  return {
    dtUserId: dtUserId,
    token: token,
    deviceId: deviceId || systemDeviceId,
    dingtoneId: cleanString(tryCall(() => appInfo.getDingtoneID(), null)),
    deviceIdCandidates: [deviceId, systemDeviceId].filter((value, index, list) => value && list.indexOf(value) === index),
    activatedEmail: cleanString(tryCall(() => appInfo.getActivatedEmail(), null)),
    mainPhone: cleanString(tryCall(() => appInfo.getMainWholePhoneNum(), null)),
    serverIp: meta && meta.serverIp ? meta.serverIp : null,
    serverPort: meta && meta.serverPort ? meta.serverPort : null
  };
}

async function handleExportSession() {
  sendLog("info", "export_session started");
  return runOnMainThread(() => {
    const result = buildLoginResult({});
    result.packageName = getCurrentAndroidPackageName();
    result.appVariant = inferAppVariantFromPackageName(result.packageName);
    result.snapshot = buildSnapshotPayload();
    result.phoneNumbers = getPhoneNumbersPayload();
    sendLog("info", "export_session finished", {
      dtUserId: result && result.dtUserId ? result.dtUserId : null,
      packageName: result && result.packageName ? result.packageName : null,
      appVariant: result && result.appVariant ? result.appVariant : null,
      hasToken: !!(result && result.token),
      deviceId: result && result.deviceId ? result.deviceId : null,
      phoneCount: Array.isArray(result.phoneNumbers) ? result.phoneNumbers.length : 0
    });
    return result;
  });
}

function prepareActivationContext() {
  const ActivationManager = Java.use("me.dingtone.app.im.manager.ActivationManager");
  const DTApplication = Java.use("me.dingtone.app.im.manager.DTApplication");
  const manager = ActivationManager.getInstance();
  try {
    manager.setActivity(DTApplication.getInstance().getCurrentActivity());
  } catch (_error) {
    // 当应用已经在前台时，即使没有 Activity，这个请求也仍然可以继续。
  }
  return manager;
}

async function performNativeLogin(meta, timeoutMs) {
  const loginResponsePromise = waitForEvent("login_response", timeoutMs, () => true);
  const loginSuccessPromise = waitForEvent("login_success", timeoutMs, () => true);
  await runOnMainThread(() => {
    const AppConnectionManager = Java.use("me.dingtone.app.im.manager.AppConnectionManager");
    const SharedPreferenceUtilVariousStatus = Java.use("me.dingtone.app.im.util.SharedPreferenceUtilVariousStatus");
    const ToolsForVariousStatus = Java.use("me.dingtone.app.im.util.ToolsForVariousStatus");
    const DTSystemContext = Java.use("me.dingtone.app.im.util.DTSystemContext");
    const DTLoginCmd = Java.use("me.tzim.app.im.datatype.DTLoginCmd");
    const TpClient = Java.use("me.dingtone.app.im.tp.TpClient");

    const appConnectionManager = AppConnectionManager.getInstance();
    appConnectionManager.appLogining();

    const loginCmd = DTLoginCmd.$new(2, "", 30.279305, 120.12606);
    if (SharedPreferenceUtilVariousStatus.getShareOnlineStatus()) {
      loginCmd.presenceStatus.value = 2;
      loginCmd.presenceMessage.value = ToolsForVariousStatus.getShareOnlineStatusJasonMessage(true);
    } else {
      loginCmd.presenceStatus.value = 6;
      loginCmd.presenceMessage.value = ToolsForVariousStatus.getShareOnlineStatusJasonMessage(false);
    }
    loginCmd.androidId.value = DTSystemContext.getAndroidId();
    loginCmd.macAddress.value = DTSystemContext.getWifiMacAddress();
    loginCmd.IMEI.value = DTSystemContext.getDeviceId();
    loginCmd.clientInfo.value = DTSystemContext.getLoginClientInfo();
    TpClient.getInstance().login(loginCmd);
  });

  const loginResponse = await loginResponsePromise;
  if (loginResponse.errCode !== 0) {
    throw {
      message: loginResponse.reason || `Native login failed with errCode=${loginResponse.errCode}`,
      statusCode: 400,
      code: loginResponse.errCode || 400
    };
  }
  await loginSuccessPromise;
  return runInJava(() => buildLoginResult(meta));
}

async function handleSendVerificationCode(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload)) || {};
  const email = cleanString(input.email);
  if (!email) {
    throw {
      message: "email is required for send_verification_code",
      statusCode: 400,
      code: 400
    };
  }
  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const responsePromise = waitForEvent("register_email", timeoutMs, () => true);
  await runOnMainThread(() => {
    prepareActivationContext().registerEmail(email, true);
  });
  const response = await responsePromise;
  if (response.errCode !== 0) {
    throw {
      message: response.reason || `registerEmail failed with errCode=${response.errCode}`,
      statusCode: 400,
      code: response.errCode || 400
    };
  }
  return {
    message: response.returnedAccessCode !== undefined
      ? `Verification code request accepted for ${email}`
      : `Verification email sent to ${email}`,
    verificationCode:
      response.returnedAccessCode !== undefined ? String(response.returnedAccessCode) : response.confirmCode || null,
    response: response
  };
}

async function handleLogin(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload)) || {};
  const timeoutMs = Math.max(15_000, toNumber(request.meta && request.meta.timeoutMs) || 90_000);
  const loginType = cleanString(input.loginType);
  if (!loginType) {
    throw {
      message: "loginType is required",
      statusCode: 400,
      code: 400
    };
  }

  if (loginType === "email_code") {
    const email = cleanString(input.email);
    const code = parseInt(cleanString(input.verificationCode), 10);
    if (!email || !Number.isFinite(code)) {
      throw {
        message: "email and numeric verificationCode are required for email_code login",
        statusCode: 400,
        code: 400
      };
    }
    const responsePromise = waitForEvent("activate_email", timeoutMs, () => true);
    await runOnMainThread(() => {
      prepareActivationContext().activateEmail(email, code);
    });
    const activation = await responsePromise;
    if (activation.errCode !== 0) {
      throw {
        message: activation.reason || `activateEmail failed with errCode=${activation.errCode}`,
        statusCode: 400,
        code: activation.errCode || 400
      };
    }
  } else if (loginType === "email_password" || loginType === "phone_password") {
    const password = cleanString(input.password);
    if (!password) {
      throw {
        message: "password is required for password login",
        statusCode: 400,
        code: 400
      };
    }
    const responsePromise = waitForEvent("activate_password", timeoutMs, () => true);
    await runOnMainThread(() => {
      prepareActivationContext().activatePassword(password, loginType === "phone_password" ? 1 : 0);
    });
    const activation = await responsePromise;
    if (activation.errCode !== 0) {
      throw {
        message: activation.reason || `activatePassword failed with errCode=${activation.errCode}`,
        statusCode: 400,
        code: activation.errCode || 400
      };
    }
  } else {
    throw {
      message: `Unsupported loginType: ${loginType}`,
      statusCode: 400,
      code: 400
    };
  }

  return performNativeLogin(request.meta || {}, timeoutMs);
}

async function handleRefreshSnapshot(request) {
  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const pointExtrasPromise = Promise.race([
    fetchPointExtras(Math.min(timeoutMs, 8_000)).catch((error) => ({
      errors: {
        helper: toBridgeError(error)
      }
    })),
    delay(4_000).then(() => ({
      errors: {
        helper: {
          message: "Point extras timed out and were skipped",
          statusCode: 504,
          code: 504
        }
      }
    }))
  ]);
  const responsePromise = Promise.race([
    waitForEvent("balance_updated", Math.min(timeoutMs, 6_000), () => true).catch(() => null),
    delay(2_000).then(() => null)
  ]);
  await runOnMainThread(() => {
    const TpClient = Java.use("me.dingtone.app.im.tp.TpClient");
    const PointManager = tryCall(() => Java.use("me.dingtone.app.im.mvp.modules.point.manager.PointManager"), null);
    if (PointManager) {
      tryCall(() => PointManager.getInstance().requestPointSummary(), null);
    }
    TpClient.getInstance().getMyBalance();
  });
  await responsePromise;
  const pointExtras = await pointExtrasPromise;
  return runInJava(() => buildSnapshotPayload(pointExtras));
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function handleListPhoneNumbers(request) {
  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const responsePromise = waitForEvent("phone_list_updated", timeoutMs, () => true);
  await runOnMainThread(() => {
    const TpClient = Java.use("me.dingtone.app.im.tp.TpClient");
    const DTGetPrivateNumberListCmd = Java.use("me.dingtone.app.im.datatype.DTGetPrivateNumberListCmd");
    TpClient.getInstance().GetPrivateNumberList(DTGetPrivateNumberListCmd.$new());
  });
  await responsePromise;
  return runInJava(() => getPhoneNumbersPayload());
}

async function handleDumpSmsConversations() {
  return runInJava(() => getSmsConversationsPayload());
}

async function handleDumpSmsMessages(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload)) || {};
  const limit = toNumber(input.limit) || 20;
  return runInJava(() => {
    const databaseRows = dumpSmsMessagesFromDatabase(Math.max(limit * 3, 30));
    const conversationRows = [];
    getSmsConversationsPayload().forEach((conversation) => {
      [
        buildHelperSmsMessageRecordFromSummary(conversation && conversation.dtMessage),
        buildHelperSmsMessageRecordFromSummary(conversation && conversation.inboundSMS),
        buildHelperSmsMessageRecordFromSummary(conversation && conversation.sensitiveSMS)
      ]
        .filter(Boolean)
        .forEach((row) => {
          conversationRows.push(row);
        });
    });

    const merged = [];
    const seen = {};
    databaseRows.concat(conversationRows).forEach((row) => {
      if (!row) {
        return;
      }
      const key =
        cleanString(row.msgId) ||
        [
          cleanString(row.conversationId),
          cleanString(row.senderId),
          cleanString(row.content),
          toNumber(row.time) || toNumber(row.timestamp) || 0
        ].join("|");
      if (!key || seen[key]) {
        return;
      }
      seen[key] = true;
      merged.push(row);
    });

    merged.sort((left, right) => {
      const leftTime = toNumber(left.time) || toNumber(left.timestamp) || 0;
      const rightTime = toNumber(right.time) || toNumber(right.timestamp) || 0;
      return rightTime - leftTime;
    });
    return merged.slice(0, Math.max(1, Math.min(100, limit)));
  });
}

async function handleDescribeClassMethods(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload)) || {};
  const className = cleanString(input.className || input.class_name);
  if (!className) {
    throw {
      message: "className is required for describe_class_methods",
      statusCode: 400,
      code: 400
    };
  }
  return runInJava(() => {
    const Target = Java.use(className);
    const methods = Target.class.getDeclaredMethods();
    const result = [];
    for (let index = 0; index < methods.length; index += 1) {
      result.push(String(methods[index].toString()));
    }
    return {
      className,
      methods: result.sort()
    };
  });
}

async function handleInspectAdBuyActivity() {
  return captureAdBuyActivityState();
}

async function handleDumpActivities() {
  return runInJava(() => {
    const ActivityThread = tryCall(() => Java.use("android.app.ActivityThread"), null);
    const activityThread = tryCall(() => (ActivityThread ? ActivityThread.currentActivityThread() : null), null);
    const activities = tryCall(() => (activityThread ? activityThread.mActivities.value : null), null);
    const records = tryCall(() => (activities ? activities.values().toArray() : []), []);
    const result = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const activity = readField(record, "activity");
      result.push({
        paused: toBoolean(readField(record, "paused")),
        stopped: toBoolean(readField(record, "stopped")),
        activity: cleanString(tryCall(() => (activity ? activity.getClass().getName() : null), null)),
        recordClass: cleanString(tryCall(() => record.getClass().getName(), null))
      });
    }
    return result;
  });
}

async function handleRequestPhoneNumber(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload)) || {};
  const countryCode = toNumber(input.countryCode) || 1;
  const requestConfig = resolvePrivatePhoneRequestConfig(countryCode);
  const dynamicApplyType = await resolveApplyPhoneTypeFromApp(countryCode);
  if (Number.isFinite(dynamicApplyType)) {
    requestConfig.applyType = dynamicApplyType;
  }
  const applyTypeValue = requestConfig.applyType;
  if (!Number.isFinite(applyTypeValue)) {
    throw {
      message: `Unable to resolve phone apply type for countryCode=${countryCode}`,
      statusCode: 400,
      code: 400
    };
  }
  sendLog("info", "Requesting private phone list", {
    countryCode: countryCode,
    applyType: applyTypeValue
  });
  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const responsePromise = waitForEvent("request_private_number", timeoutMs, () => true);
  await runOnMainThread(() => {
    const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
    const areaCode = toNumber(input.areaCode) || 0;
    const npanxx = cleanString(input.npanxx || input.areaCodeText || input.area_code_text) || "";
    const isoCountryCode = cleanString(input.isoCountryCode || input.iso_country_code) || requestConfig.isoCountryCode;

    if (countryCode === 1 && isoCountryCode) {
      PrivatePhoneNumberManager.getInstance().requirePrivatePhoneNumber(1, isoCountryCode, areaCode, npanxx, null, null, null, true);
      return;
    }

    PrivatePhoneNumberManager.getInstance().requestPrivatePhoneListByType(applyTypeValue);
  });
  const response = await responsePromise;
  sendLog("info", "Received private phone request response", {
    countryCode: countryCode,
    applyType: applyTypeValue,
    phoneCount: Array.isArray(response && response.phones) ? response.phones.length : null,
    errCode: response && response.errCode
  });
  if (response.errCode !== 0) {
    throw {
      message: response.reason || `requestPrivateNumber failed with errCode=${response.errCode}`,
      statusCode: 400,
      code: response.errCode || 400
    };
  }
  return response;
}

async function handlePurchasePhoneNumber(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload)) || {};
  const candidateInput = (input.candidate && typeof input.candidate === "object" ? input.candidate : input) || {};
  const phoneNumber = cleanString(candidateInput.phoneNumber || candidateInput.phone_number || input.phoneNumber || input.phone_number);
  if (!phoneNumber) {
    throw {
      message: "candidate.phoneNumber is required for purchase_phone_number",
      statusCode: 400,
      code: 400
    };
  }

  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const expectedPhoneNumber = phoneNumber;
  const countryCode = toNumber(candidateInput.countryCode || candidateInput.country_code || input.countryCode || input.country_code) || 1;
  const orderPhoneNumber = normalizePhoneDigits(expectedPhoneNumber);
  const responsePromise = waitForEvent(
    "order_private_number",
    timeoutMs,
    (payload) => {
      const responsePhone = cleanString(payload && payload.phoneNumber);
      const ownedPhone = cleanString(payload && payload.orderPayload && payload.orderPayload.phoneNumber);
      return !responsePhone || isSamePhoneNumber(responsePhone, expectedPhoneNumber) || isSamePhoneNumber(ownedPhone, expectedPhoneNumber);
    }
  ).catch((error) => ({ __timeout: true, error: error }));

  await runOnMainThread(() => {
    const PrivatePhoneInfoCanApply = Java.use("me.tzim.app.im.datatype.PrivatePhoneInfoCanApply");
    const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
    const candidate = PrivatePhoneInfoCanApply.$new();

    writeField(candidate, "phoneNumber", orderPhoneNumber || expectedPhoneNumber);
    writeField(candidate, "countryCode", countryCode);
    writeField(candidate, "areaCode", toNumber(candidateInput.areaCode || candidateInput.area_code) || 0);
    writeField(candidate, "providerId", toNumber(candidateInput.providerId || candidateInput.provider_id) || 2000);
    writeField(candidate, "packageServiceId", cleanString(candidateInput.packageServiceId || candidateInput.package_service_id) || "");
    writeField(candidate, "category", toNumber(candidateInput.category || candidateInput.purchaseType || candidateInput.purchase_type) || 0);
    writeField(candidate, "phoneType", toNumber(candidateInput.phoneType || candidateInput.phone_type || candidateInput.payType || candidateInput.pay_type) || 2);
    writeField(candidate, "cityName", cleanString(candidateInput.cityName || candidateInput.city_name) || "");
    writeField(candidate, "stateName", cleanString(candidateInput.stateName || candidateInput.state_name) || "");
    writeField(candidate, "isoCountryCode", cleanString(candidateInput.isoCountryCode || candidateInput.iso_country_code || candidateInput.isoCC || candidateInput.iso_cc) || "");
    writeField(candidate, "goodNumberLevel", toNumber(candidateInput.goodNumberLevel || candidateInput.good_number_level) || 0);
    writeField(candidate, "useHistory", toNumber(candidateInput.useHistory || candidateInput.use_history) || 0);
    writeField(candidate, "userNumberIndex", toNumber(candidateInput.userNumberIndex || candidateInput.user_number_index) || 0);

    const orderPrice = Math.max(
      1,
      Math.ceil(
        toNumber(
          candidateInput.price ||
            candidateInput.orderPrice ||
            candidateInput.order_price ||
            candidateInput.cost ||
            candidateInput.amount
        ) || 1
      )
    );
    PrivatePhoneNumberManager.getInstance().orderPrivateNumberByCredit(candidate, orderPrice);
  });

  const ownedItem = await Promise.race([
    waitForOwnedPhoneItem(expectedPhoneNumber, timeoutMs),
    responsePromise.then(() => delay(1_000).then(() => runInJava(() => findOwnedPhoneItem(expectedPhoneNumber))))
  ]).catch(() => null);
  const response = await responsePromise;
  const ownedPayload = await runInJava(() => buildOwnedPhonePayload(ownedItem || findOwnedPhoneItem(expectedPhoneNumber)));
  if (response && response.__timeout && ownedPayload) {
    sendLog("info", "purchase_phone_number confirmed from owned phone list after order callback timeout", {
      phoneNumber: ownedPayload.phoneNumber || expectedPhoneNumber
    });
    return {
      errCode: 0,
      result: 1,
      reason: null,
      phoneNumber: ownedPayload.phoneNumber || expectedPhoneNumber,
      orderPayload: ownedPayload,
      source: "owned_phone_list_after_order_timeout"
    };
  }
  if (response && response.__timeout) {
    throw response.error;
  }
  if (response.errCode !== 0) {
    throw {
      message: response.reason || `orderPrivateNumber failed with errCode=${response.errCode}`,
      statusCode: 400,
      code: response.errCode || 400
    };
  }

  if (ownedPayload) {
    sendLog("info", "purchase_phone_number confirmed from order callback and owned phone list", {
      phoneNumber: ownedPayload.phoneNumber || expectedPhoneNumber
    });
  }
  return {
    ...response,
    phoneNumber: cleanString(response.phoneNumber) || (ownedPayload && ownedPayload.phoneNumber) || expectedPhoneNumber,
    orderPayload: ownedPayload || response.orderPayload || null
  };
}

async function handleRenewPhoneNumber(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload || request.payload)) || {};
  const phoneNumber = cleanString(input.phoneNumber || input.phone_number);
  if (!phoneNumber) {
    throw {
      message: "phoneNumber is required for renew_phone_number",
      statusCode: 400,
      code: 400
    };
  }
  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const responsePromise = waitForEvent("order_private_number", timeoutMs, () => true);
  await ensureOwnedPhoneItem(phoneNumber, timeoutMs);
  await runOnMainThread(() => {
    const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
    const freshItem = PrivatePhoneNumberManager.getInstance().getPrivateItemByPrivateNumber(phoneNumber);
    if (!freshItem) {
      throw {
        message: `Phone number not found while renewing: ${phoneNumber}`,
        statusCode: 404,
        code: 404
      };
    }
    PrivatePhoneNumberManager.getInstance().orderPrivatePhoneExtendMonths(freshItem, 12, freshItem.getOrderPrice(), 0, 2);
  });
  const response = await responsePromise;
  if (response.errCode !== 0) {
    throw {
      message: response.reason || `orderPrivateNumber failed with errCode=${response.errCode}`,
      statusCode: 400,
      code: response.errCode || 400
    };
  }
  return response;
}

async function handleRequestPhoneNumberViaActivity(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload)) || {};
  const countryCode = toNumber(input.countryCode) || 1;
  const timeoutMs = Math.max(15_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const isoCountryCode = resolveIsoCountryCode(countryCode);
  const requestConfig = resolvePrivatePhoneRequestConfig(countryCode);
  const dynamicApplyType = await resolveApplyPhoneTypeFromApp(countryCode);
  if (Number.isFinite(dynamicApplyType)) {
    requestConfig.applyType = dynamicApplyType;
  }
  let eventResult = null;
  const eventPromise = waitForEvent(
    "request_private_number",
    timeoutMs,
    (payload) => Array.isArray(payload && payload.phones) || (payload && payload.errCode !== undefined)
  )
    .then((payload) => {
      eventResult = payload;
      return payload;
    })
    .catch(() => null);
  sendLog("info", "Requesting phone number via activity fallback", {
    countryCode: countryCode,
    isoCountryCode: isoCountryCode
  });
  await runOnMainThread(() => {
    const DTApplication = Java.use("me.dingtone.app.im.manager.DTApplication");
    const Intent = Java.use("android.content.Intent");
    const PrivatePhoneSearchActivity = Java.use("me.dingtone.app.im.activity.PrivatePhoneSearchActivity");
    const AdBuyPhoneNumberChooseActivity = Java.use("me.dingtone.app.im.phonenumberadbuy.choose.AdBuyPhoneNumberChooseActivity");
    const app = DTApplication.getInstance();
    const currentActivity = getForegroundActivity();
    const currentActivityName = cleanString(tryCall(() => (currentActivity ? currentActivity.getClass().getName() : null), null));
    sendLog("info", "Activity fallback launch context", {
      currentActivity: currentActivityName,
      hasCurrentActivity: !!currentActivity
    });

    if (currentActivity) {
      if (countryCode === 1 && isoCountryCode) {
        AdBuyPhoneNumberChooseActivity.start(currentActivity, isoCountryCode);
        return;
      }
      if (Number.isFinite(requestConfig.applyType)) {
        PrivatePhoneSearchActivity.start(currentActivity, requestConfig.applyType);
        return;
      }
      AdBuyPhoneNumberChooseActivity.start(currentActivity, isoCountryCode);
      return;
    }

    if (Number.isFinite(requestConfig.applyType)) {
      const searchIntent = Intent.$new(app, PrivatePhoneSearchActivity.class);
      searchIntent.putExtra("applyPhoneType", requestConfig.applyType);
      searchIntent.addFlags(0x10000000);
      app.startActivity(searchIntent);
      return;
    }

    const intent = Intent.$new(app, AdBuyPhoneNumberChooseActivity.class);
    intent.putExtra("iso_cc", isoCountryCode);
    intent.addFlags(0x10000000);
    app.startActivity(intent);
  });

  const startedAt = Date.now();
  let lastActivityName = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (latestPrivateNumberEvent && Array.isArray(latestPrivateNumberEvent.phones) && latestPrivateNumberEvent.phones.length > 0) {
      sendLog("info", "Activity fallback used cached private number event", {
        count: latestPrivateNumberEvent.phones.length
      });
      return latestPrivateNumberEvent;
    }
    if (eventResult && Array.isArray(eventResult.phones) && eventResult.phones.length > 0) {
      sendLog("info", "Activity fallback consumed request_private_number event", {
        count: eventResult.phones.length
      });
      return eventResult;
    }
    const snapshot = await captureAdBuyActivityState();
    if (snapshot && snapshot.activity && snapshot.activity !== lastActivityName) {
      lastActivityName = snapshot.activity;
      sendLog("info", "Activity fallback state changed", {
        activity: snapshot.activity,
        count: snapshot.count
      });
    }
    if (Array.isArray(snapshot && snapshot.phones) && snapshot.phones.length > 0) {
      sendLog("info", "Activity fallback captured phone candidates", {
        count: snapshot.phones.length
      });
      return {
        errCode: 0,
        reason: null,
        result: 1,
        freeChance: null,
        phones: snapshot.phones,
        source: "activity"
      };
    }
    await delay(1_000);
  }

  const payload = await eventPromise;
  if (payload && Array.isArray(payload.phones) && payload.phones.length > 0) {
    return payload;
  }

  throw {
    message: `Timed out waiting for activity-backed phone candidates for countryCode=${countryCode}`,
    statusCode: 504,
    code: 504
  };
}

function resolveIsoCountryCode(countryCode) {
  const mapping = {
    1: "US",
    7: "RU",
    31: "NL",
    32: "BE",
    33: "FR",
    34: "ES",
    40: "RO",
    43: "AT",
    44: "GB",
    45: "DK",
    46: "SE",
    48: "PL",
    60: "MY",
    61: "AU",
    62: "ID",
    65: "SG",
    81: "JP",
    82: "KR",
    86: "CN",
    230: "MU",
    420: "CZ",
    852: "HK",
    1787: "PR",
    886: "TW"
  };
  return mapping[countryCode] || "US";
}

function resolvePrivatePhoneRequestConfig(countryCode) {
  const mapping = {
    1: { applyType: 1, countryCode: 1, isoCountryCode: "US", providerIdList: ["2000", "2001"] },
    7: { applyType: 6, countryCode: 7, isoCountryCode: "RU", providerIdList: ["2003"] },
    31: { applyType: 9, countryCode: 31, isoCountryCode: "NL", providerIdList: ["2006"] },
    32: { applyType: 5, countryCode: 32, isoCountryCode: "BE", providerIdList: ["2002"] },
    33: { applyType: 15, countryCode: 33, isoCountryCode: "FR", providerIdList: ["2100"] },
    34: { applyType: 7, countryCode: 34, isoCountryCode: "ES", providerIdList: ["2004"] },
    40: { applyType: 24, countryCode: 40, isoCountryCode: "RO", providerIdList: ["2300"] },
    43: { applyType: 14, countryCode: 43, isoCountryCode: "AT", providerIdList: ["2100"] },
    44: { applyType: 3, countryCode: 44, isoCountryCode: "GB", providerIdList: ["2001", "2007"] },
    45: { applyType: 23, countryCode: 45, isoCountryCode: "DK", providerIdList: ["2300"] },
    46: { applyType: 16, countryCode: 46, isoCountryCode: "SE", providerIdList: ["2100"] },
    48: { applyType: 18, countryCode: 48, isoCountryCode: "PL", providerIdList: ["2300"] },
    60: { applyType: 22, countryCode: 60, isoCountryCode: "MY", providerIdList: ["2300"] },
    61: { applyType: 13, countryCode: 61, isoCountryCode: "AU", providerIdList: ["2008"] },
    62: { applyType: 19, countryCode: 62, isoCountryCode: "ID", providerIdList: ["2300"] },
    65: { applyType: 28, countryCode: 65, isoCountryCode: "SG", providerIdList: ["2100"] },
    81: { applyType: 27, countryCode: 81, isoCountryCode: "JP", providerIdList: ["2100"] },
    82: { applyType: 31, countryCode: 82, isoCountryCode: "KR", providerIdList: ["2100"] },
    86: { applyType: 11, countryCode: 86, isoCountryCode: "CN", providerIdList: ["2030"] },
    230: { applyType: 17, countryCode: 230, isoCountryCode: "MU", providerIdList: ["2100"] },
    420: { applyType: 21, countryCode: 420, isoCountryCode: "CZ", providerIdList: ["2300"] },
    852: { applyType: 29, countryCode: 852, isoCountryCode: "HK", providerIdList: ["2100"] },
    1787: { applyType: 20, countryCode: 1787, isoCountryCode: "PR", providerIdList: ["2300"] },
    886: { applyType: 30, countryCode: 886, isoCountryCode: "TW", providerIdList: ["2100"] }
  };
  return mapping[countryCode] || { applyType: 1, countryCode: countryCode, isoCountryCode: "", providerIdList: ["2000", "2001"] };
}

async function resolveApplyPhoneTypeFromApp(countryCode) {
  return await runOnMainThread(() => {
    const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
    return toNumber(PrivatePhoneNumberManager.getInstance().getApplyPhoneTypeByCountryCode(countryCode));
  }).catch(() => null);
}

async function handleUpdatePhoneNumberLabel(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload || request.payload)) || {};
  const phoneNumber = cleanString(input.phoneNumber || input.phone_number);
  const displayName = cleanString(input.displayName || input.display_name);
  if (!phoneNumber) {
    throw {
      message: "phoneNumber is required for update_phone_number_label",
      statusCode: 400,
      code: 400
    };
  }
  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const responsePromise = waitForEvent("private_number_setting", timeoutMs, () => true).catch(() => null);
  const existingItem = await ensureOwnedPhoneItem(phoneNumber, timeoutMs);
  if (!existingItem) {
    throw {
      message: `Phone number not found while updating label: ${phoneNumber}`,
      statusCode: 404,
      code: 404
    };
  }
  await runOnMainThread(() => {
    const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
    const item = PrivatePhoneNumberManager.getInstance().getPrivateItemByPrivateNumber(phoneNumber);
    if (!item) {
      throw {
        message: `Phone number not found while updating label: ${phoneNumber}`,
        statusCode: 404,
        code: 404
      };
    }
    const updated = cloneJavaObject(item);
    writeField(updated, "displayName", displayName || "");
    PrivatePhoneNumberManager.getInstance().privateNumberSetting(updated);
  });
  await Promise.race([responsePromise, delay(1_500)]);
  return await runInJava(() => buildOwnedPhonePayload(findOwnedPhoneItem(phoneNumber)) || { phoneNumber, displayName });
}

async function handlePausePhoneNumber(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload || request.payload)) || {};
  const phoneNumber = cleanString(input.phoneNumber || input.phone_number);
  if (!phoneNumber) {
    throw {
      message: "phoneNumber is required for pause_phone_number",
      statusCode: 400,
      code: 400
    };
  }
  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const responsePromise = waitForEvent("private_number_setting", timeoutMs, () => true).catch(() => null);
  const existingItem = await ensureOwnedPhoneItem(phoneNumber, timeoutMs);
  if (!existingItem) {
    throw {
      message: `Phone number not found while pausing: ${phoneNumber}`,
      statusCode: 404,
      code: 404
    };
  }
  await runOnMainThread(() => {
    const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
    const item = PrivatePhoneNumberManager.getInstance().getPrivateItemByPrivateNumber(phoneNumber);
    if (!item) {
      throw {
        message: `Phone number not found while pausing: ${phoneNumber}`,
        statusCode: 404,
        code: 404
      };
    }
    const updated = cloneJavaObject(item);
    writeField(updated, "suspendFlag", true);
    PrivatePhoneNumberManager.getInstance().privateNumberSetting(updated);
  });
  await Promise.race([responsePromise, delay(1_500)]);
  return await runInJava(() => buildOwnedPhonePayload(findOwnedPhoneItem(phoneNumber)) || { phoneNumber: phoneNumber, status: "paused" });
}

async function handleResumePhoneNumber(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload || request.payload)) || {};
  const phoneNumber = cleanString(input.phoneNumber || input.phone_number);
  if (!phoneNumber) {
    throw {
      message: "phoneNumber is required for resume_phone_number",
      statusCode: 400,
      code: 400
    };
  }
  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const responsePromise = waitForEvent("private_number_setting", timeoutMs, () => true).catch(() => null);
  const existingItem = await ensureOwnedPhoneItem(phoneNumber, timeoutMs);
  if (!existingItem) {
    throw {
      message: `Phone number not found while resuming: ${phoneNumber}`,
      statusCode: 404,
      code: 404
    };
  }
  await runOnMainThread(() => {
    const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
    const item = PrivatePhoneNumberManager.getInstance().getPrivateItemByPrivateNumber(phoneNumber);
    if (!item) {
      throw {
        message: `Phone number not found while resuming: ${phoneNumber}`,
        statusCode: 404,
        code: 404
      };
    }
    const updated = cloneJavaObject(item);
    writeField(updated, "suspendFlag", false);
    PrivatePhoneNumberManager.getInstance().privateNumberSetting(updated);
  });
  await Promise.race([responsePromise, delay(1_500)]);
  return await runInJava(() => buildOwnedPhonePayload(findOwnedPhoneItem(phoneNumber)) || { phoneNumber: phoneNumber, status: "active" });
}

async function handleCancelPhoneNumber(request) {
  const input = (request.payload && (request.payload.input || request.payload.payload || request.payload)) || {};
  const phoneNumber = cleanString(input.phoneNumber || input.phone_number);
  if (!phoneNumber) {
    throw {
      message: "phoneNumber is required for cancel_phone_number",
      statusCode: 400,
      code: 400
    };
  }
  const timeoutMs = Math.max(10_000, toNumber(request.meta && request.meta.timeoutMs) || 60_000);
  const responsePromise = waitForEvent("delete_private_number", timeoutMs, () => true);
  const existingItem = await ensureOwnedPhoneItem(phoneNumber, timeoutMs);
  if (!existingItem) {
    throw {
      message: `Phone number not found while cancelling: ${phoneNumber}`,
      statusCode: 404,
      code: 404
    };
  }
  await runOnMainThread(() => {
    const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");
    PrivatePhoneNumberManager.getInstance().deletePrivateNumberRestCall(phoneNumber, null);
  });
  const response = await responsePromise;
  if (response.errCode !== 0) {
    throw {
      message: response.reason || `deletePrivateNumber failed with errCode=${response.errCode}`,
      statusCode: 400,
      code: response.errCode || 400
    };
  }
  return { phoneNumber: phoneNumber, status: "cancelled" };
}

async function dispatch(request) {
  if (!hooksInstalled) {
    installHooks();
  }
  switch (request.action) {
    case "send_verification_code":
      return handleSendVerificationCode(request);
    case "login":
      return handleLogin(request);
    case "export_session":
      return handleExportSession(request);
    case "refresh_snapshot":
      return handleRefreshSnapshot(request);
    case "list_phone_numbers":
      return handleListPhoneNumbers(request);
    case "dump_sms_conversations":
      return handleDumpSmsConversations(request);
    case "dump_sms_messages":
      return handleDumpSmsMessages(request);
    case "describe_class_methods":
      return handleDescribeClassMethods(request);
    case "inspect_adbuy_activity":
      return handleInspectAdBuyActivity();
    case "dump_activities":
      return handleDumpActivities();
    case "request_phone_number":
      return handleRequestPhoneNumber(request);
    case "request_phone_number_via_activity":
      return handleRequestPhoneNumberViaActivity(request);
    case "purchase_phone_number":
      return handlePurchasePhoneNumber(request);
    case "renew_phone_number":
      return handleRenewPhoneNumber(request);
    case "update_phone_number_label":
      return handleUpdatePhoneNumberLabel(request);
    case "cancel_phone_number":
      return handleCancelPhoneNumber(request);
    case "pause_phone_number":
      return handlePausePhoneNumber(request);
    case "resume_phone_number":
      return handleResumePhoneNumber(request);
    default:
      throw {
        message: `Action ${request.action} is not implemented in the bundled helper yet`,
        statusCode: 501,
        code: 501
      };
  }
}

function installHooks() {
  Java.perform(() => {
    if (hooksInstalled) {
      return;
    }

    const ActivationManager = Java.use("me.dingtone.app.im.manager.ActivationManager");
    const LoginMgr = Java.use("me.dingtone.app.im.manager.LoginMgr");
    const ServiceMgr = Java.use("me.dingtone.app.im.manager.ServiceMgr");
    const TpEventHandler = Java.use("me.dingtone.app.im.tp.TpEventHandler");
    const PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");

    ActivationManager.onRegisterEmailResponse.implementation = function (resp) {
      const result = this.onRegisterEmailResponse(resp);
      emitEvent("register_email", extractRestResponse(resp));
      return result;
    };

    ActivationManager.onActivateEmail.implementation = function (resp) {
      const result = this.onActivateEmail(resp);
      emitEvent("activate_email", extractRestResponse(resp));
      return result;
    };

    ActivationManager.onActivatePassword.implementation = function (resp) {
      const result = this.onActivatePassword(resp);
      emitEvent("activate_password", extractRestResponse(resp));
      return result;
    };

    LoginMgr.OnLoginSuccess.overload("me.tzim.app.im.datatype.DTLoginResponse", "boolean").implementation = function (resp, forceUpdate) {
      const result = this.OnLoginSuccess(resp, forceUpdate);
      const payload = extractRestResponse(resp);
      payload.forceUpdate = !!forceUpdate;
      try {
        const loginResult = buildLoginResult({});
        payload.dtUserId = loginResult.dtUserId;
        payload.token = loginResult.token;
      } catch (_error) {
        // 登录 token 可能稍后才出现，但下面的处理器仍会继续发出成功事件。
      }
      emitEvent("login_success", payload);
      return result;
    };

    TpEventHandler.onLoginResponse.implementation = function (resp) {
      const result = this.onLoginResponse(resp);
      emitEvent("login_response", extractRestResponse(resp));
      return result;
    };

    TpEventHandler.onGetMyBalanceResponse.implementation = function (resp) {
      const result = this.onGetMyBalanceResponse(resp);
      const payload = extractRestResponse(resp);
      latestBalanceResponse = serializeJavaObject(resp, 0);
      payload.snapshot = buildSnapshotPayload();
      emitEvent("balance_updated", payload);
      return result;
    };

    TpEventHandler.onGetPrivateNumberListResponse.implementation = function (resp) {
      const result = this.onGetPrivateNumberListResponse(resp);
      const payload = extractRestResponse(resp);
      payload.phoneNumbers = getPhoneNumbersPayload();
      emitEvent("phone_list_updated", payload);
      return result;
    };

    TpEventHandler.onRequestPrivateNumberResponse.implementation = function (resp) {
      const result = this.onRequestPrivateNumberResponse(resp);
      const payload = extractRequestPrivateNumberResponse(resp);
      sendLog("info", "TpEventHandler.onRequestPrivateNumberResponse fired", {
        errCode: payload && payload.errCode,
        phoneCount: Array.isArray(payload && payload.phones) ? payload.phones.length : null
      });
      emitEvent("request_private_number", payload);
      return result;
    };

    ServiceMgr.handleResponse.implementation = function (type, obj) {
      if (type === 2048) {
        const payload = extractRequestPrivateNumberResponse(obj);
        sendLog("info", "ServiceMgr.handleResponse(2048) fired", {
          errCode: payload && payload.errCode,
          phoneCount: Array.isArray(payload && payload.phones) ? payload.phones.length : null
        });
        emitEvent("request_private_number", payload);
      }
      return this.handleResponse(type, obj);
    };

    TpEventHandler.onOrderPrivateNumberResponse.implementation = function (resp) {
      const result = this.onOrderPrivateNumberResponse(resp);
      const payload = extractRestResponse(resp);
      payload.phoneNumber = cleanString(tryCall(() => resp.getPhoneNumber(), null));
      payload.orderPayload = buildOwnedPhonePayload(findOwnedPhoneItem(payload.phoneNumber));
      emitEvent("order_private_number", payload);
      return result;
    };

    TpEventHandler.onPrivateNumberSettingResponse.implementation = function (resp) {
      const result = this.onPrivateNumberSettingResponse(resp);
      const payload = extractRestResponse(resp);
      emitEvent("private_number_setting", payload);
      return result;
    };

    TpEventHandler.onReactivateGoogleVoiceNumber.implementation = function (resp) {
      const result = this.onReactivateGoogleVoiceNumber(resp);
      emitEvent("reactivate_google_voice_number", extractRestResponse(resp));
      return result;
    };

    PrivatePhoneNumberManager.onDeletePrivateNumberRestCallResponse.implementation = function (resp) {
      const result = this.onDeletePrivateNumberRestCallResponse(resp);
      emitEvent("delete_private_number", extractRestResponse(resp));
      return result;
    };

    PrivatePhoneNumberManager.onGetPrivatePhoneListFromServer.implementation = function (resp) {
      const result = this.onGetPrivatePhoneListFromServer(resp);
      const payload = extractRequestPrivateNumberResponse(resp);
      sendLog("info", "PrivatePhoneNumberManager.onGetPrivatePhoneListFromServer fired", {
        errCode: payload && payload.errCode,
        phoneCount: Array.isArray(payload && payload.phones) ? payload.phones.length : null
      });
      emitEvent("request_private_number", payload);
      return result;
    };

    PrivatePhoneNumberManager.onOrderPrivateNumberResponse.implementation = function (resp) {
      const result = this.onOrderPrivateNumberResponse(resp);
      const payload = extractRestResponse(resp);
      payload.phoneNumber = cleanString(tryCall(() => resp.getPhoneNumber(), null));
      payload.orderPayload = buildOwnedPhonePayload(findOwnedPhoneItem(payload.phoneNumber));
      emitEvent("order_private_number", payload);
      return result;
    };

    hooksInstalled = true;
    sendLog("info", "Frida bridge hooks installed");
  });
}

function receiveCommands() {
  recv("bridge-command", (message) => {
    const request = message.payload || {};
    Promise.resolve(dispatch(request))
      .then((data) => replySuccess(request.id, data))
      .catch((error) => replyError(request.id, toBridgeError(error)));
    receiveCommands();
  });
}

setImmediate(() => {
  receiveCommands();
  sendLog("info", "Frida bridge agent ready");
});
