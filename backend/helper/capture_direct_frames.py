from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import zlib
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl

import frida


DEFAULT_PACKAGE = "me.talkyou.app.im"
SETTING_KEYS = {
    "register_email": "dt_direct_template_register_email",
    "activate_email": "dt_direct_template_activate_email",
    "request": "dt_direct_template_request_phone",
    "purchase": "dt_direct_template_purchase_phone",
    "renew": "dt_direct_template_renew_phone",
    "cancel": "dt_direct_template_cancel_phone",
    "setting": "dt_direct_template_phone_setting",
}


def main() -> None:
    options = parse_args()
    script_path = Path(__file__).resolve().with_name("frida_capture_direct_frames.js")
    output_path = Path(options.output).resolve()
    frames: list[dict[str, Any]] = []

    device = resolve_device(options)
    session = attach_session_with_options(device, options)
    script = session.create_script(script_path.read_text(encoding="utf-8"), runtime="v8")

    def on_message(message: dict[str, Any], _data: bytes | None) -> None:
      if message.get("type") != "send":
          print(f"[frida] {message}", file=sys.stderr)
          return
      payload = message.get("payload")
      if not isinstance(payload, dict):
          return
      if payload.get("type") == "direct-frame":
          frame = enrich_frame(payload, len(frames) + 1)
          frames.append(frame)
          print_frame(frame)
          write_output(output_path, frames)
          return
      if payload.get("type") == "direct-fragment":
          frame = enrich_fragment(payload, len(frames) + 1)
          frames.append(frame)
          print_fragment(frame)
          write_output(output_path, frames)
          return
      if payload.get("type") == "java-call":
          frame = enrich_java_call(payload, len(frames) + 1)
          frames.append(frame)
          print_java_call(frame)
          write_output(output_path, frames)
          return
      if payload.get("type") == "log":
          level = payload.get("level", "info")
          text = payload.get("message", "")
          data = payload.get("data") or {}
          print(f"[{level}] {text} {json.dumps(data, ensure_ascii=False)}")

    script.on("message", on_message)
    script.load()

    print(f"Capturing direct frames from {options.package} for {options.seconds}s")
    print(f"Output: {output_path}")
    print("Now click the target action in the app, for example request/purchase/renew/pause/cancel phone.")
    try:
        deadline = time.time() + options.seconds
        while time.time() < deadline:
            time.sleep(0.25)
    finally:
        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass
        write_output(output_path, frames)
        print(f"Captured {len(frames)} direct frame(s).")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture Dingtone direct TCP request frames from a running Android app.")
    parser.add_argument("--package", default=DEFAULT_PACKAGE, help=f"Android package name. Default: {DEFAULT_PACKAGE}")
    parser.add_argument("--seconds", type=int, default=60, help="Capture window in seconds. Default: 60")
    parser.add_argument("--output", default="_tmp/direct-frame-templates.json", help="Output JSON path.")
    parser.add_argument("--device-mode", default="usb", choices=["usb", "local", "remote", "id"], help="Frida device mode. Default: usb")
    parser.add_argument("--device-id", default="", help="Specific frida device id. Defaults to USB device.")
    parser.add_argument("--remote-host", default="127.0.0.1:27042", help="Frida remote host when --device-mode=remote.")
    parser.add_argument("--pid", type=int, default=0, help="Attach to a specific process id instead of package name.")
    return parser.parse_args()


def resolve_device(options: argparse.Namespace) -> frida.core.Device:
    if options.device_mode == "local":
        return frida.get_local_device()
    if options.device_mode == "remote":
        return frida.get_device_manager().add_remote_device(options.remote_host)
    if options.device_mode == "id":
        if not options.device_id:
            raise RuntimeError("--device-id is required when --device-mode=id")
        return frida.get_device(options.device_id)
    return frida.get_usb_device(timeout=5)


def attach_session_with_options(device: frida.core.Device, options: argparse.Namespace) -> frida.core.Session:
    if options.pid:
        return device.attach(options.pid)
    try:
        return device.attach(options.package)
    except frida.ProcessNotFoundError:
        app_pid = find_frida_application_pid(device, options.package)
        if app_pid:
            return device.attach(app_pid)
        pid = find_android_pid(options.package)
        if pid:
            return device.attach(pid)
        try:
            pid = device.spawn([options.package])
            session = device.attach(pid)
            device.resume(pid)
            time.sleep(1.5)
            return session
        except frida.NotSupportedError as error:
            raise RuntimeError(
                f"Cannot attach by package name and spawn is unavailable. Open the app once, then retry with --pid <pid>. Detail: {error}"
            ) from error


