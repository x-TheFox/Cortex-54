"""Free LLM chain for the research agent. Each step tries providers in order and moves on when one throttles, errors,
times out or returns something that is not a JSON object; a throttled provider cools down for a while.

Verified 2026-10-24: NIM nemotron-3-ultra (≈3 s, clean JSON), OpenRouter nemotron-3-ultra:free (≈13 s), Groq
gpt-oss-120b (8K tokens/min cap, so only small prompts), Gemini 3.5 Flash via the Interactions API (no search
grounding on the free tier). NIM deepseek-v4.1-flash timed out at 120 s, so it is not in the chain.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import anthropic
import requests


@dataclass(frozen=True)
class Hop:
    provider: str  # nim | openrouter | groq | gemini | ep:<id> (one of the user's own endpoints, ADR-072)
    model: str
    max_prompt_tokens: int  # skip this hop when the prompt is bigger (Groq's per-minute cap)
    timeout_s: int = 90
    # the user's own endpoint (model pool): format, base URL and key travel with the hop
    fmt: str = ""  # "openai" | "anthropic"
    base_url: str = ""
    api_key: str = ""


DEFAULT_CHAIN: tuple[Hop, ...] = (
    Hop("nim", "nvidia/nemotron-3-ultra-550b-a55b", 60_000, 120),
    Hop("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", 60_000),
    Hop("gemini", "gemini-3.5-flash", 200_000, 120),
    Hop("groq", "openai/gpt-oss-120b", 6_000),
    Hop("groq", "openai/gpt-oss-20b", 6_000),
)

ENV_KEY = {"nim": "NVIDIA_API_KEY", "openrouter": "OPENROUTER_API_KEY", "groq": "GROQ_API_KEY", "gemini": "GEMINI_API_KEY"}
BASE = {
    "nim": "https://integrate.api.nvidia.com/v1/chat/completions",
    "openrouter": "https://openrouter.ai/api/v1/chat/completions",
    "groq": "https://api.groq.com/openai/v1/chat/completions",
}


def pool_hops(raw: str | None) -> tuple[tuple[Hop, ...], tuple[Hop, ...], str]:
    """The user's model pool (LLM_POOL JSON, ADR-072) as research hops: (free/local hops, paid hops, preference).
    A malformed pool is ignored whole, like the brain does."""
    if not raw:
        return (), (), "free_first"
    try:
        cfg = json.loads(raw)
        free: list[Hop] = []
        paid: list[Hop] = []
        for e in cfg.get("endpoints") or []:
            if not e.get("enabled", True) or e.get("format") not in ("openai", "anthropic"):
                continue
            url = str(e.get("url") or "").rstrip("/")
            if not url.startswith(("http://", "https://")):
                continue
            tier = e.get("tier") or "paid"
            for m in e.get("models") or []:
                hop = Hop(f"ep:{e.get('id')}", str(m), 24_000 if tier == "local" else 100_000, 180,
                          e["format"], url, str(e.get("key") or ""))
                (paid if tier == "paid" else free).append(hop)
        return tuple(free), tuple(paid), str((cfg.get("prefs") or {}).get("prefer") or "free_first")
    except (ValueError, TypeError, KeyError, AttributeError):
        return (), (), "free_first"


def default_chain() -> tuple[Hop, ...]:
    """Built-in free hops plus the user's pool, in the user's order: paid first only when they asked for it."""
    free, paid, prefer = pool_hops(os.environ.get("LLM_POOL"))
    if prefer == "paid_first":
        return paid + DEFAULT_CHAIN + free
    return DEFAULT_CHAIN + free + paid


def est_tokens(text: str) -> int:
    return len(text) // 4 + 1


def extract_json(text: str) -> dict[str, Any] | None:
    """First balanced JSON object in a reply (models wrap JSON in prose or ``` fences)."""
    if not text:
        return None
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    start = text.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start : i + 1], strict=False)
                        return obj if isinstance(obj, dict) else None
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    return None


@dataclass
class Chain:
    hops: tuple[Hop, ...] = field(default_factory=default_chain)
    post: Callable[..., requests.Response] = requests.post
    clock: Callable[[], float] = time.monotonic
    cooldown_s: float = 90.0
    cooling: dict[str, float] = field(default_factory=dict)
    usage: dict[str, int] = field(default_factory=dict)  # "provider/model" → calls that produced the answer
    tokens: int = 0
    log: list[str] = field(default_factory=list)

    def available(self) -> list[Hop]:
        return [h for h in self.hops if h.base_url or os.environ.get(ENV_KEY.get(h.provider, ""), "")]

    def ask(self, system: str, user: str, max_out: int = 2500) -> tuple[dict[str, Any] | None, str | None]:
        """(json reply, "provider/model") from the first hop that answers, or (None, None)."""
        prompt_tokens = est_tokens(system) + est_tokens(user)
        for hop in self.available():
            name = f"{hop.provider}/{hop.model}"
            if prompt_tokens > hop.max_prompt_tokens or self.cooling.get(name, 0) > self.clock():
                continue
            try:
                text, used = self._call(hop, system, user, max_out)
            except requests.HTTPError as e:
                code = e.response.status_code if e.response is not None else 0
                self.log.append(f"{name}: HTTP {code}")
                if code in (429, 503, 529) or code >= 500:
                    self.cooling[name] = self.clock() + self.cooldown_s
                continue
            except anthropic.APIStatusError as e:
                self.log.append(f"{name}: HTTP {e.status_code}")
                if e.status_code in (429, 503, 529) or e.status_code >= 500:
                    self.cooling[name] = self.clock() + self.cooldown_s
                continue
            except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
                self.log.append(f"{name}: {type(e).__name__}")
                self.cooling[name] = self.clock() + self.cooldown_s / 3
                continue
            except (requests.RequestException, ValueError, KeyError) as e:
                self.log.append(f"{name}: {type(e).__name__}")
                self.cooling[name] = self.clock() + self.cooldown_s / 3
                continue
            obj = extract_json(text)
            if obj is None:
                self.log.append(f"{name}: no JSON object")
                continue
            self.tokens += used or prompt_tokens
            self.usage[name] = self.usage.get(name, 0) + 1
            return obj, name
        return None, None

    def _call(self, hop: Hop, system: str, user: str, max_out: int) -> tuple[str, int]:
        if hop.base_url:
            return self._call_endpoint(hop, system, user, max_out)
        key = os.environ[ENV_KEY[hop.provider]]
        if hop.provider == "gemini":
            r = self.post(
                "https://generativelanguage.googleapis.com/v1beta/interactions",
                headers={"x-goog-api-key": key, "content-type": "application/json"},
                json={"model": hop.model, "system_instruction": system, "input": user,
                      "generation_config": {"max_output_tokens": max_out, "temperature": 0.3}},
                timeout=hop.timeout_s,
            )
            r.raise_for_status()
            d = r.json()
            texts = [o.get("text", "") for o in d.get("outputs", []) if o.get("type") == "text"]
            return "".join(texts), int((d.get("usage") or {}).get("total_tokens") or 0)
        body: dict[str, Any] = {
            "model": hop.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            # NIM's Nemotron reasons before answering; at 1.5-2.5K tokens the JSON was often cut off (canary 2026-10-26)
            "max_tokens": max(max_out, 6000) if hop.provider == "nim" else max_out,
            "temperature": 0.3,
        }
        if hop.provider in ("groq", "nim"):
            body["response_format"] = {"type": "json_object"}
        if hop.provider == "groq":
            body["reasoning_effort"] = "low"
        r = self.post(BASE[hop.provider], headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
                      json=body, timeout=hop.timeout_s)
        r.raise_for_status()
        d = r.json()
        msg = d["choices"][0]["message"]
        return msg.get("content") or "", int((d.get("usage") or {}).get("total_tokens") or 0)

    def _call_endpoint(self, hop: Hop, system: str, user: str, max_out: int) -> tuple[str, int]:
        """One of the user's own endpoints (ADR-072): Anthropic-compatible via the official SDK, else OpenAI-compatible."""
        if hop.fmt == "anthropic":
            client = anthropic.Anthropic(api_key=hop.api_key or "none", base_url=hop.base_url, max_retries=0,
                                         timeout=hop.timeout_s)
            msg = client.messages.create(
                model=hop.model,
                max_tokens=max(max_out, 16_000),  # thinking (on by default on current models) counts against it
                system=f"{system}\n\nReply with ONE JSON object and nothing else.",
                messages=[{"role": "user", "content": user}],
            )
            if msg.stop_reason == "refusal":
                raise ValueError("refused")
            text = "".join(b.text for b in msg.content if b.type == "text")
            return text, int(msg.usage.input_tokens + msg.usage.output_tokens)
        headers = {"content-type": "application/json"}
        if hop.api_key:
            headers["authorization"] = f"Bearer {hop.api_key}"
        body: dict[str, Any] = {
            "model": hop.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": max(max_out, 4096),
            "response_format": {"type": "json_object"},
        }
        r = self.post(f"{hop.base_url}/chat/completions", headers=headers, json=body, timeout=hop.timeout_s)
        if r.status_code == 400:  # an unknown server may reject JSON mode or max_tokens: one plain retry
            body.pop("response_format", None)
            body["max_completion_tokens"] = body.pop("max_tokens")
            r = self.post(f"{hop.base_url}/chat/completions", headers=headers, json=body, timeout=hop.timeout_s)
        r.raise_for_status()
        d = r.json()
        return d["choices"][0]["message"].get("content") or "", int((d.get("usage") or {}).get("total_tokens") or 0)
