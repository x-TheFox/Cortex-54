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

import requests


@dataclass(frozen=True)
class Hop:
    provider: str  # nim | openrouter | groq | gemini
    model: str
    max_prompt_tokens: int  # skip this hop when the prompt is bigger (Groq's per-minute cap)
    timeout_s: int = 90


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
    hops: tuple[Hop, ...] = DEFAULT_CHAIN
    post: Callable[..., requests.Response] = requests.post
    clock: Callable[[], float] = time.monotonic
    cooldown_s: float = 90.0
    cooling: dict[str, float] = field(default_factory=dict)
    usage: dict[str, int] = field(default_factory=dict)  # "provider/model" → calls that produced the answer
    tokens: int = 0
    log: list[str] = field(default_factory=list)

    def available(self) -> list[Hop]:
        return [h for h in self.hops if os.environ.get(ENV_KEY[h.provider])]

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
            "max_tokens": max_out,
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
