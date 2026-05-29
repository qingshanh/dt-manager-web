from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import frida


DEFAULT_DEVICE_ID = "127.0.0.1:21503"
DEFAULT_PACKAGE = "me.talkyou.app.im"


def main() -> int:
    options = parse_args()
    root = Path(__file__).resolve().parent.parent
    script_path = root / "tools" / "frida-capture-talku-actions.js"
    output_path = Path(options.output).resolve()
    events: list[dict[str, Any]] = []

    if options.force_stop and options.mode in {"spawn", "launch-attach"}:
        run_adb(options.device_id, ["shell", "am", "force-stop", options.package])

    device = get_frida_device(options.device_id)
    pid, session, spawned = attach_or_spawn(device, options)
    script = session.create_script(script_path.read_text(encoding="utf-8"), runtime="v8")

    def on_message(message: dict[str, Any], data: bytes | None) -> None:
        event = {
            "at": iso_now(),
            "message": message,
            "dataLength": len(data) if data else 0,
        }
        events.append(event)
        if message.get("type") == "log":
            print(message.get("payload", ""), flush=True)
        elif message.get("type") == "error":
            print(json.dumps(message, ensure_ascii=False), file=sys.stderr, flush=True)

    script.on("message", on_message)
    script.load()
    if spawned:
        device.resume(pid)

    adb_probe = probe_adb_environment(options.device_id, options.package)
    env_probe = probe_frida_environment(session)
    print(
        "Capture env: "
        + json.dumps(
            {
                "adbAbi": adb_probe.get("cpuAbiList") or adb_probe.get("cpuAbi"),
                "java": env_probe.get("java"),
                "arch": env_probe.get("arch"),
                "hasTzim": env_probe.get("hasTzim"),
                "nativeBridgeLikely": env_probe.get("nativeBridgeLikely"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    deadline = time.time() + options.seconds
    request_result: dict[str, Any] = {"called": False, "ok": False, "error": "", "action": options.action}

    while time.time() < deadline:
        if (
            options.action == "offline"
            and not request_result["called"]
            and time.time() >= deadline - options.seconds + options.request_delay
        ):
            request_result["called"] = True
            request_result.update(call_request_offline(script, options.request_retries, options.request_retry_delay))
        time.sleep(0.25)

    captures: Any = []
    try:
        captures = script.exports_sync.captures()
    except Exception as error:
        events.append({"at": iso_now(), "captureError": str(error)})

    result = {
        "generatedAt": iso_now(),
        "deviceId": options.device_id,
        "package": options.package,
        "pid": pid,
        "adbEnvironment": adb_probe,
        "fridaEnvironment": env_probe,
        "requestOffline": request_result,
        "captures": captures,
        "events": events,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {output_path}", flush=True)
    print(f"Captured {len(captures) if isinstance(captures, list) else 0} native write(s)", flush=True)
    if captures and options.action == "offline":
        print(
            "Next: cd backend && npm run import:direct-template -- "
            f"--capture-file {output_path} --setting-key dt_direct_template_offline_messages",
            flush=True,
        )
        print(
            "Inspect the dry-run candidate hints first, then re-run with --index <candidate-index> --write only for a confirmed offline-message frame.",
            flush=True,
        )
    elif options.action == "offline":
        if env_probe.get("nativeBridgeLikely"):
            print(
                "No native frame was captured. This device looks like an x86/x86_64 Android runtime running the app "
                "through native translation; use an arm64 emulator or a real Android device for this capture.",
                flush=True,
            )
        else:
            print(
                "No native frame was captured. Re-run with a longer --seconds window and confirm the app is logged in "
                "before importing dt_direct_template_offline_messages.",
                flush=True,
            )
    elif captures:
        print(
            "Manual-action capture written. Inspect events for login-candidate entries and run import:direct-template dry-run if a 0107 frame needs analysis.",
            flush=True,
        )

    try:
        script.unload()
    except Exception:
        pass
    try:
        session.detach()
    except Exception:
        pass
    if options.force_stop_after:
        run_adb(options.device_id, ["shell", "am", "force-stop", options.package])

    return 0 if request_result.get("ok") or captures or options.action == "none" else 2


def get_frida_device(device_id: str) -> frida.core.Device:
    if ":" in device_id and not device_id.startswith("usb"):
        return frida.get_device_manager().add_remote_device(device_id)
    return frida.get_device(device_id, timeout=10)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Spawn/attach TalkU and capture direct frames for offline messages or manual login/SMS-code actions.")
    parser.add_argument(
        "--mode",
        choices=["spawn", "attach", "launch-attach"],
        default="spawn",
        help="spawn with Frida, attach to an existing pid/process, or launch normally then attach.",
    )
    parser.add_argument("--device-id", default=DEFAULT_DEVICE_ID, help=f"Frida/ADB device id. Default: {DEFAULT_DEVICE_ID}")
    parser.add_argument("--package", default=DEFAULT_PACKAGE, help=f"Android package. Default: {DEFAULT_PACKAGE}")
    parser.add_argument("--pid", type=int, default=0, help="Attach to this Android pid when --mode=attach.")
    parser.add_argument("--seconds", type=float, default=25, help="Total capture window in seconds.")
    parser.add_argument(
        "--action",
        choices=["offline", "none"],
        default="offline",
        help="offline calls requestAllOfflineMessage automatically; none only observes manual app actions such as phone-code login.",
    )
    parser.add_argument("--request-delay", type=float, default=8, help="Seconds to wait before calling requestoffline RPC.")
    parser.add_argument("--request-retries", type=int, default=8, help="requestoffline RPC retry count.")
    parser.add_argument("--request-retry-delay", type=float, default=1.5, help="Seconds between requestoffline retries.")
    parser.add_argument("--output", default="_tmp/talku-offline-capture.json", help="Output JSON path.")
    parser.add_argument("--no-force-stop", dest="force_stop", action="store_false", help="Do not force-stop before spawn.")
    parser.add_argument("--force-stop-after", action="store_true", help="Force-stop the app after capture.")
    parser.set_defaults(force_stop=True)
    return parser.parse_args()


def attach_or_spawn(device: frida.core.Device, options: argparse.Namespace) -> tuple[int, frida.core.Session, bool]:
    if options.mode == "spawn":
        pid = device.spawn([options.package])
        return pid, device.attach(pid), True

    if options.mode == "launch-attach":
        launch_app(options.device_id, options.package)
        pid = wait_for_android_pid(options.device_id, options.package, timeout=20)
        if not pid:
            pid = wait_for_frida_application_pid(device, options.package, timeout=10)
        if not pid:
            raise RuntimeError(f"Could not find a running pid for {options.package} after launch")
        return pid, device.attach(pid), False

    if options.pid:
        return options.pid, device.attach(options.pid), False
    pid = wait_for_android_pid(options.device_id, options.package, timeout=2)
    if not pid:
        pid = wait_for_frida_application_pid(device, options.package, timeout=2)
    if not pid:
        raise RuntimeError(f"Could not find a running pid for {options.package}; use --pid or --mode launch-attach")
    return pid, device.attach(pid), False


def call_request_offline(script: frida.core.Script, retries: int, delay: float) -> dict[str, Any]:
    last_error = ""
    for attempt in range(1, retries + 1):
        try:
            value = script.exports_sync.requestoffline()
            return {"ok": True, "attempt": attempt, "result": value, "error": ""}
        except Exception as error:
            last_error = str(error)
            print(f"requestoffline attempt {attempt} failed: {last_error}", flush=True)
            time.sleep(delay)
    return {"ok": False, "attempt": retries, "result": None, "error": last_error}


def probe_adb_environment(device_id: str, package: str) -> dict[str, Any]:
    cpu_abi_list = run_adb_text(device_id, ["shell", "getprop", "ro.product.cpu.abilist"], timeout=5)
    cpu_abi = run_adb_text(device_id, ["shell", "getprop", "ro.product.cpu.abi"], timeout=5)
    native_bridge = run_adb_text(device_id, ["shell", "getprop", "ro.dalvik.vm.native.bridge"], timeout=5)
    pid = run_adb_text(device_id, ["shell", "pidof", package], timeout=5)
    return {
        "cpuAbiList": cpu_abi_list,
        "cpuAbi": cpu_abi,
        "nativeBridge": native_bridge,
        "pidof": pid,
        "arm64Likely": "arm64" in f"{cpu_abi_list} {cpu_abi}".lower(),
        "x86Likely": "x86" in f"{cpu_abi_list} {cpu_abi}".lower(),
    }


def probe_frida_environment(session: frida.core.Session) -> dict[str, Any]:
    code = r"""
rpc.exports = {
  probe: function () {
    const modules = Process.enumerateModules()
      .filter(function (m) {
        const text = ((m.name || "") + " " + (m.path || "")).toLowerCase();
        return text.indexOf("tzim") >= 0 || text.indexOf("libart") >= 0 || text.indexOf("boot-core-libart") >= 0;
      })
      .map(function (m) {
        return { name: m.name, path: m.path, base: String(m.base), size: m.size };
      });
    const hasTzim = modules.some(function (m) {
      return ((m.name || "") + " " + (m.path || "")).toLowerCase().indexOf("tzim") >= 0;
    });
    const hasX8664Art = modules.some(function (m) {
      return ((m.path || "") + " " + (m.name || "")).toLowerCase().indexOf("x86_64") >= 0;
    });
    return {
      java: typeof Java === "undefined" ? "undefined" : String(Java.available),
      arch: Process.arch,
      pointerSize: Process.pointerSize,
      hasTzim: hasTzim,
      nativeBridgeLikely: !hasTzim && hasX8664Art,
      modules: modules
    };
  }
};
"""
    script = session.create_script(code, runtime="v8")
    script.load()
    try:
        return script.exports_sync.probe()
    finally:
        try:
            script.unload()
        except Exception:
            pass


def run_adb(device_id: str, args: list[str]) -> None:
    subprocess.run(["adb", "-s", device_id, *args], check=False, capture_output=True, text=True, timeout=10)


def run_adb_text(device_id: str, args: list[str], timeout: float = 10) -> str:
    result = subprocess.run(
        ["adb", "-s", device_id, *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return result.stdout.strip()


def launch_app(device_id: str, package: str) -> None:
    subprocess.run(
        ["adb", "-s", device_id, "shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1"],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )


def wait_for_android_pid(device_id: str, package: str, timeout: float) -> int | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        output = run_adb_text(device_id, ["shell", "pidof", package], timeout=5)
        for part in output.split():
            if part.isdigit():
                return int(part)
        time.sleep(0.5)
    return None


def wait_for_frida_application_pid(device: frida.core.Device, package: str, timeout: float) -> int | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            for app in device.enumerate_applications():
                if getattr(app, "identifier", None) == package and getattr(app, "pid", 0):
                    return int(app.pid)
        except Exception:
            pass
        time.sleep(0.5)
    return None


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


if __name__ == "__main__":
    raise SystemExit(main())
