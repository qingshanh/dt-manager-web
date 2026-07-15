function hexPreview(ptr, len) {
  const size = Math.min(Number(len), 8192);
  if (!ptr || size <= 0) {
    return "";
  }
  try {
    return hexdump(ptr, { offset: 0, length: size, header: false, ansi: false });
  } catch (error) {
    return "hexdump failed: " + error;
  }
}

function now() {
  return new Date().toISOString();
}

function log(tag, value) {
  console.log("[" + now() + "] " + tag + " " + value);
}

function dumpJavaObject(obj) {
  if (!obj) {
    return null;
  }
  const out = {};
  try {
    out.className = obj.getClass().getName().toString();
    const fields = obj.getClass().getDeclaredFields();
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i];
      field.setAccessible(true);
      const name = field.getName().toString();
      try {
        const value = field.get(obj);
        out[name] = value === null ? null : String(value);
      } catch (error) {
        out[name] = "<field error: " + error + ">";
      }
    }
    if (typeof obj.getApiName === "function") {
      out.apiName = String(obj.getApiName());
    }
    if (typeof obj.getApiParams === "function") {
      out.apiParams = String(obj.getApiParams());
    }
    if (typeof obj.getCommandTag === "function") {
      out.commandTag = String(obj.getCommandTag());
    }
    if (typeof obj.getCommandCookie === "function") {
      out.commandCookie = String(obj.getCommandCookie());
    }
  } catch (error) {
    out.error = String(error);
    try {
      out.stringValue = String(obj);
    } catch (_) {
      out.stringValue = "<toString failed>";
    }
  }
  return out;
}

function findOverload(method, className) {
  for (let i = 0; i < method.overloads.length; i += 1) {
    const overload = method.overloads[i];
    if (overload.argumentTypes.length === 1 && overload.argumentTypes[0].className === className) {
      return overload;
    }
  }
  throw new Error("No overload found for " + className);
}

function shouldHookLoginClass(className) {
  const normalized = String(className || "").toLowerCase();
  if (normalized.indexOf("me.dingtone.") !== 0 && normalized.indexOf("me.tzim.") !== 0) {
    return false;
  }
  return /(login|verify|verification|captcha|sms|account|register|password|phone|email)/i.test(className);
}

function shouldHookLoginMethod(methodName) {
  return /(login|verify|verification|captcha|sms|code|account|register|password|phone|email)/i.test(String(methodName || ""));
}

function dumpJavaArg(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    return dumpJavaObject(value);
  } catch (error) {
    try {
      return String(value);
    } catch (_) {
      return "<arg dump failed: " + error + ">";
    }
  }
}

let captureUntil = 0;
let captureReason = "";
let captureCount = 0;
let captureWindows = [];
const captures = [];
let nativeHooksInstalled = false;
let nativeDlopenHookInstalled = false;
const nativeAttached = {};
let javaHooksInstalled = false;
let broadLoginHooksInstalled = false;
let TpClientClass = null;
let TpClientForJNIClass = null;

function armNativeCapture(reason, ms) {
  const until = Date.now() + ms;
  captureWindows = captureWindows.filter(function (item) {
    return item.until > Date.now();
  });
  captureWindows.push({ reason, until });
  captureUntil = Math.max(captureUntil, until);
  captureReason = captureWindows.map(function (item) {
    return item.reason;
  }).join("|");
  log("capture", "armed reason=" + reason + " ms=" + ms);
}

function activeCaptureReasons() {
  const t = Date.now();
  captureWindows = captureWindows.filter(function (item) {
    return item.until > t;
  });
  if (captureWindows.length === 0) {
    captureReason = "";
    return [];
  }
  captureReason = captureWindows.map(function (item) {
    return item.reason;
  }).join("|");
  return captureWindows.map(function (item) {
    return item.reason;
  });
}

function maybeCaptureNative(name, args) {
  const reasons = activeCaptureReasons();
  if (Date.now() > captureUntil || reasons.length === 0 || captureCount >= 80) {
    return;
  }
  const ptr = name === "SSL_write" ? args[1] : args[1];
  const len = name === "SSL_write" ? args[2].toInt32() : args[2].toInt32();
  const preview = hexPreview(ptr, len);
  captures.push({
    at: now(),
    reason: reasons.join("|"),
    reasons,
    fn: name,
    len,
    preview
  });
  captureCount += 1;
  log(
    "native-write",
    JSON.stringify({
      reason: captureReason,
      reasons,
      fn: name,
      len,
      preview
    })
  );
}

