"use strict";

const MAX_FRAME_BYTES = 1024 * 1024;

function sendLog(level, message, data) {
  send({
    type: "log",
    level: level,
    message: message,
    data: data || {}
  });
}

function toHex(bytes) {
  const parts = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index] & 0xff;
    parts.push((value < 16 ? "0" : "") + value.toString(16));
  }
  return parts.join("");
}

function copyByteArray(buffer, offset, length) {
  const end = Math.min(buffer.length, offset + length);
  const out = [];
  for (let index = offset; index < end; index += 1) {
    out.push(buffer[index] & 0xff);
  }
  return out;
}

function copyNativeBytes(address, length) {
  const safeLength = Math.min(Number(length) || 0, MAX_FRAME_BYTES);
  if (!address || safeLength <= 0) {
    return [];
  }
  const raw = address.readByteArray(safeLength);
  if (!raw) {
    return [];
  }
  return Array.prototype.slice.call(new Uint8Array(raw));
}

function copyNativeIovecs(iov, iovcnt) {
  const out = [];
  const pointerSize = Process.pointerSize;
  const iovecSize = pointerSize * 2;
  const count = Math.min(Number(iovcnt) || 0, 32);
  for (let index = 0; index < count && out.length < MAX_FRAME_BYTES; index += 1) {
    const item = iov.add(index * iovecSize);
    const base = item.readPointer();
    const len = pointerSize === 8 ? item.add(pointerSize).readU64().toNumber() : item.add(pointerSize).readU32();
    const chunk = copyNativeBytes(base, Math.min(len, MAX_FRAME_BYTES - out.length));
    for (let chunkIndex = 0; chunkIndex < chunk.length; chunkIndex += 1) {
      out.push(chunk[chunkIndex]);
    }
  }
  return out;
}

function captureStack() {
  try {
    if (Java.available) {
      return Java.use("android.util.Log").getStackTraceString(Java.use("java.lang.Exception").$new());
    }
  } catch (_error) {
  }
  try {
    return Thread.backtrace(this.context, Backtracer.ACCURATE)
      .map(DebugSymbol.fromAddress)
      .join("\n");
  } catch (_error) {
    return "";
  }
}

function findNativeExport(moduleName, symbolName) {
  try {
    if (Module.findExportByName) {
      return Module.findExportByName(moduleName, symbolName);
    }
  } catch (_error) {
  }
  try {
    if (!moduleName && Module.findGlobalExportByName) {
      return Module.findGlobalExportByName(symbolName);
    }
  } catch (_error) {
  }
  try {
    if (!moduleName && Module.getGlobalExportByName) {
      return Module.getGlobalExportByName(symbolName);
    }
  } catch (_error) {
  }
  try {
    if (moduleName && Process.getModuleByName) {
      const moduleObject = Process.getModuleByName(moduleName);
      if (moduleObject && moduleObject.findExportByName) {
        return moduleObject.findExportByName(symbolName);
      }
      if (moduleObject && moduleObject.getExportByName) {
        return moduleObject.getExportByName(symbolName);
      }
    }
  } catch (_error) {
  }
  return null;
}

function emitFrameAt(source, bytes, offset) {
  if (bytes.length - offset < 22 || bytes.length > MAX_FRAME_BYTES) {
    return 0;
  }
  if (bytes[offset] !== 0x01 || bytes[offset + 1] !== 0x07) {
    return 0;
  }
  const declaredLength =
    ((bytes[offset + 2] & 0xff) << 24) |
    ((bytes[offset + 3] & 0xff) << 16) |
    ((bytes[offset + 4] & 0xff) << 8) |
    (bytes[offset + 5] & 0xff);
  if (declaredLength <= 0) {
    return 0;
  }
  if (declaredLength > bytes.length - offset) {
    send({
      type: "direct-fragment",
      source: source,
      capturedAt: new Date().toISOString(),
      availableLength: bytes.length - offset,
      declaredLength: declaredLength,
      hex: toHex(bytes.slice(offset)),
      stack: captureStack()
    });
    return 0;
  }

  const frame = bytes.slice(offset, offset + declaredLength);
  const frameType = ((frame[6] & 0xff) << 8) | (frame[7] & 0xff);
  const status = frame.length >= 18 ? (((frame[16] & 0xff) << 8) | (frame[17] & 0xff)) : null;
  send({
    type: "direct-frame",
    source: source,
    capturedAt: new Date().toISOString(),
    length: frame.length,
    frameType: frameType,
    status: status,
    hex: toHex(frame),
    stack: captureStack()
  });
  return declaredLength;
}

