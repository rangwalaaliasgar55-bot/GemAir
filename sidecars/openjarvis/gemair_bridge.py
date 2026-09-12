#!/usr/bin/env python3
"""JSON-lines bridge between GemAir's Electron main process and OpenJarvis.

The OpenJarvis source beside this file is Apache-2.0 licensed and pinned in
UPSTREAM_REVISION. This bridge is GemAir-specific integration code.
"""

from __future__ import annotations

import dataclasses
import enum
import json
import logging
import os
import sys
import traceback
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "src"
if SOURCE.is_dir() and str(SOURCE) not in sys.path:
    sys.path.insert(0, str(SOURCE))

# Stdout is protocol-only. Upstream logs remain available to the parent on stderr.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

MAX_QUERY_CHARS = 128_000
MAX_CONTEXT_ITEMS = 80
ALLOWED_AGENTS = {
    "simple",
    "orchestrator",
    "native_react",
    "operative",
    "monitor_operative",
    "deep_research",
}
SAFE_TOOLS = {
    "calculator",
    "think",
    "retrieval",
    "knowledge_search",
    "memory_search",
    "memory_store",
    "web_search",
}

_instances: dict[tuple[str, str], Any] = {}


def _jsonable(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return _jsonable(dataclasses.asdict(value))
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "__dict__"):
        return _jsonable(vars(value))
    return str(value)


def _bounded_text(value: Any, *, name: str = "text", limit: int = MAX_QUERY_CHARS) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be text")
    value = value.strip()
    if not value:
        raise ValueError(f"{name} is required")
    if len(value) > limit:
        raise ValueError(f"{name} exceeds {limit} characters")
    return value


def _safe_identifier(value: Any, *, fallback: str = "") -> str:
    text = str(value or fallback).strip()
    if text and (len(text) > 160 or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/-" for ch in text)):
        raise ValueError("invalid engine/model identifier")
    return text


def _jarvis(engine: str = "", model: str = "") -> Any:
    engine = _safe_identifier(engine)
    model = _safe_identifier(model)
    key = (engine, model)
    if key not in _instances:
        from openjarvis import Jarvis

        _instances[key] = Jarvis(engine_key=engine or None, model=model or None)
    return _instances[key]


def _context_prompt(query: str, context: Any) -> str:
    if not isinstance(context, list):
        return query
    rows: list[str] = []
    for item in context[-MAX_CONTEXT_ITEMS:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "user"))[:20]
        content = str(item.get("content", ""))[:16_000]
        if content:
            rows.append(f"{role}: {content}")
    if not rows:
        return query
    return "Conversation context:\n" + "\n".join(rows) + "\n\nCurrent request:\n" + query


def op_health(_: dict[str, Any]) -> dict[str, Any]:
    import openjarvis

    try:
        from openjarvis._rust_bridge import RUST_AVAILABLE
    except Exception:
        RUST_AVAILABLE = False
    try:
        mcp_config = _configured_mcp()
        mcp_configured = bool(mcp_config.enabled and mcp_config.servers)
    except Exception:
        mcp_configured = False
    return {
        "ok": True,
        "openjarvisVersion": openjarvis.__version__,
        "pythonVersion": sys.version.split()[0],
        "rustAvailable": bool(RUST_AVAILABLE),
        "sourceRevision": "b1055c983b25b298c7e97723847d215df18de4a8",
        "telemetryEnabled": False,
        "analyticsEnabled": False,
        "operations": [
            "ask",
            "plan",
            "research",
            "memory_search",
            "memory_store",
            "scan",
            "capabilities",
            "mcp_discover",
        ],
        "agents": sorted(ALLOWED_AGENTS),
        "safeTools": sorted(SAFE_TOOLS),
        "mcp": {"available": True, "configured": mcp_configured, "defaultDeny": True},
        "sandbox": {"available": True, "enabled": False, "network": "none"},
        "capabilityPolicy": {"enabled": True, "defaultDeny": True},
        "guardrails": {"enabled": True, "mode": "redact"},
    }


