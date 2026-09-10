import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chat } from "../dist/index.js";

// Real HTTP against a mock OpenAI-compatible server. The router's Ollama
// provider URL is configurable, so this exercises the actual fetch code —
// only real provider credentials remain unverified (no key here validates).
function mockOpenAI(text, status = 200) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        assert.match(req.url, /chat\/completions/);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1` }));
  });
}

test("router completes via ollama-compatible endpoint over real HTTP", async () => {
  const { srv, url } = await mockOpenAI("hello free");
  try {
    const out = await chat({ OLLAMA_BASE_URL: url }, [{ role: "user", content: "hi" }]);
    assert.equal(out.text, "hello free");
    assert.equal(out.provider, "ollama");
  } finally {
    srv.close();
  }
});

test("router fails over groq(key bad)->ollama over real HTTP", async () => {
  const plan = '{"title_en":"T","confirm_en":"c","trigger_en":"m","steps":[]}';
  const { srv, url } = await mockOpenAI(plan);
  try {
    const out = await chat(
      { GROQ_API_KEY: "invalid-key-for-test", OLLAMA_BASE_URL: url },
      [{ role: "user", content: "hi" }]
    );
    assert.equal(out.provider, "ollama");
    assert.equal(out.text, plan);
  } finally {
    srv.close();
  }
});

test("router errors in plain terms when everything is down", async () => {
  const srv = http.createServer((_, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/v1`;
    await assert.rejects(chat({ OLLAMA_BASE_URL: url }, [{ role: "user", content: "hi" }]), /ollama/);
  } finally {
    srv.close();
  }
});