function maybeEmitFrame(source, bytes) {
  if (bytes.length < 22 || bytes.length > MAX_FRAME_BYTES) {
    return;
  }
  let offset = 0;
  while (offset <= bytes.length - 22) {
    const found = bytes.indexOf(0x01, offset);
    if (found < 0 || found > bytes.length - 2) {
      return;
    }
    if (bytes[found + 1] !== 0x07) {
      offset = found + 1;
      continue;
    }
    const emittedLength = emitFrameAt(source, bytes, found);
    offset = emittedLength > 0 ? found + emittedLength : found + 1;
  }
}

function hookSocketOutputStream() {
  const SocketOutputStream = Java.use("java.net.SocketOutputStream");
  let installed = 0;

  SocketOutputStream.write.overloads.forEach((overload) => {
    const signature = overload.argumentTypes.map((item) => item.className).join(",");
    overload.implementation = function () {
      try {
        if (signature === "[B") {
          const bytes = copyByteArray(arguments[0], 0, arguments[0].length);
          maybeEmitFrame("java.net.SocketOutputStream.write(byte[])", bytes);
        } else if (signature === "[B,int,int") {
          const bytes = copyByteArray(arguments[0], arguments[1], arguments[2]);
          maybeEmitFrame("java.net.SocketOutputStream.write(byte[],int,int)", bytes);
        }
      } catch (error) {
        sendLog("warn", "SocketOutputStream.write capture failed", { error: String(error) });
      }
      return overload.apply(this, arguments);
    };
    installed += 1;
  });

  sendLog("info", "SocketOutputStream hooks installed", { overloads: installed });
}

function hookIoBridge() {
  const IoBridge = Java.use("libcore.io.IoBridge");
  const overload = IoBridge.write.overload("java.io.FileDescriptor", "[B", "int", "int");
  overload.implementation = function (fd, buffer, offset, length) {
    try {
      const bytes = copyByteArray(buffer, offset, length);
      maybeEmitFrame("libcore.io.IoBridge.write", bytes);
    } catch (error) {
      sendLog("warn", "IoBridge.write capture failed", { error: String(error) });
    }
    return overload.call(this, fd, buffer, offset, length);
  };
  sendLog("info", "IoBridge.write hook installed");
}

function hookNativeWriteLike(name, reader) {
  const address = findNativeExport(null, name);
  if (!address) {
    sendLog("warn", "Native export unavailable", { name: name });
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      try {
        maybeEmitFrame(name, reader(args));
      } catch (error) {
        sendLog("warn", name + " capture failed", { error: String(error) });
      }
    }
  });
  sendLog("info", "Native hook installed", { name: name });
}

function hookSslWrite() {
  const address = findNativeExport("libssl.so", "SSL_write") || findNativeExport(null, "SSL_write");
  if (!address) {
    sendLog("warn", "Native export unavailable", { name: "SSL_write" });
    return;
  }
  Interceptor.attach(address, {
    onEnter(args) {
      try {
        maybeEmitFrame("SSL_write", copyNativeBytes(args[1], args[2].toInt32()));
      } catch (error) {
        sendLog("warn", "SSL_write capture failed", { error: String(error) });
      }
    }
  });
  sendLog("info", "Native hook installed", { name: "SSL_write" });
}

function hookNativeWriters() {
  hookNativeWriteLike("send", (args) => copyNativeBytes(args[1], args[2].toInt32()));
  hookNativeWriteLike("write", (args) => copyNativeBytes(args[1], args[2].toInt32()));
  hookNativeWriteLike("writev", (args) => copyNativeIovecs(args[1], args[2].toInt32()));
  hookSslWrite();
}

function stringifyJavaValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      return value;
    }
    return String(value);
  } catch (_error) {
    return "<unprintable>";
  }
}

function dumpJavaObject(obj) {
  const out = {};
  if (!obj) {
    return out;
  }
  try {
    const clazz = obj.getClass();
    let current = clazz;
    while (current) {
      const fields = current.getDeclaredFields();
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        try {
          field.setAccessible(true);
          const name = String(field.getName());
          if (name.indexOf("$") >= 0 || Object.prototype.hasOwnProperty.call(out, name)) {
            continue;
          }
          out[name] = stringifyJavaValue(field.get(obj));
        } catch (_fieldError) {
        }
      }
      current = current.getSuperclass();
    }
  } catch (error) {
    out.__error = String(error);
  }
  try {
    out.__className = String(obj.getClass().getName());
  } catch (_error) {
  }
  try {
    out.__toString = String(obj.toString());
  } catch (_error) {
  }
  return out;
}