def _ask(payload: dict[str, Any], *, planning: bool = False) -> dict[str, Any]:
    query = _bounded_text(payload.get("query"), name="query")
    engine = _safe_identifier(payload.get("engine"))
    model = _safe_identifier(payload.get("model"))
    agent = str(payload.get("agent") or ("orchestrator" if planning else "orchestrator"))
    if agent not in ALLOWED_AGENTS:
        raise ValueError(f"agent is not allowed: {agent}")
    requested_tools = payload.get("tools")
    if not isinstance(requested_tools, list):
        requested_tools = ["think", "calculator", "retrieval"]
    tools = [str(tool) for tool in requested_tools if str(tool) in SAFE_TOOLS][:12]
    # The SDK integration recognizes this internal sentinel and loads only the
    # explicitly configured MCP server's discovered tools. It is never accepted
    # as an arbitrary tool name from callers.
    if payload.get("useMcp") is True:
        tools.append("__mcp__")
    prompt = _context_prompt(query, payload.get("context"))
    if planning:
        prompt = (
            "Analyze the request before execution. Produce a concise implementation brief with: "
            "objective, assumptions, ordered subproblems, relevant evidence or memory to retrieve, "
            "risks, and a verification checklist. Do not claim actions were performed.\n\n" + prompt
        )
    result = _jarvis(engine, model).ask_full(
        prompt,
        model=model or None,
        agent=agent,
        tools=tools,
        temperature=max(0.0, min(2.0, float(payload.get("temperature", 0.35 if planning else 0.6)))),
        max_tokens=max(64, min(8192, int(payload.get("maxTokens", 1800 if planning else 3000)))),
        context=payload.get("memory", True) is not False,
    )
    normalized = _jsonable(result)
    return {
        "ok": True,
        "content": str(normalized.get("content", "")),
        "usage": normalized.get("usage", {}),
        "toolResults": normalized.get("tool_results", []),
        "turns": normalized.get("turns", 1),
        "model": normalized.get("model", model),
        "engine": normalized.get("engine", engine),
        "planning": planning,
    }


def op_ask(payload: dict[str, Any]) -> dict[str, Any]:
    return _ask(payload, planning=False)


def op_plan(payload: dict[str, Any]) -> dict[str, Any]:
    return _ask(payload, planning=True)


def op_research(payload: dict[str, Any]) -> dict[str, Any]:
    """Run OpenJarvis's cited multi-hop researcher with retrieval-only tools."""
    bounded = dict(payload)
    bounded["agent"] = "deep_research"
    bounded["tools"] = ["knowledge_search", "retrieval", "web_search", "think"]
    bounded["maxTokens"] = max(256, min(8192, int(payload.get("maxTokens", 4096))))
    result = _ask(bounded, planning=False)
    result["research"] = True
    return result


def _configured_mcp() -> Any:
    from openjarvis.core.config import load_config

    config_file = Path(os.environ.get("OPENJARVIS_HOME", str(Path.home() / ".openjarvis"))) / "config.toml"
    return load_config(config_file).tools.mcp


def op_mcp_discover(_: dict[str, Any]) -> dict[str, Any]:
    """Connect to the explicitly allowlisted loopback MCP and list its tools."""
    from openjarvis.mcp.loader import load_mcp_tools_from_config

    config = _configured_mcp()
    clients: list[Any] = []
    try:
        tools, clients = load_mcp_tools_from_config(config, allowed_names=None)
        return {
            "ok": True,
            "configured": bool(config.enabled and config.servers),
            "tools": [
                {
                    "name": str(tool.spec.name),
                    "description": str(tool.spec.description)[:1000],
                    "parameters": _jsonable(tool.spec.parameters),
                    "annotations": _jsonable(tool.spec.metadata.get("mcp_annotations", {})),
                    "eligibleForReasoning": (
                        tool.spec.metadata.get("mcp_annotations", {}).get("readOnlyHint") is True
                        and tool.spec.metadata.get("mcp_annotations", {}).get("destructiveHint") is False
                    ),
                }
                for tool in tools[:100]
            ],
        }
    finally:
        for client in clients:
            try:
                client.close()
            except Exception:
                pass


def op_capabilities(_: dict[str, Any]) -> dict[str, Any]:
    """Report source modules separately from locally ready dependencies."""
    import shutil

    modules: dict[str, bool] = {}
    for name, module in {
        "mcp": "openjarvis.mcp",
        "guardrails": "openjarvis.security.guardrails",
        "sandbox": "openjarvis.sandbox",
        "memory": "openjarvis.memory",
        "deepResearch": "openjarvis.agents.deep_research",
    }.items():
        try:
            __import__(module)
            modules[name] = True
        except Exception:
            modules[name] = False
    runtime = "docker" if shutil.which("docker") else ("podman" if shutil.which("podman") else "")
    try:
        mcp_config = _configured_mcp()
        mcp_configured = bool(mcp_config.enabled and mcp_config.servers)
    except Exception:
        mcp_configured = False
    return {
        "ok": True,
        "modules": modules,
        "mcp": {
            "available": modules["mcp"],
            "configured": mcp_configured,
            "transportPolicy": "loopback HTTP(S) only",
            "note": "No MCP server is trusted until the user enables a loopback URL in GemAir.",
        },
        "sandbox": {
            "available": modules["sandbox"],
            "runtime": runtime,
            "ready": bool(runtime),
            "network": "none",
            "mountPolicy": "default-deny/read-only",
        },
        "capabilityPolicy": {
            "enabled": True,
            "defaultDeny": True,
            "hostPermissionGateAuthoritative": True,
        },
        "guardrails": {"enabled": modules["guardrails"], "mode": "redact"},
    }


