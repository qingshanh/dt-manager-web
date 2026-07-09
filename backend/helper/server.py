from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import frida


ALLOWED_PATHS = {
    "/health",
    "/cached/request_private_number",
    "/debug/recent",
    "/execute",
    "/dingtone/execute",
    "/api/dingtone/execute",
    "/api/v1/dingtone/execute",
}


def load_project_env() -> None:
    env_path = Path(os.getenv("DT_ENV_FILE", "")).expanduser() if os.getenv("DT_ENV_FILE") else Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ[key] = value


class BridgeError(Exception):
    def __init__(self, message: str, status_code: int = 400, code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code if code is not None else status_code


@dataclass
class HelperConfig:
    bind_host: str
    bind_port: int
    auth_token: str
    device_mode: str
    device_id: str
    remote_host: str
    package_dingtone: str
    package_dingdong: str
    timeout_ms: int
    spawn_pause_ms: int
    agent_path: Path

    @classmethod
    def from_env(cls) -> "HelperConfig":
        load_project_env()
        base_dir = Path(__file__).resolve().parent
        return cls(
            bind_host=os.getenv("DT_HELPER_BIND_HOST", "127.0.0.1"),
            bind_port=int(os.getenv("DT_HELPER_PORT", "5175")),
            auth_token=os.getenv("DT_HELPER_TOKEN", "").strip(),
            device_mode=os.getenv("DT_HELPER_DEVICE_MODE", "usb").strip().lower(),
            device_id=os.getenv("DT_HELPER_DEVICE_ID", "").strip(),
            remote_host=os.getenv("DT_HELPER_REMOTE_HOST", "127.0.0.1:27042").strip(),
            package_dingtone=os.getenv("DT_HELPER_DINGTONE_PACKAGE", "me.talkyou.app.im").strip() or "me.talkyou.app.im",
            package_dingdong=os.getenv("DT_HELPER_DINGDONG_PACKAGE", "me.dingtone.app.im").strip() or "me.dingtone.app.im",
            timeout_ms=max(15_000, int(os.getenv("DT_HELPER_TIMEOUT_MS", "90000"))),
            spawn_pause_ms=max(500, int(os.getenv("DT_HELPER_SPAWN_PAUSE_MS", "1500"))),
            agent_path=base_dir / "frida_agent.js",
        )

    def resolve_package(self, payload: dict[str, Any]) -> str:
        app_variant = ""
        for candidate in iter_payload_records(payload):
            app_variant = str(candidate.get("appVariant") or candidate.get("app_variant") or "").strip().lower()
            if app_variant:
                break
        if app_variant == "dingdong":
            return self.package_dingdong
        return self.package_dingtone


def iter_payload_records(payload: dict[str, Any]):
    if not isinstance(payload, dict):
        return
    yield payload
    for key in ("input", "account", "payload"):
        value = payload.get(key)
        if isinstance(value, dict):
            yield value
            nested_account = value.get("account")
            if isinstance(nested_account, dict):
                yield nested_account


class PendingRequest:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.result: dict[str, Any] | None = None


SENSITIVE_DEBUG_KEYS = {
    "token",
    "logintoken",
    "login_token",
    "dttoken",
    "dt_token",
    "deviceid",
    "device_id",
    "wdeviceid",
    "wdevice_id",
}


def redact_debug_payload(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = str(key).replace("-", "_").lower()
            if normalized_key in SENSITIVE_DEBUG_KEYS:
                redacted[str(key)] = redact_secret(str(item))
                continue
            redacted[str(key)] = redact_debug_payload(item)
        return redacted
    if isinstance(value, list):
        return [redact_debug_payload(item) for item in value[:50]]
    if isinstance(value, str):
        return redact_debug_string(value)
    return value


def redact_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "<redacted>"
    return f"{value[:3]}***{value[-3:]}"


def redact_debug_string(value: str) -> str:
    text = value
    text = re.sub(r"token=[^,\s)&]+", "token=<redacted>", text, flags=re.IGNORECASE)
    text = re.sub(r"\b[0-9a-f]{32,}\b", "<redacted-hex>", text, flags=re.IGNORECASE)
    text = re.sub(r"\b\d{8,}\b", lambda match: f"{match.group(0)[:3]}***{match.group(0)[-2:]}", text)
    return text


class FridaBridge:
    def __init__(self, config: HelperConfig) -> None:
        self.config = config
        self._lock = threading.RLock()
        self._operation_lock = threading.Lock()
        self._session: frida.core.Session | None = None
        self._script: frida.core.Script | None = None
        self._attached_package: str | None = None
        self._compiled_agent_source: str | None = None
        self._compiled_agent_mtime_ns: int = 0
        self._compiler_project_root: Path | None = None
        self._pending: dict[str, PendingRequest] = {}
        self._latest_events: dict[str, dict[str, Any]] = {}
        self._recent_debug: list[dict[str, Any]] = []

    def get_cached_event(self, name: str) -> dict[str, Any] | None:
        return self._latest_events.get(name)

    def get_recent_debug(self, limit: int = 80) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._recent_debug[-max(1, min(limit, 200)) :])

    def _remember_debug(self, kind: str, payload: dict[str, Any]) -> None:
        entry = {
            "at": time.time(),
            "kind": kind,
            "payload": redact_debug_payload(payload),
        }
        with self._lock:
            self._recent_debug.append(entry)
            if len(self._recent_debug) > 200:
                self._recent_debug = self._recent_debug[-200:]

    def execute(self, action: str, payload: dict[str, Any], meta: dict[str, Any]) -> Any:
        if action == "get_cached_private_number_event":
            cached = self._latest_events.get("request_private_number")
            if cached:
                return cached["payload"]
            raise BridgeError("No cached request_private_number event is available", 404, 404)
        try:
            return self._execute_once(action, payload, meta)
        except BridgeError as error:
            if action in {"request_phone_number", "request_phone_number_via_activity"}:
                cached = self._latest_events.get("request_private_number")
                if cached and (time.time() - float(cached.get("at", 0))) <= 120:
                    print(f"[helper] use cached request_private_number after {action} failure", flush=True)
                    return cached["payload"]
            should_retry = error.status_code in {503, 504} and action not in {
                "login",
                "send_verification_code",
                "request_phone_number",
                "request_phone_number_via_activity",
            }
            if not should_retry:
                raise
            with self._lock:
                self._reset_session()
            try:
                return self._execute_once(action, payload, meta)
            except BridgeError:
                if action in {"request_phone_number", "request_phone_number_via_activity"}:
                    cached = self._latest_events.get("request_private_number")
                    if cached and (time.time() - float(cached.get("at", 0))) <= 120:
                        print(f"[helper] use cached request_private_number after retry failure", flush=True)
                        return cached["payload"]
                raise

    def _execute_once(self, action: str, payload: dict[str, Any], meta: dict[str, Any]) -> Any:
        package_name = self.config.resolve_package(payload)
        keep_session_alive = action == "send_verification_code"
        with self._operation_lock:
            try:
                print(f"[helper] start action={action} package={package_name}", flush=True)
                with self._lock:
                    print(f"[helper] ensure_agent action={action}", flush=True)
                    self._ensure_agent(package_name)
                    assert self._script is not None
                    request_id = uuid.uuid4().hex
                    pending = PendingRequest()
                    self._pending[request_id] = pending
                    timeout_ms = max(15_000, int(meta.get("timeoutMs") or self.config.timeout_ms))
                    try:
                        print(f"[helper] post action={action} request_id={request_id} timeout_ms={timeout_ms}", flush=True)
                        self._script.post(
                            {
                                "type": "bridge-command",
                                "payload": {
                                    "id": request_id,
                                    "action": action,
                                    "payload": payload,
                                    "meta": {
                                        "timeoutMs": timeout_ms,
                                        "serverIp": meta.get("serverIp"),
                                        "serverPort": meta.get("serverPort"),
                                        "backupIp": meta.get("backupIp"),
                                        "proxyUrl": meta.get("proxyUrl"),
                                        "appVersion": meta.get("appVersion"),
                                        "apkCertificateSign": meta.get("apkCertificateSign"),
                                    },
                                },
                            }
                        )
                    except Exception as error:
                        self._pending.pop(request_id, None)
                        raise BridgeError(f"Failed to send helper action {action}: {error}", 502, 502) from error

                print(f"[helper] wait action={action} request_id={request_id}", flush=True)
                if not pending.event.wait(timeout=(timeout_ms / 1000) + 5):
                    with self._lock:
                        self._pending.pop(request_id, None)
                        if not keep_session_alive:
                            self._reset_session()
                    raise BridgeError(f"Timed out waiting for helper action {action}", HTTPStatus.GATEWAY_TIMEOUT, 504)

                payload_result = pending.result or {}
                print(
                    f"[helper] finish action={action} request_id={request_id} ok={payload_result.get('ok')} "
                    f"error={((payload_result.get('error') or {}).get('message'))}",
                    flush=True,
                )
                if payload_result.get("ok"):
                    return payload_result.get("data")

                error = payload_result.get("error") or {}
                with self._lock:
                    if not keep_session_alive:
                        self._reset_session()
                raise BridgeError(
                    str(error.get("message") or f"Helper action {action} failed"),
                    int(error.get("statusCode") or 502),
                    int(error.get("code") or 502),
                )
            finally:
                with self._lock:
                    if not keep_session_alive:
                        self._reset_session()
                print(f"[helper] reset action={action} skipped={keep_session_alive}", flush=True)

    def _ensure_agent(self, package_name: str) -> None:
        if self._script is not None and self._attached_package == package_name:
            return
        self._reset_session()
        device = self._get_device()
        self._session = self._attach_or_spawn(device, package_name)
        source = self._get_compiled_agent_source()
        self._script = self._session.create_script(source)
        self._script.on("message", self._on_message)
        self._script.load()
        self._attached_package = package_name
        print(f"[helper] attached to {package_name}", flush=True)

    def _get_compiled_agent_source(self) -> str:
        source_mtime_ns = self.config.agent_path.stat().st_mtime_ns
        if self._compiled_agent_source is not None and self._compiled_agent_mtime_ns == source_mtime_ns:
            return self._compiled_agent_source

        try:
            compiler = frida.Compiler()
            compiled_source = compiler.build(
                self.config.agent_path.name,
                project_root=str(self.config.agent_path.parent),
            )
        except Exception as error:
            print("[helper] failed to compile frida agent", flush=True)
            traceback.print_exc()
            compiled_source = self._try_compile_agent_from_ascii_mirror(error)
            if compiled_source is not None:
                self._compiled_agent_source = compiled_source
                self._compiled_agent_mtime_ns = source_mtime_ns
                return compiled_source
            try:
                raw_source = self.config.agent_path.read_text(encoding="utf-8")
            except Exception as read_error:
                raise BridgeError(
                    f"Failed to compile the Frida agent and failed to read raw source: {read_error}",
                    500,
                    500,
                ) from read_error
            if "frida-java-bridge" in raw_source:
                raise BridgeError(
                    "Failed to compile the Frida agent. Run `npm install` in backend/helper "
                    "so frida-java-bridge is available, then restart the helper.",
                    500,
                    500,
                ) from error
            print("[helper] falling back to raw frida agent source", flush=True)
            compiled_source = raw_source

        self._compiled_agent_source = compiled_source
        self._compiled_agent_mtime_ns = source_mtime_ns
        return compiled_source

    def _try_compile_agent_from_ascii_mirror(self, original_error: Exception) -> str | None:
        mirror_root = self._ensure_ascii_compiler_project_root()
        if mirror_root is None:
            return None
        try:
            print(f"[helper] retry compile frida agent from ascii mirror {mirror_root}", flush=True)
            shutil.copy2(self.config.agent_path, mirror_root / self.config.agent_path.name)
            compiler = frida.Compiler()
            return compiler.build(self.config.agent_path.name, project_root=str(mirror_root))
        except Exception:
            print("[helper] failed to compile frida agent from ascii mirror", flush=True)
            traceback.print_exc()
            print(f"[helper] original compile error: {original_error}", flush=True)
            return None

    def _ensure_ascii_compiler_project_root(self) -> Path | None:
        if self._compiler_project_root is not None:
            return self._compiler_project_root

        preferred = Path(os.getenv("DT_HELPER_COMPILE_ROOT", "")).expanduser() if os.getenv("DT_HELPER_COMPILE_ROOT") else None
        candidates = [preferred] if preferred else []
        if os.name == "nt":
            candidates.extend([Path("C:/tmp/dt-helper-ascii"), Path("C:/tmp/dt-helper-ascii-compile")])
        else:
            candidates.append(Path(tempfile.gettempdir()) / "dt-manager-helper-frida-compile")

        for base_dir in [candidate for candidate in candidates if candidate is not None]:
            try:
                base_dir.mkdir(parents=True, exist_ok=True)
                source_modules = self.config.agent_path.parent / "node_modules"
                target_modules = base_dir / "node_modules"
                if source_modules.exists() and not target_modules.exists():
                    shutil.copytree(source_modules, target_modules)
                if not target_modules.exists():
                    print(f"[helper] ascii compiler project root lacks node_modules: {base_dir}", flush=True)
                    continue
                self._compiler_project_root = base_dir
                return base_dir
            except Exception:
                print(f"[helper] failed to prepare ascii compiler project root {base_dir}", flush=True)
                traceback.print_exc()
        return None

    def _reset_session(self) -> None:
        self._attached_package = None
        if self._script is not None:
            try:
                self._script.unload()
            except Exception:
                pass
            self._script = None
        if self._session is not None:
            try:
                self._session.detach()
            except Exception:
                pass
            self._session = None

    def _get_device(self) -> frida.core.Device:
        mode = self.config.device_mode
        try:
            if mode == "local":
                return frida.get_local_device()
            if mode == "remote":
                return frida.get_device_manager().add_remote_device(self.config.remote_host)
            if mode == "id":
                if not self.config.device_id:
                    raise BridgeError("DT_HELPER_DEVICE_ID is required when DT_HELPER_DEVICE_MODE=id", 500, 500)
                return frida.get_device(self.config.device_id, timeout=5)
            return frida.get_usb_device(timeout=5)
        except Exception as error:
            raise BridgeError(
                f"Unable to connect to Frida device ({mode}). Make sure a device/emulator is online and Frida is reachable: {error}",
                503,
                503,
            ) from error

    def _attach_or_spawn(self, device: frida.core.Device, package_name: str) -> frida.core.Session:
        try:
            return device.attach(package_name)
        except Exception:
            try:
                try:
                    for app in device.enumerate_applications():
                        if getattr(app, "identifier", None) == package_name and getattr(app, "pid", 0):
                            return device.attach(int(app.pid))
                except Exception:
                    pass
                pid = device.spawn([package_name])
                session = device.attach(pid)
                device.resume(pid)
                time.sleep(self.config.spawn_pause_ms / 1000)
                return session
            except Exception as error:
                raise BridgeError(
                    f"Unable to attach or spawn package {package_name}. Open the app once on the device and retry: {error}",
                    503,
                    503,
                ) from error

    def _on_message(self, message: dict[str, Any], _data: bytes | None) -> None:
        if message.get("type") == "send":
            payload = message.get("payload") or {}
            payload_type = payload.get("type")
            if payload_type == "bridge-log":
                self._remember_debug("log", payload)
                level = str(payload.get("level") or "info").upper()
                details = payload.get("data")
                if details is not None:
                    try:
                        details_text = json.dumps(details, ensure_ascii=False)
                    except Exception:
                        details_text = str(details)
                    print(f"[agent:{level}] {payload.get('message')} {details_text}", flush=True)
                else:
                    print(f"[agent:{level}] {payload.get('message')}", flush=True)
                return
            if payload_type == "bridge-event":
                name = str(payload.get("name") or "")
                if name:
                    self._remember_debug("event", payload)
                    self._latest_events[name] = {
                        "at": time.time(),
                        "payload": payload.get("data"),
                    }
                    print(f"[agent:EVENT] {name}", flush=True)
                return
            if payload_type == "bridge-result":
                request_id = str(payload.get("id") or "")
                with self._lock:
                    pending = self._pending.pop(request_id, None)
                if pending is not None:
                    pending.result = payload
                    pending.event.set()
                return
        if message.get("type") == "error":
            description = message.get("description") or "unknown Frida error"
            stack = message.get("stack")
            self._remember_debug("error", {"description": description, "stack": stack})
            print(f"[agent:ERROR] {description}")
            if stack:
                print(stack)


class RequestHandler(BaseHTTPRequestHandler):
    bridge: FridaBridge | None = None
    config: HelperConfig | None = None

    def do_GET(self) -> None:
        parsed_path = urlparse(self.path)
        if parsed_path.path == "/debug/recent":
            try:
                self._authorize()
                assert self.bridge is not None
                query = dict(item.split("=", 1) for item in parsed_path.query.split("&") if "=" in item)
                limit = int(query.get("limit", "80"))
                self._json_response(HTTPStatus.OK, {"ok": True, "data": self.bridge.get_recent_debug(limit)})
            except BridgeError as error:
                self._json_response(error.status_code, {"ok": False, "message": error.message, "code": error.code})
            except Exception as error:
                self._json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "message": str(error), "code": 500})
            return
        if parsed_path.path == "/cached/request_private_number":
            assert self.bridge is not None
            cached = self.bridge.get_cached_event("request_private_number")
            if not cached:
                self._json_response(HTTPStatus.NOT_FOUND, {"ok": False, "message": "No cached request_private_number event", "code": 404})
                return
            self._json_response(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "data": {
                        "cached_at": cached.get("at"),
                        "payload": cached.get("payload"),
                    },
                },
            )
            return
        if parsed_path.path != "/health":
            self._json_response(HTTPStatus.NOT_FOUND, {"ok": False, "message": "Not found", "code": 404})
            return
        self._json_response(
            HTTPStatus.OK,
            {
                "ok": True,
                "data": {
                    "status": "healthy",
                    "fridaVersion": getattr(frida, "__version__", "unknown"),
                    "deviceMode": self.config.device_mode if self.config else "unknown",
                },
            },
        )

    def do_POST(self) -> None:
        if self.path not in ALLOWED_PATHS or self.path == "/health":
            self._json_response(HTTPStatus.NOT_FOUND, {"ok": False, "message": "Not found", "code": 404})
            return

        try:
            self._authorize()
            body = self._read_json_body()
            action = str(body.get("action") or "").strip()
            payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
            meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
            if not action:
                raise BridgeError("Request body.action is required", 400, 400)
            assert self.bridge is not None
            result = self.bridge.execute(action, payload, meta)
            self._json_response(HTTPStatus.OK, {"ok": True, "data": result})
        except BridgeError as error:
            self._json_response(
                error.status_code,
                {
                    "ok": False,
                    "message": error.message,
                    "code": error.code,
                    "statusCode": error.status_code,
                },
            )
        except json.JSONDecodeError:
            self._json_response(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Body must be valid JSON", "code": 400})
        except Exception as error:
            print("[helper] unhandled error while processing request")
            traceback.print_exc()
            self._json_response(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "message": f"Unhandled helper error: {error}", "code": 500, "statusCode": 500},
            )

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _authorize(self) -> None:
        token = self.config.auth_token if self.config else ""
        if not token:
            return
        auth_header = self.headers.get("authorization", "")
        bridge_header = self.headers.get("x-dt-bridge-token", "")
        bearer = auth_header.removeprefix("Bearer ").strip()
        if token not in {bearer, bridge_header.strip()}:
            raise BridgeError("Unauthorized helper request", HTTPStatus.UNAUTHORIZED, 401)

    def _read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("content-length") or "0")
        raw = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        data = json.loads(raw or "{}")
        if not isinstance(data, dict):
            raise BridgeError("JSON body must be an object", 400, 400)
        return data

    def _json_response(self, status: int | HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(int(status))
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except BrokenPipeError:
            return
        except ConnectionAbortedError:
            return


def main() -> None:
    config = HelperConfig.from_env()
    if not config.agent_path.exists():
        raise SystemExit(f"Missing Frida agent: {config.agent_path}")

    bridge = FridaBridge(config)
    RequestHandler.bridge = bridge
    RequestHandler.config = config

    server = ThreadingHTTPServer((config.bind_host, config.bind_port), RequestHandler)
    print(
        f"[helper] listening on http://{config.bind_host}:{config.bind_port} "
        f"(device_mode={config.device_mode}, dingtone_pkg={config.package_dingtone}, dingdong_pkg={config.package_dingdong})"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[helper] shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
