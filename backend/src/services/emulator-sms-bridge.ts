import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

export interface SendSmsViaEmulatorResult {
  success: boolean;
  msgId?: string;
  method: "frida" | "adb_ui" | "fallback";
  error?: string;
}

/**
 * 尝试通过当前连接的 Android 模拟器/设备发送真实短信
 */
export async function sendSmsViaEmulator(params: {
  fromNumber: string;
  toNumber: string;
  content: string;
  appVariant?: string;
}): Promise<SendSmsViaEmulatorResult> {
  const cleanTo = params.toNumber.replace(/[^0-9]/g, "");
  const cleanFrom = params.fromNumber.replace(/[^0-9]/g, "");
  const packageName = params.appVariant === "dingdong" ? "me.dingtone.app.im" : "me.talkyou.app.im";

  // 1. 检查 adb 设备是否存在
  try {
    const { stdout: devicesOut } = await execFileAsync("adb", ["devices"]);
    if (!devicesOut.includes("device") || devicesOut.trim().split("\n").length < 2) {
      return { success: false, method: "fallback", error: "未检测到已连接的模拟器或 Android 设备" };
    }
  } catch (err: any) {
    return { success: false, method: "fallback", error: "ADB 不可用: " + (err?.message || String(err)) };
  }

  // 2. 尝试使用 Frida 桥接调用 SMSManager.sendSmsTextMessage
  const tempScriptPath = path.join(os.tmpdir(), "send_sms_" + Date.now() + ".js");
  const escapedContent = JSON.stringify(params.content);
  const fridaScript = [
    'Java.perform(function () {',
    '  try {',
    '    var SMSManager = Java.use("me.dingtone.app.im.sms.SMSManager");',
    '    var DtSmsTextMessage = Java.use("me.dingtone.app.im.datatype.message.DtSmsTextMessage");',
    '    var TpClient = Java.use("me.dingtone.app.im.tp.TpClient");',
    '    var CharSequence = Java.use("java.lang.CharSequence");',
    '    var BufferType = Java.use("android.widget.TextView$BufferType");',
    '    var StringClass = Java.use("java.lang.String");',
    '    var PrivatePhoneNumberManager = Java.use("me.dingtone.app.im.phonenumber.privatephone.PrivatePhoneNumberManager");',
    '    var chatHandled = false;',
    '    Java.choose("me.dingtone.app.im.activity.MessageChatActivity", {',
    '      onMatch: function (act) {',
    '        try {',
    '          var toNum = "' + cleanTo + '";',
    '          var curCon = act.conversation.value;',
    '          var conId = curCon ? String(curCon.getConversationId()) : "";',
    '          if (conId.indexOf(toNum) !== -1) {',
    '            chatHandled = true;',
    '            Java.scheduleOnMainThread(function () {',
    '              try {',
    '                var textObj = Java.cast(StringClass.$new(' + escapedContent + '), CharSequence);',
    '                act.edit.value.setText(textObj, BufferType.EDITABLE.value);',
    '                act.sendForClick();',
    '                send({ status: "success", msgId: "ui_sent", type: "chat_ui" });',
    '              } catch (e) {',
    '                send({ status: "error", error: String(e) });',
    '              }',
    '            });',
    '          }',
    '        } catch (e) {}',
    '      },',
    '      onComplete: function () {}',
    '    });',
    '    if (!chatHandled) {',
    '      Java.scheduleOnMainThread(function () {',
    '        try {',
    '          var privateItem = PrivatePhoneNumberManager.getInstance().getPrivateItemByPrivateNumber("' + cleanFrom + '");',
    '          if (!privateItem) {',
    '            send({ status: "error", error: "模拟器当前登录的账号名下没有发件号码 ' + cleanFrom + '，请在模拟器中切换至对应账号" });',
    '            return;',
    '          }',
    '          var msgId = String(TpClient.getInstance().allocMessageId());',
    '          var msg = DtSmsTextMessage.$new();',
    '          msg.setMsgId(msgId);',
    '          msg.setContent(' + escapedContent + ');',
    '          msg.setSenderId("' + cleanFrom + '");',
    '          msg.setConversationPhoneNumber("' + cleanTo + '");',
    '          SMSManager.getInstance().sendSmsTextMessage(msg);',
    '          send({ status: "success", msgId: msgId, type: "manager_api" });',
    '        } catch (err) {',
    '          send({ status: "error", error: String(err) });',
    '        }',
    '      });',
    '    }',
    '  } catch (err) {',
    '    send({ status: "fatal", error: String(err) });',
    '  }',
    '});'
  ].join("\n");

  try {
    await writeFile(tempScriptPath, fridaScript, "utf8");
    const { stdout } = await execFileAsync("frida", [
      "-n", packageName,
      "-l", tempScriptPath,
      "-q",
      "--eval", "setTimeout(function(){Process.exit(0);}, 3500);"
    ], { timeout: 6000 });

    logger.info("Frida send SMS output", { stdout });
    if (stdout.includes('"status": "success"') || stdout.includes("'status': 'success'")) {
      const match = stdout.match(/msgId['":\s]+([0-9a-zA-Z_]+)/);
      return {
        success: true,
        msgId: match ? match[1] : ("ems_" + Date.now()),
        method: "frida"
      };
    }
    const errMatch = stdout.match(/error['":\s]+([^'"}]+)/);
    if (errMatch && errMatch[1]) {
      return { success: false, method: "fallback", error: errMatch[1].trim() };
    }
  } catch (err: any) {
    logger.warn("Frida send SMS failed, trying fallback", { error: err?.message });
    return { success: false, method: "fallback", error: err?.message || "注入调用失败" };
  } finally {
    try { await unlink(tempScriptPath); } catch {}
  }

  return { success: false, method: "fallback", error: "模拟器未处于可注入状态或调用超时" };
}