function findGlobalExport(name) {
  return Module.findGlobalExportByName ? Module.findGlobalExportByName(name) : Module.findExportByName(null, name);
}

for (const name of ["send", "write", "SSL_write"]) {
  const addr = findGlobalExport(name);
  if (addr) {
    Interceptor.attach(addr, {
      onEnter(args) {
        maybeCaptureNative(name, args);
      }
    });
    log("hook", "native " + name + " attached");
  }
}

function enumerateModuleSymbols(moduleName) {
  try {
    const module = Process.getModuleByName(moduleName);
    if (module && typeof module.enumerateSymbols === "function") {
      return module.enumerateSymbols();
    }
  } catch (_) {
    // Fall through to the legacy helper below.
  }
  try {
    if (Module.enumerateSymbolsSync) {
      return Module.enumerateSymbolsSync(moduleName);
    }
  } catch (_) {
    // Symbol enumeration is best-effort only.
  }
  return [];
}

function getModuleByName(moduleName) {
  try {
    return Process.getModuleByName(moduleName);
  } catch (_) {
    return null;
  }
}

function getModuleBase(moduleName) {
  try {
    const base = Module.findBaseAddress ? Module.findBaseAddress(moduleName) : null;
    if (base) {
      return base;
    }
  } catch (_) {
    // Fall through to Process.getModuleByName.
  }
  const module = getModuleByName(moduleName);
  return module ? module.base : null;
}

function installDlopenHook() {
  if (nativeDlopenHookInstalled) {
    return;
  }
  nativeDlopenHookInstalled = true;
  for (const name of ["android_dlopen_ext", "dlopen"]) {
    const addr = findGlobalExport(name);
    if (!addr) {
      continue;
    }
    try {
      Interceptor.attach(addr, {
        onEnter(args) {
          this.path = "";
          try {
            this.path = args[0] ? args[0].readCString() : "";
          } catch (_) {
            this.path = "";
          }
        },
        onLeave() {
          if (this.path && this.path.indexOf("libtzim.so") !== -1) {
            log("hook", name + " loaded " + this.path + "; retrying libtzim hooks");
            setTimeout(function () {
              installNativeHooksWhenReady(0);
            }, 50);
          }
        }
      });
      log("hook", "loader " + name + " attached");
    } catch (error) {
      log("hook-error", "loader " + name + " failed: " + error);
    }
  }
}

function hookNativeSymbols() {
  if (nativeHooksInstalled) {
    return true;
  }
  if (!getModuleByName("libtzim.so")) {
    log("hook", "libtzim.so not loaded yet; native hooks will retry");
    return false;
  }
  const wanted = [
    "NativeTpClient20GetWebOfflineMessage",
    "NativeTpClient20PrivateNumberSetting",
    "NativeTpClient24DeletePrivatePhoneNumber",
    "NativeTpClient27ReactivateGoogleVoiceNumber",
    "NativeTpClient18OrderPrivateNumber",
    "NativeTpClient20RequestPrivateNumber",
    "RequestAllOfflineMessages",
    "RequestAllOfflineMessageRpcReturn",
    "RequestOfflineMessageEx",
    "RequestAllMessage",
    "AfterOfflineMessages",
    "OfflineMessageIndication"
  ];
  const symbols = enumerateModuleSymbols("libtzim.so");
  let count = 0;
  for (const symbol of symbols) {
    const name = symbol.name || "";
    const hit = wanted.find((item) => name.indexOf(item) !== -1);
    const key = "symbol:" + name;
    if (!hit || nativeAttached[key]) {
      continue;
    }
    try {
      Interceptor.attach(symbol.address, {
        onEnter(args) {
          log("native-symbol", name);
          armNativeCapture("native-symbol:" + hit, 8000);
        }
      });
      nativeAttached[key] = true;
      count += 1;
      log("hook", "symbol " + name + " attached");
    } catch (error) {
      log("hook-error", "symbol " + name + " failed: " + error);
    }
  }
  log("hook", "native symbol hooks attached=" + count);
  const offsetCount = hookNativeOffsets();
  nativeHooksInstalled = count + offsetCount > 0;
  return nativeHooksInstalled;
}

