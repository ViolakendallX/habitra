#!/usr/bin/env python
"""
sibyl_bridge.py - thin JSON-in / JSON-out wrapper around sibyl-memory-client.

This script is the only place the Node backend touches the Sibyl Memory SDK.
It is intentionally dumb: one operation per process invocation, a single JSON
request on stdin, a single JSON envelope on stdout. All feature-flagging,
tenant mapping, error swallowing, and business decisions live on the Node side
(see backend/src/services/memory.ts). This script contains NO secrets and logs
nothing sensitive (only to stderr, which the caller never parses).

Protocol
--------
stdin  : {"op": <op>, "db_path": <str>, "tenant_id": <str>, "args": {<op args>}}
stdout : {"ok": true,  "data": <json-serializable>}
         {"ok": false, "error": {"type": <str>, "message": <str>, "detail"?: <str>}}
stderr : logs / stack traces only (never parsed by the caller)
exit   : 0 on success or a known SDK/bridge error; 1 on unexpected failure

Supported ops (the STEP 9 foundation tier set):
  set_entity      -> category, name, body, [status]
  get_entity      -> category, name
  write_event     -> [evaluated], [acted], [forward], [extra], [ts]
  search_entities -> query, [limit], [prefix], [category]
  archive_entity  -> category, name, [reason]

Tenant isolation: the caller passes the Habitra userId as `tenant_id`. The SDK
enforces per-tenant isolation, so one user can never read another's memories.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

from sibyl_memory_client import (
    MemoryClient,
    NotFoundError,
    ValidationError,
    TenantError,
    SchemaError,
    StorageError,
    CapExceededError,
    SibylMemoryError,
)

# SDK exceptions we want to surface to Node with a stable, typed name.
# `except` with a tuple of exception classes is valid Python 3.
SDK_ERRORS = (
    NotFoundError,
    ValidationError,
    TenantError,
    SchemaError,
    StorageError,
    CapExceededError,
    SibylMemoryError,
)

SUPPORTED_OPS = {
    "set_entity",
    "get_entity",
    "write_event",
    "search_entities",
    "archive_entity",
}


def _emit_ok(data) -> None:
    sys.stdout.write(json.dumps({"ok": True, "data": data}, default=str))
    sys.stdout.write("\n")


def _emit_error(type_: str, message: str, detail: str | None = None) -> None:
    envelope = {"ok": False, "error": {"type": type_, "message": message}}
    if detail:
        envelope["error"]["detail"] = detail
    sys.stdout.write(json.dumps(envelope, default=str))
    sys.stdout.write("\n")


def _client(db_path: str, tenant_id: str) -> MemoryClient:
    # Sibyl manages the schema/migrations; we only need the directory to exist.
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    return MemoryClient.local(db_path, tenant_id=tenant_id)


def _run_op(op: str, db_path: str, tenant_id: str, args: dict) -> None:
    client = _client(db_path, tenant_id)

    if op == "set_entity":
        result = client.set_entity(
            args["category"],
            args["name"],
            args["body"],
            status=args.get("status"),
        )
        _emit_ok(result)
        return

    if op == "get_entity":
        result = client.get_entity(args["category"], args["name"])
        _emit_ok(result)
        return

    if op == "write_event":
        # evaluated/acted/forward/extra/ts are all optional; pass only provided.
        kwargs: dict = {}
        for key in ("evaluated", "acted", "forward", "extra", "ts"):
            if key in args and args[key] is not None:
                kwargs[key] = args[key]
        event_id = client.write_event(**kwargs)
        _emit_ok({"event_id": event_id})
        return

    if op == "search_entities":
        search_kwargs: dict = {}
        if args.get("limit") is not None:
            search_kwargs["limit"] = int(args["limit"])
        if args.get("prefix") is not None:
            search_kwargs["prefix"] = bool(args["prefix"])
        if args.get("category") is not None:
            search_kwargs["category"] = args["category"]
        results = client.search_entities(args["query"], **search_kwargs)
        # SearchResults is a list subclass; serialize the list plus a compact
        # verdict code (not the full Verdict object repr).
        raw_verdict = getattr(results, "verdict", None)
        if raw_verdict is not None:
            code = getattr(raw_verdict, "code", None)
            verdict_val = getattr(code, "value", None) if code is not None else str(raw_verdict)
        else:
            verdict_val = None
        _emit_ok({"results": list(results), "verdict": verdict_val})
        return

    if op == "archive_entity":
        result = client.archive_entity(
            args["category"],
            args["name"],
            reason=args.get("reason"),
        )
        _emit_ok(result)
        return

    # Unreachable: op validated before _run_op is called.
    _emit_error("UnknownOp", f"Unsupported op: {op!r}")


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        _emit_error("BridgeInputError", f"stdin was not valid JSON: {exc}")
        return 0

    if not isinstance(payload, dict):
        _emit_error("BridgeInputError", "stdin JSON must be an object")
        return 0

    op = payload.get("op")
    db_path = payload.get("db_path")
    tenant_id = payload.get("tenant_id")
    args = payload.get("args")

    if not isinstance(args, dict):
        _emit_error("BridgeInputError", "'args' must be an object")
        return 0
    if op not in SUPPORTED_OPS:
        _emit_error("BridgeInputError", f"missing or unsupported op: {op!r}")
        return 0
    if not isinstance(db_path, str) or not db_path:
        _emit_error("BridgeInputError", "'db_path' is required and must be a string")
        return 0
    if not isinstance(tenant_id, str) or not tenant_id:
        _emit_error("BridgeInputError", "'tenant_id' is required and must be a string")
        return 0

    try:
        _run_op(op, db_path, tenant_id, args)
        return 0
    except SDK_ERRORS as exc:
        # Known SDK error -> clean typed envelope, exit 0.
        _emit_error(type(exc).__name__, str(exc))
        return 0
    except Exception as exc:  # noqa: BLE001 - last-resort guard
        sys.stderr.write(traceback.format_exc())
        _emit_error("UnexpectedError", str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
