"use strict";

function dumpObject(obj) {
  const out = {};
  if (!obj) {
    return out;
  }
  try {
    let current = obj.getClass();
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
          const value = field.get(obj);
          out[name] = value === null || value === undefined ? value : String(value);
        } catch (_error) {
        }
      }
      current = current.getSuperclass();
    }
    out.__className = String(obj.getClass().getName());
    out.__toString = String(obj.toString());
  } catch (error) {
    out.__error = String(error);
  }
  return out;
}

function hookMethod(className, methodName, handler) {
  const Clazz = Java.use(className);
  Clazz[methodName].overloads.forEach((overload) => {
    overload.implementation = handler(overload);
  });
  console.log("HOOKED", className + "." + methodName, Clazz[methodName].overloads.length);
}

function install() {
  Java.perform(() => {
    hookMethod("me.dingtone.app.im.tp.TpClient", "privateNumberSetting", (overload) => function (cmd) {
      console.log("PHONE_ACTION", JSON.stringify({ name: "TpClient.privateNumberSetting", cmd: dumpObject(cmd) }));
      return overload.call(this, cmd);
    });
    hookMethod("me.dingtone.app.im.tp.TpClient", "orderPrivateNumber", (overload) => function (cmd) {
      console.log("PHONE_ACTION", JSON.stringify({ name: "TpClient.orderPrivateNumber", cmd: dumpObject(cmd) }));
      return overload.call(this, cmd);
    });
    hookMethod("me.dingtone.app.im.tp.TpClient", "deletePrivateNumber", (overload) => function (cmd) {
      console.log("PHONE_ACTION", JSON.stringify({ name: "TpClient.deletePrivateNumber", cmd: dumpObject(cmd) }));
      return overload.call(this, cmd);
    });
    hookMethod("me.tzim.app.im.tp.TpClientForJNI", "nativeRestCall", (overload) => function (ptr, type, obj) {
      const numericType = Number(type);
      if ([2050, 2052, 2132].indexOf(numericType) >= 0) {
        console.log("PHONE_ACTION", JSON.stringify({ name: "TpClientForJNI.nativeRestCall", type: numericType, obj: dumpObject(obj) }));
      }
      return overload.call(this, ptr, type, obj);
    });
    console.log("PHONE_ACTION_HOOKS_READY");
  });
}

setTimeout(install, 100);
setInterval(() => {}, 1000);