function hookNativeOffsets() {
  const offsets = [
    { name: "NativeTpClient::GetWebOfflineMessage", offset: 0x003ac3b4, reason: "GetWebOfflineMessage" },
    { name: "NativeTpClient::RequestPrivateNumber", offset: 0x003ac714, reason: "RequestPrivateNumber" },
    { name: "NativeTpClient::OrderPrivateNumber", offset: 0x003acaf0, reason: "OrderPrivateNumber" },
    { name: "NativeTpClient::PrivateNumberSetting", offset: 0x003acfa0, reason: "PrivateNumberSetting" },
    { name: "NativeTpClient::DeletePrivatePhoneNumber", offset: 0x003b3db0, reason: "DeletePrivatePhoneNumber" },
    { name: "NativeTpClient::ReactivateGoogleVoiceNumber", offset: 0x003b45d0, reason: "ReactivateGoogleVoiceNumber" },
    { name: "Jeesu::RtcClient::RequestOfflineMessageEx", offset: 0x007697a0, reason: "RequestOfflineMessageEx" },
    { name: "Jeesu::RtcClient::RequestAllOfflineMessages", offset: 0x00769b30, reason: "RequestAllOfflineMessages" },
    { name: "Jeesu::RtcClient::OnRequestOfflineMessageRpcReturn", offset: 0x00765d78, reason: "OnRequestOfflineMessageRpcReturn" }
  ];
  const base = getModuleBase("libtzim.so");
  if (!base) {
    log("hook", "libtzim.so base not found; static offset hooks skipped");
    return 0;
  }
  let count = 0;
  for (const item of offsets) {
    const key = "offset:" + item.name;
    if (nativeAttached[key]) {
      continue;
    }
    try {
      const address = base.add(item.offset);
      Interceptor.attach(address, {
        onEnter(args) {
          log("native-offset", item.name + " @ " + address);
          armNativeCapture("native-offset:" + item.reason, 8000);
        }
      });
      nativeAttached[key] = true;
      count += 1;
      log("hook", "offset " + item.name + " attached at " + address);
    } catch (error) {
      log("hook-error", "offset " + item.name + " failed: " + error);
    }
  }
  log("hook", "native static offset hooks attached=" + count);
  return count;
}

function installNativeHooksWhenReady(attempt) {
  installDlopenHook();
  try {
    if (hookNativeSymbols()) {
      return;
    }
  } catch (error) {
    log("hook-error", "native hook install failed: " + error);
  }
  if (attempt < 20) {
    setTimeout(function () {
      installNativeHooksWhenReady(attempt + 1);
    }, 500);
  }
}