function emitJavaCall(name, data) {
  send({
    type: "java-call",
    capturedAt: new Date().toISOString(),
    name: name,
    data: data || {},
    stack: captureStack()
  });
}

function hookJavaMethod(className, methodName, wrapper) {
  try {
    const Clazz = Java.use(className);
    if (!Clazz[methodName]) {
      sendLog("warn", "Java method unavailable", { className: className, methodName: methodName });
      return;
    }
    let installed = 0;
    Clazz[methodName].overloads.forEach((overload) => {
      overload.implementation = wrapper(overload);
      installed += 1;
    });
    sendLog("info", "Java method hook installed", { className: className, methodName: methodName, overloads: installed });
  } catch (error) {
    sendLog("warn", "Java method hook failed", { className: className, methodName: methodName, error: String(error) });
  }
}

function hookPrivatePhoneJavaCalls() {
  hookJavaMethod("me.dingtone.app.im.tp.TpClient", "registerEmail", (overload) => function (cmd) {
    emitJavaCall("TpClient.registerEmail", { cmd: dumpJavaObject(cmd) });
    return overload.call(this, cmd);
  });
  hookJavaMethod("me.dingtone.app.im.tp.TpClient", "activateEmail", (overload) => function (cmd) {
    emitJavaCall("TpClient.activateEmail", { cmd: dumpJavaObject(cmd) });
    return overload.call(this, cmd);
  });
  hookJavaMethod("me.dingtone.app.im.tp.TpClient", "privateNumberSetting", (overload) => function (cmd) {
    emitJavaCall("TpClient.privateNumberSetting", { cmd: dumpJavaObject(cmd) });
    return overload.call(this, cmd);
  });
  hookJavaMethod("me.dingtone.app.im.tp.TpClient", "orderPrivateNumber", (overload) => function (cmd) {
    emitJavaCall("TpClient.orderPrivateNumber", { cmd: dumpJavaObject(cmd) });
    return overload.call(this, cmd);
  });
  hookJavaMethod("me.dingtone.app.im.tp.TpClient", "deletePrivateNumber", (overload) => function (cmd) {
    emitJavaCall("TpClient.deletePrivateNumber", { cmd: dumpJavaObject(cmd) });
    return overload.call(this, cmd);
  });
  hookJavaMethod("me.tzim.app.im.tp.TpClientForJNI", "nativeRestCall", (overload) => function (ptr, type, obj) {
    const typeValue = typeof type === "number" ? type : Number(type);
    if ([543, 773, 774, 2050, 2052, 2132].indexOf(typeValue) >= 0) {
      emitJavaCall("TpClientForJNI.nativeRestCall", {
        type: typeValue,
        obj: dumpJavaObject(obj)
      });
    }
    return overload.call(this, ptr, type, obj);
  });
}

let javaHooksInstalled = false;

function installJavaHooksWhenReady(attempt) {
  if (javaHooksInstalled) {
    return;
  }
  if (typeof Java === "undefined" || !Java.available) {
    if (attempt < 20) {
      setTimeout(() => installJavaHooksWhenReady(attempt + 1), 500);
    } else {
      sendLog("warn", "Java runtime was not available for private phone hooks");
    }
    return;
  }
  Java.perform(() => {
    if (javaHooksInstalled) {
      return;
    }
    try {
      hookSocketOutputStream();
    } catch (error) {
      sendLog("warn", "SocketOutputStream hook unavailable", { error: String(error) });
    }
    try {
      hookIoBridge();
    } catch (error) {
      sendLog("warn", "IoBridge hook unavailable", { error: String(error) });
    }
    try {
      hookPrivatePhoneJavaCalls();
    } catch (error) {
      sendLog("warn", "Private phone Java hooks unavailable", { error: String(error) });
    }
    javaHooksInstalled = true;
  });
}

setImmediate(() => {
  const install = () => {
    try {
      hookNativeWriters();
    } catch (error) {
      sendLog("warn", "Native writer hooks unavailable", { error: String(error) });
    }
    installJavaHooksWhenReady(0);
    sendLog("info", "Direct frame capture agent ready");
  };

  install();
});