def op_memory_search(payload: dict[str, Any]) -> dict[str, Any]:
    query = _bounded_text(payload.get("query"), name="query", limit=16_000)
    top_k = max(1, min(25, int(payload.get("topK", 5))))
    results = _jarvis(_safe_identifier(payload.get("engine")), _safe_identifier(payload.get("model"))).memory.search(query, top_k=top_k)
    return {"ok": True, "results": _jsonable(results)}


def op_memory_store(payload: dict[str, Any]) -> dict[str, Any]:
    text = _bounded_text(payload.get("text"), limit=64_000)
    source = str(payload.get("source") or "gemair")[:512]
    jarvis = _jarvis(_safe_identifier(payload.get("engine")), _safe_identifier(payload.get("model")))
    backend = jarvis.memory._get_backend()  # OpenJarvis has no public single-text store API.
    doc_id = backend.store(text, source=source, metadata={"origin": "gemair"})
    # Never reuse the protocol envelope's `id`; doing so would orphan the
    # Electron request waiting on its numeric correlation id.
    return {"ok": True, "memoryId": str(doc_id)}


def _finding(value: Any) -> dict[str, Any]:
    return {
        "pattern": str(getattr(value, "pattern_name", "")),
        "matchedText": str(getattr(value, "matched_text", ""))[:100],
        "threatLevel": str(getattr(getattr(value, "threat_level", ""), "value", getattr(value, "threat_level", ""))),
        "start": int(getattr(value, "start", 0)),
        "end": int(getattr(value, "end", 0)),
        "description": str(getattr(value, "description", "")),
    }


def op_scan(payload: dict[str, Any]) -> dict[str, Any]:
    text = _bounded_text(payload.get("text"), limit=64_000)
    from openjarvis.security.injection_scanner import InjectionScanner

    injection = InjectionScanner().scan(text)
    findings = [_finding(item) for item in injection.findings]
    rust_available = False
    try:
        from openjarvis._rust_bridge import RUST_AVAILABLE

        rust_available = bool(RUST_AVAILABLE)
        if rust_available:
            from openjarvis.security.scanner import PIIScanner, SecretScanner

            findings.extend(_finding(item) for item in SecretScanner().scan(text).findings)
            if payload.get("includePii") is True:
                findings.extend(_finding(item) for item in PIIScanner().scan(text).findings)
    except Exception as exc:
        logging.warning("Extended OpenJarvis scan unavailable: %s", exc)
    order = {"low": 1, "medium": 2, "high": 3, "critical": 4}
    threat = max((str(item["threatLevel"]).lower() for item in findings), key=lambda item: order.get(item, 0), default="low")
    return {"ok": True, "clean": not findings, "threatLevel": threat, "findings": findings, "rustAvailable": rust_available}


OPERATIONS = {
    "health": op_health,
    "ask": op_ask,
    "plan": op_plan,
    "research": op_research,
    "memory_search": op_memory_search,
    "memory_store": op_memory_store,
    "scan": op_scan,
    "capabilities": op_capabilities,
    "mcp_discover": op_mcp_discover,
}


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    operation = str(request.get("op") or "")
    handler = OPERATIONS.get(operation)
    if handler is None:
        raise ValueError(f"unsupported operation: {operation}")
    return handler(request)


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    for line in sys.stdin:
        request_id: Any = None
        try:
            if len(line) > 1_000_000:
                raise ValueError("bridge request is too large")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("bridge request must be an object")
            request_id = request.get("id")
            emit({"id": request_id, **dispatch(request)})
        except Exception as exc:  # Keep the bridge alive; return a bounded diagnostic.
            logging.debug("OpenJarvis bridge request failed\n%s", traceback.format_exc())
            emit({
                "id": request_id,
                "ok": False,
                "error": type(exc).__name__,
                "message": str(exc)[:1000],
            })
    for instance in _instances.values():
        try:
            instance.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