function installJavaHooks() {
  if (javaHooksInstalled) {
    return;
  }
  Java.perform(function () {
    if (javaHooksInstalled) {
      return;
    }
    let TpClient;
    let TpClientForJNI;
    let LoginMgr;
    let AppConnectionManager;
    try {
      TpClient = Java.use("me.dingtone.app.im.tp.TpClient");
      TpClientForJNI = Java.use("me.tzim.app.im.tp.TpClientForJNI");
      LoginMgr = Java.use("me.dingtone.app.im.manager.LoginMgr");
      AppConnectionManager = Java.use("me.dingtone.app.im.manager.AppConnectionManager");
    } catch (error) {
      log("java-hook-skip", "TalkU classes are not available yet: " + error);
      return;
    }
    javaHooksInstalled = true;
    TpClientClass = TpClient;
    TpClientForJNIClass = TpClientForJNI;

  const appLogin = AppConnectionManager.Login.overload();
  appLogin.implementation = function () {
    log("java-call", "AppConnectionManager.Login()");
    armNativeCapture("AppConnectionManager.Login", 10000);
    return appLogin.call(this);
  };

  const onLoginSuccess = LoginMgr.OnLoginSuccess.overload("me.tzim.app.im.datatype.DTLoginResponse", "boolean");
  onLoginSuccess.implementation = function (response, flag) {
    log("java-call", "LoginMgr.OnLoginSuccess(" + JSON.stringify(dumpJavaObject(response)) + ", " + flag + ")");
    armNativeCapture("LoginMgr.OnLoginSuccess", 15000);
    return onLoginSuccess.call(this, response, flag);
  };

  const requestAllOfflineMessage = TpClient.requestAllOfflineMessage.overload();
  requestAllOfflineMessage.implementation = function () {
    log("java-call", "TpClient.requestAllOfflineMessage()");
    armNativeCapture("requestAllOfflineMessage", 5000);
    return requestAllOfflineMessage.call(this);
  };

  const nativeRequestAllOfflineMessage = TpClientForJNI.nativeRequestAllOfflineMessage.overload("long");
  nativeRequestAllOfflineMessage.implementation = function (ptr) {
    log("jni-call", "nativeRequestAllOfflineMessage ptr=" + ptr);
    armNativeCapture("nativeRequestAllOfflineMessage", 5000);
    return nativeRequestAllOfflineMessage.call(this, ptr);
  };

  const getWebOfflineMessage = findOverload(TpClient.getWebOfflineMessage, "me.tzim.app.im.datatype.DTRestCallBase");
  getWebOfflineMessage.implementation = function (cmd) {
    log("getWebOfflineMessage", JSON.stringify(dumpJavaObject(cmd)));
    armNativeCapture("getWebOfflineMessage", 5000);
    return getWebOfflineMessage.call(this, cmd);
  };

  const nativeRestCall = TpClientForJNI.nativeRestCall.overload("long", "int", "java.lang.Object");
  nativeRestCall.implementation = function (ptr, type, obj) {
    const payload = dumpJavaObject(obj);
    log("nativeRestCall", JSON.stringify({ ptr: String(ptr), type, payload }));
    if ([552, 1792, 2048, 2050, 2051, 2052, 2132, 2304].indexOf(Number(type)) !== -1) {
      armNativeCapture("nativeRestCall:" + type, 5000);
    }
    return nativeRestCall.call(this, ptr, type, obj);
  };

  const nativeRestCallImpl = TpClientForJNI.nativeRestCall_impl.overload("long", "int", "java.lang.Object");
  nativeRestCallImpl.implementation = function (ptr, type, obj) {
    const payload = dumpJavaObject(obj);
    log("nativeRestCall_impl", JSON.stringify({ ptr: String(ptr), type, payload }));
    if ([552, 1792, 2048, 2050, 2051, 2052, 2132, 2304].indexOf(Number(type)) !== -1) {
      armNativeCapture("nativeRestCall_impl:" + type, 5000);
    }
    return nativeRestCallImpl.call(this, ptr, type, obj);
  };

  const commonRestCall = findOverload(TpClient.commonRestCall, "me.tzim.app.im.datatype.DTCommonRestCallCmd");
  commonRestCall.implementation = function (cmd) {
    log("commonRestCall", JSON.stringify(dumpJavaObject(cmd)));
    return commonRestCall.call(this, cmd);
  };

  const reactivateGoogleVoiceNumber = findOverload(TpClient.reactivateGoogleVoiceNumber, "me.dingtone.app.im.datatype.DTReactivateGoogleVoiceNumberCmd");
  reactivateGoogleVoiceNumber.implementation = function (cmd) {
    log("reactivateGoogleVoiceNumber", JSON.stringify(dumpJavaObject(cmd)));
    return reactivateGoogleVoiceNumber.call(this, cmd);
  };

  const deletePrivateNumber = findOverload(TpClient.deletePrivateNumber, "me.dingtone.app.im.datatype.DTDeletePrivateNumberCmd");
  deletePrivateNumber.implementation = function (cmd) {
    log("deletePrivateNumber", JSON.stringify(dumpJavaObject(cmd)));
    return deletePrivateNumber.call(this, cmd);
  };

  const privateNumberSetting = findOverload(TpClient.privateNumberSetting, "me.dingtone.app.im.datatype.DTPrivateNumberSettingCmd");
  privateNumberSetting.implementation = function (cmd) {
    log("privateNumberSetting", JSON.stringify(dumpJavaObject(cmd)));
    return privateNumberSetting.call(this, cmd);
  };

    log("ready", "TalkU Java capture hooks installed");
  });
}

