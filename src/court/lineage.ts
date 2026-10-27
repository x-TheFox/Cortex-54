// Model lineage from a model name (dependency-free so the router can use it without the provider SDKs).
/** Rough model lineage from its id (for the "same family" warning; never used to block). */
export function lineage(model: string): string {
  const m = model.toLowerCase().split("/").pop() ?? "";
  const table: [RegExp, string][] = [
    [/claude|opus|sonnet|haiku|fable/, "anthropic"],
    [/^gpt-oss/, "openai-oss"],
    [/^(gpt|o\d|chatgpt)/, "openai"],
    [/gemini|gemma/, "google"],
    [/llama/, "meta"],
    [/qwen|qwq/, "qwen"],
    [/deepseek/, "deepseek"],
    [/mistral|mixtral|codestral|magistral/, "mistral"],
    [/nemotron/, "nvidia"],
    [/grok/, "xai"],
    [/kimi|moonshot/, "moonshot"],
    [/glm|chatglm/, "zhipu"],
    [/phi-?\d/, "microsoft"],
  ];
  return table.find(([re]) => re.test(m))?.[1] ?? m;
}
