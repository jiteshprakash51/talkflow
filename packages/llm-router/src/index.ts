/**
 * TalkFlow free LLM router — $0 inference with automatic failover.
 * Order: Groq > Cerebras > Gemini > Mistral > NVIDIA NIM > OpenRouter:free > Workers AI > Ollama local.
 * All providers are OpenAI-compatible except Gemini (native) and Workers AI (binding).
 * No API key = still works via Ollama local fallback.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RouterEnv {
  GROQ_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  GEMINI_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
  AI?: { run(model: string, input: unknown): Promise<unknown> }; // Cloudflare Workers AI binding
  fetchFn?: typeof fetch;
}

export interface RouterResult {
  text: string;
  provider: string;
  model: string;
}

interface Provider {
  name: string;
  model: string;
  available: (env: RouterEnv) => boolean;
  call: (env: RouterEnv, messages: ChatMessage[]) => Promise<string>;
}

async function openAIChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  fetchFn: typeof fetch,
  extraHeaders: Record<string, string> = {}
): Promise<string> {
  const res = await fetchFn(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 1500 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("empty completion");
  return text;
}

const PROVIDERS: Provider[] = [
  {
    name: "groq",
    model: "llama-3.3-70b-versatile",
    available: (e) => !!e.GROQ_API_KEY,
    call: (e, m) =>
      openAIChat("https://api.groq.com/openai/v1", e.GROQ_API_KEY!, "llama-3.3-70b-versatile", m, e.fetchFn ?? fetch),
  },
  {
    name: "cerebras",
    model: "llama-3.3-70b",
    available: (e) => !!e.CEREBRAS_API_KEY,
    call: (e, m) =>
      openAIChat("https://api.cerebras.ai/v1", e.CEREBRAS_API_KEY!, "llama-3.3-70b", m, e.fetchFn ?? fetch),
  },
  {
    name: "gemini",
    model: "gemini-2.5-flash",
    available: (e) => !!e.GEMINI_API_KEY,
    call: async (e, m) => {
      const fetchFn = e.fetchFn ?? fetch;
      const system = m.filter((x) => x.role === "system").map((x) => x.content).join("\n");
      const contents = m
        .filter((x) => x.role !== "system")
        .map((x) => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.content }] }));
      // Try current free models in order — names rotate fast, fail over automatically
      const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
      let lastErr = "";
      for (const model of models) {
        const res = await fetchFn(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${e.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ system_instruction: system ? { parts: [{ text: system }] } : undefined, contents }),
            signal: AbortSignal.timeout(25000),
          }
        );
        if (res.ok) {
          const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
          if (text) return text;
          lastErr = "empty gemini completion";
          continue;
        }
        lastErr = `Gemini ${model} HTTP ${res.status}`;
      }
      throw new Error(lastErr);
    },
  },
  {
    name: "mistral",
    model: "mistral-small-latest",
    available: (e) => !!e.MISTRAL_API_KEY,
    call: (e, m) =>
      openAIChat("https://api.mistral.ai/v1", e.MISTRAL_API_KEY!, "mistral-small-latest", m, e.fetchFn ?? fetch),
  },
  {
    name: "nvidia",
    model: "meta/llama-3.3-70b-instruct",
    available: (e) => !!e.NVIDIA_API_KEY,
    call: (e, m) =>
      openAIChat("https://integrate.api.nvidia.com/v1", e.NVIDIA_API_KEY!, "meta/llama-3.3-70b-instruct", m, e.fetchFn ?? fetch),
  },
  {
    name: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    available: (e) => !!e.OPENROUTER_API_KEY,
    call: (e, m) =>
      openAIChat("https://openrouter.ai/api/v1", e.OPENROUTER_API_KEY!, "meta-llama/llama-3.3-70b-instruct:free", m, e.fetchFn ?? fetch, {
        "HTTP-Referer": "https://talkflow.local",
        "X-Title": "TalkFlow",
      }),
  },
  {
    name: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    available: (e) => !!e.AI,
    call: async (e, m) => {
      const out = (await e.AI!.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: m })) as {
        response?: string;
      };
      if (!out?.response) throw new Error("empty workers-ai completion");
      return out.response;
    },
  },
  {
    name: "ollama",
    model: "qwen2.5:7b",
    available: () => true, // always last resort
    call: (e, m) =>
      openAIChat(e.OLLAMA_BASE_URL ?? "http://localhost:11434/v1", "ollama", "qwen2.5:7b", m, e.fetchFn ?? fetch),
  },
];

export async function chat(env: RouterEnv, messages: ChatMessage[]): Promise<RouterResult> {
  const errors: string[] = [];
  for (const p of PROVIDERS) {
    if (!p.available(env)) continue;
    try {
      const text = await p.call(env, messages);
      return { text, provider: p.name, model: p.model };
    } catch (err) {
      errors.push(`${p.name}: ${(err as Error).message}`);
      continue; // fail over to next free provider
    }
  }
  throw new Error(`All free providers failed. ${errors.join(" | ")}. Tip: docker exec ollama ollama pull qwen2.5:7b`);
}

export function freeProvidersStatus(env: RouterEnv): Array<{ name: string; configured: boolean; model: string }> {
  return PROVIDERS.map((p) => ({ name: p.name, configured: p.available(env), model: p.model }));
}