function installBroadLoginHooks() {
  if (broadLoginHooksInstalled || typeof Java === "undefined" || !Java.available) {
    return 0;
  }
  let installed = 0;
  Java.perform(function () {
    const classes = Java.enumerateLoadedClassesSync().filter(shouldHookLoginClass).slice(0, 240);
    for (const className of classes) {
      let clazz;
      try {
        clazz = Java.use(className);
      } catch (_) {
        continue;
      }
      let names = [];
      try {
        const methods = clazz.class.getDeclaredMethods();
        for (let i = 0; i < methods.length; i += 1) {
          const name = String(methods[i].getName());
          if (shouldHookLoginMethod(name) && names.indexOf(name) === -1) {
            names.push(name);
          }
        }
      } catch (_) {
        names = Object.keys(clazz).filter(shouldHookLoginMethod);
      }
      for (const methodName of names.slice(0, 20)) {
        const method = clazz[methodName];
        if (!method || !method.overloads) {
          continue;
        }
        for (let i = 0; i < method.overloads.length; i += 1) {
          const overload = method.overloads[i];
          const hookKey = "java-login:" + className + "." + methodName + "#" + i;
          if (nativeAttached[hookKey]) {
            continue;
          }
          try {
            overload.implementation = function () {
              const args = [];
              for (let j = 0; j < arguments.length; j += 1) {
                args.push(dumpJavaArg(arguments[j]));
              }
              log("login-candidate", JSON.stringify({ className, methodName, overload: i, args }));
              armNativeCapture(hookKey, 8000);
              return overload.apply(this, arguments);
            };
            nativeAttached[hookKey] = true;
            installed += 1;
          } catch (error) {
            log("hook-error", hookKey + " failed: " + error);
          }
        }
      }
    }
  });
  broadLoginHooksInstalled = installed > 0;
  log("hook", "broad login hooks installed=" + installed);
  return installed;
}

rpc.exports = {
  requestoffline: function () {
    if (typeof Java === "undefined" || !Java.available) {
      throw new Error("Java runtime is not available in this process yet");
    }
    if (!TpClientClass) {
      installJavaHooks();
    }
    if (!TpClientClass) {
      throw new Error("TpClient Java class is not available in this process yet");
    }
    const result = {
      appCall: false,
      jniCall: false,
      ptr: "",
      errors: []
    };
    Java.perform(function () {
      armNativeCapture("rpc:requestAllOfflineMessage", 15000);
      try {
        const client = TpClientClass.getInstance();
        log("rpc", "calling TpClient.getInstance().requestAllOfflineMessage()");
        client.requestAllOfflineMessage();
        result.appCall = true;
      } catch (error) {
        result.errors.push("appCall: " + error);
      }
      try {
        const jni = TpClientForJNIClass.INSTANCE.value || TpClientForJNIClass.INSTANCE;
        const ptr = jni.getmPtr();
        result.ptr = String(ptr);
        log("rpc", "calling TpClientForJNI.INSTANCE.nativeRequestAllOfflineMessage ptr=" + ptr);
        jni.nativeRequestAllOfflineMessage(ptr);
        result.jniCall = true;
      } catch (error) {
        result.errors.push("jniCall: " + error);
      }
    });
    if (!result.appCall && !result.jniCall) {
      throw new Error("requestoffline failed: " + result.errors.join("; "));
    }
    return result;
  },
  requestweboffline: function () {
    if (typeof Java === "undefined" || !Java.available) {
      throw new Error("Java runtime is not available in this process yet");
    }
    if (!TpClientClass) {
      installJavaHooks();
    }
    if (!TpClientClass) {
      throw new Error("TpClient Java class is not available in this process yet");
    }
    const result = {
      appCall: false,
      errors: []
    };
    Java.perform(function () {
      armNativeCapture("rpc:getWebOfflineMessage", 15000);
      try {
        const DTRestCallBase = Java.use("me.tzim.app.im.datatype.DTRestCallBase");
        const client = TpClientClass.getInstance();
        log("rpc", "calling TpClient.getInstance().getWebOfflineMessage(DTRestCallBase)");
        client.getWebOfflineMessage(DTRestCallBase.$new());
        result.appCall = true;
      } catch (error) {
        result.errors.push("appCall: " + error);
      }
    });
    if (!result.appCall) {
      throw new Error("requestweboffline failed: " + result.errors.join("; "));
    }
    return result;
  },
  captures: function () {
    return captures;
  },
  clearcaptures: function () {
    captures.length = 0;
    captureCount = 0;
    captureUntil = 0;
    captureReason = "";
    captureWindows = [];
    return true;
  }
};

installNativeHooksWhenReady(0);
if (typeof Java !== "undefined" && Java.available) {
  installJavaHooks();
  installBroadLoginHooks();
  setTimeout(installJavaHooks, 1000);
  setTimeout(installBroadLoginHooks, 1500);
  setTimeout(installJavaHooks, 3000);
  setTimeout(installBroadLoginHooks, 3500);
} else {
  setTimeout(function () {
    if (typeof Java !== "undefined" && Java.available) {
      installJavaHooks();
      installBroadLoginHooks();
    }
  }, 1000);
  setTimeout(function () {
    if (typeof Java !== "undefined" && Java.available) {
      installJavaHooks();
      installBroadLoginHooks();
    }
  }, 3000);
}

log("ready", "TalkU capture bootstrap installed");