def find_frida_application_pid(device: frida.core.Device, package: str) -> int | None:
    try:
        for app in device.enumerate_applications():
            if getattr(app, "identifier", None) == package and getattr(app, "pid", 0):
                return int(app.pid)
    except Exception:
        return None
    return None


def find_android_pid(package: str) -> int | None:
    try:
        result = subprocess.run(
            ["adb", "shell", "pidof", package],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    for part in result.stdout.split():
        if part.isdigit():
            return int(part)
    return None


def enrich_frame(payload: dict[str, Any], index: int) -> dict[str, Any]:
    hex_value = str(payload.get("hex") or "")
    raw = bytes.fromhex(hex_value)
    body = raw[22:] if len(raw) >= 22 else b""
    route = find_route(body)
    query = inflate_query(body)
    stack = str(payload.get("stack") or "")
    hint = infer_setting_hint(route, query, stack)
    name = build_name(index, route, hint)
    params = suggest_params(query)
    template = {
        "name": name,
        "hex": hex_value,
        "params": params,
    }
    return {
        "index": index,
        "capturedAt": payload.get("capturedAt"),
        "source": payload.get("source"),
        "length": payload.get("length"),
        "frameType": payload.get("frameType"),
        "status": payload.get("status"),
        "route": route,
        "settingHint": hint,
        "query": redact_query(query),
        "queryKeys": list(dict(parse_qsl(query, keep_blank_values=True)).keys()) if query else [],
        "template": template,
        "stackPreview": stack_preview(stack),
    }


def enrich_java_call(payload: dict[str, Any], index: int) -> dict[str, Any]:
    stack = str(payload.get("stack") or "")
    name = str(payload.get("name") or "java-call")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    hint = infer_setting_hint(None, json.dumps(data, ensure_ascii=False), f"{name}\n{stack}")
    return {
        "index": index,
        "capturedAt": payload.get("capturedAt"),
        "source": "java-call",
        "name": name,
        "settingHint": hint,
        "data": data,
        "stackPreview": stack_preview(stack),
    }


def enrich_fragment(payload: dict[str, Any], index: int) -> dict[str, Any]:
    stack = str(payload.get("stack") or "")
    hex_value = str(payload.get("hex") or "")
    return {
        "index": index,
        "capturedAt": payload.get("capturedAt"),
        "source": payload.get("source"),
        "fragment": True,
        "availableLength": payload.get("availableLength"),
        "declaredLength": payload.get("declaredLength"),
        "hex": hex_value,
        "stackPreview": stack_preview(stack),
    }


def print_frame(frame: dict[str, Any]) -> None:
    hint = frame.get("settingHint") or "unclassified"
    route = frame.get("route") or "-"
    print(f"[frame #{frame['index']}] hint={hint} route={route} length={frame.get('length')}")
    print(f"  template: {json.dumps(frame['template'], ensure_ascii=False)[:240]}")


def print_java_call(frame: dict[str, Any]) -> None:
    hint = frame.get("settingHint") or "unclassified"
    name = frame.get("name") or "java-call"
    data = frame.get("data") or {}
    print(f"[java #{frame['index']}] hint={hint} name={name}")
    print(f"  data: {json.dumps(data, ensure_ascii=False)[:360]}")


def print_fragment(frame: dict[str, Any]) -> None:
    print(
        f"[fragment #{frame['index']}] source={frame.get('source') or '-'} "
        f"available={frame.get('availableLength')} declared={frame.get('declaredLength')}"
    )
    print(f"  hex: {str(frame.get('hex') or '')[:240]}")


def write_output(path: Path, frames: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    settings: dict[str, str] = {}
    for frame in frames:
        hint = frame.get("settingHint")
        template = frame.get("template")
        if isinstance(hint, str) and isinstance(template, dict) and hint not in settings:
            settings[hint] = json.dumps(template, ensure_ascii=False)
    path.write_text(
        json.dumps(
            {
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "settings": settings,
                "frames": frames,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def find_route(body: bytes) -> str | None:
    strings = re.findall(rb"[\x20-\x7e]{4,}", body)
    candidates = [item.decode("ascii", "ignore") for item in strings]
    for item in candidates:
        if "/" in item and not item.startswith("d3."):
            return item
    return candidates[-1] if candidates else None


def inflate_query(body: bytes) -> str:
    for index in range(0, max(0, len(body) - 1)):
        if body[index] == 0x78 and body[index + 1] in {0x01, 0x9C, 0xDA}:
            try:
                decoded = zlib.decompress(body[index:]).decode("utf-8", "replace")
            except Exception:
                continue
            if "=" in decoded:
                return decoded
    return ""


def infer_setting_hint(route: str | None, query: str, stack: str) -> str | None:
    text = " ".join([route or "", query, stack]).lower()
    if "registeremail" in text or "register_email" in text or "register email" in text:
        return SETTING_KEYS["register_email"]
    if "activateemail" in text or "activate_email" in text or "activate email" in text:
        return SETTING_KEYS["activate_email"]
    if "deleteprivatenumber" in text or "delete_private_number" in text:
        return SETTING_KEYS["cancel"]
    if "privatenumbersetting" in text or "private_number_setting" in text:
        return SETTING_KEYS["setting"]
    if "extendmonths" in text or "renew" in text:
        return SETTING_KEYS["renew"]
    if "orderprivatenumber" in text or "order_private_number" in text:
        return SETTING_KEYS["purchase"]
    if "requestprivatephonelist" in text or "getprivatephonelist" in text or "privatephonelist" in text:
        return SETTING_KEYS["request"]
    return None


def suggest_params(query: str) -> dict[str, str]:
    if not query:
        return {}
    keys = list(dict(parse_qsl(query, keep_blank_values=True)).keys())
    params: dict[str, str] = {}
    aliases = {
        "userid": "$userId",
        "user_id": "$userId",
        "clientuserid": "$userId",
        "token": "$token",
        "deviceid": "$deviceId",
        "device_id": "$deviceId",
        "trackcode": "$trackCode",
        "appversion": "$appVersion",
        "clientversion": "$appVersion",
        "apkcertificatesign": "$apkCertificateSign",
        "countrycode": "$countryCode",
        "country_code": "$countryCode",
        "isocountrycode": "$isoCountryCode",
        "iso_country_code": "$isoCountryCode",
        "areacode": "$areaCode",
        "area_code": "$areaCode",
        "phonenumber": "$phoneNumber",
        "phone_number": "$phoneNumber",
        "privatenumber": "$phoneNumber",
        "private_number": "$phoneNumber",
        "providerid": "$providerId",
        "provider_id": "$providerId",
        "packageserviceid": "$packageServiceId",
        "package_service_id": "$packageServiceId",
        "category": "$category",
        "phonetype": "$phoneType",
        "phone_type": "$phoneType",
        "orderprice": "$price",
        "order_price": "$price",
        "price": "$price",
        "suspendflag": "$suspendFlag",
        "suspend_flag": "$suspendFlag",
        "action": "$action",
        "email": "$email",
        "confirmcode": "$confirmCode",
        "clientinfo": "$clientInfo",
        "pushmsgtoken": "$pushMsgToken",
    }
    for key in keys:
        normalized = re.sub(r"[^a-z0-9_]", "", key.lower())
        placeholder = aliases.get(normalized)
        if placeholder:
            params[key] = placeholder
    return params


def redact_query(query: str) -> str:
    if not query:
        return ""
    pairs = []
    for key, value in parse_qsl(query, keep_blank_values=True):
        if key.lower() in {"token", "authorization", "password"}:
            value = "<redacted>"
        pairs.append(f"{key}={value}")
    return "&".join(pairs)


def stack_preview(stack: str) -> list[str]:
    lines = []
    for raw_line in stack.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("java.lang.Exception"):
            continue
        if any(token in line for token in ["PrivatePhone", "Socket", "IoBridge", "dingtone", "talkyou", "tzim"]):
            lines.append(line)
        if len(lines) >= 12:
            break
    return lines


def build_name(index: int, route: str | None, hint: str | None) -> str:
    if hint:
        base = hint.removeprefix("dt_direct_template_")
    elif route:
        base = re.sub(r"[^a-zA-Z0-9]+", "_", route).strip("_").lower()
    else:
        base = "captured"
    return f"{base}_{index}"


if __name__ == "__main__":
    main()
