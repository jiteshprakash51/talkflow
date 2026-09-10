import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

interface Msg { from: "you" | "flow"; text: string }
interface Flow { id: string; title_en: string; status: string }
interface Conn { provider: string; label: string }
interface Run { id: string; flow_id: string; status: string; output_summary_en: string; created_at: number }
interface Template { id: string; title_en: string; description_en: string; say_to_use_en: string }
interface Usage {
  spent_usd: number; calls_today_by_provider: Record<string, number>;
  you_today: { chats: number; runs: number };
  limits: { chats_per_user_per_day: number; runs_per_user_per_day: number };
}

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_URL ?? "";
const OUTBOX_KEY = "talkflow-outbox";

async function post(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function get(path: string) {
  return fetch(`${API}${path}`).then((x) => x.json());
}

function loadOutbox(): string[] {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? "[]") as string[]; }
  catch { return []; }
}
function saveOutbox(q: string[]) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)); } catch { /* private mode */ }
}

function useSpeech(setInput: (s: string) => void) {
  return () => {
    const w = window as unknown as { SpeechRecognition?: new () => { lang: string; onresult: (e: { results: Array<Array<{ transcript: string }>> }) => void; start: () => void }; webkitSpeechRecognition?: new () => { lang: string; onresult: (e: { results: Array<Array<{ transcript: string }>> }) => void; start: () => void } };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) { alert("Voice not supported in this browser — type instead."); return; }
    const rec = new SR();
    rec.lang = "en-US";
    rec.onresult = (e) => setInput(e.results[0][0].transcript);
    rec.start();
  };
}

function App() {
  const [msgs, setMsgs] = useState<Msg[]>([
    { from: "flow", text: "Hi! I'm TalkFlow — free automation. Try a template below with one tap, or tap 🎤 and just say it." },
  ]);
  const [input, setInput] = useState("");
  const [flows, setFlows] = useState<Flow[]>([]);
  const [conns, setConns] = useState<Conn[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiUrl, setApiUrl] = useState("");
  const [showBuilder, setShowBuilder] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [queued, setQueued] = useState(loadOutbox().length);
  const bottom = useRef<HTMLDivElement>(null);
  const mic = useSpeech(setInput);

  const say = (text: string) => setMsgs((m) => [...m, { from: "flow", text }]);

  const refresh = async () => {
    try {
      const [f, cn, r, t, u] = await Promise.all([
        get("/api/flows").catch(() => null),
        get("/api/connections").catch(() => null),
        get("/api/runs").catch(() => null),
        get("/api/templates").catch(() => null),
        get("/api/usage?user_id=local").catch(() => null),
      ]);
      if (f?.flows) setFlows(f.flows);
      if (cn?.connections) setConns(cn.connections);
      if (r?.runs) setRuns(r.runs.slice(0, 8));
      if (t?.templates) setTemplates(t.templates);
      if (u?.ok) setUsage(u);
    } catch { /* offline */ }
  };

  const deliver = async (text: string): Promise<void> => {
    setMsgs((m) => [...m, { from: "you", text }]);
    try {
      const r = await post("/api/chat", { text }) as { reply_en?: string };
      say(r.reply_en ?? "Hmm, no answer. Try again.");
      void refresh();
      try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance((r.reply_en ?? "").slice(0, 200))); } catch { /* noop */ }
    } catch {
      const q = [...loadOutbox(), text];
      saveOutbox(q); setQueued(q.length);
      say(`You're offline — I saved that (${q.length} waiting). It will send when you're back.`);
    }
  };

  const flushOutbox = async () => {
    const q = loadOutbox();
    if (!q.length || !navigator.onLine) return;
    saveOutbox([]); setQueued(0);
    say(`Back online — sending ${q.length} saved message${q.length > 1 ? "s" : ""}…`);
    for (const text of q) await deliver(text);
  };

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    void refresh();
    void flushOutbox();
    const on = () => { setOnline(true); void flushOutbox(); void refresh(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (!navigator.onLine) {
      const q = [...loadOutbox(), text];
      saveOutbox(q); setQueued(q.length);
      setMsgs((m) => [...m, { from: "you", text }]);
      say(`You're offline — saved (${q.length} waiting).`);
      return;
    }
    setBusy(true);
    await deliver(text);
    setBusy(false);
  };

  const connectGoogle = async () => {
    try {
      const r = await get("/api/auth/google/url?user_id=local") as { ok: boolean; url?: string; reply_en?: string };
      if (r.url) window.open(r.url, "_blank");
      else say(r.reply_en ?? "Google login isn't set up yet.");
    } catch { say("API not reachable."); }
  };

  const buildConnector = async () => {
    if (!apiUrl.trim()) return;
    setBusy(true);
    try {
      const r = await post("/api/connectors/generate", { openapi_url: apiUrl.trim() }) as { ok: boolean; reply_en?: string };
      say(r.reply_en ?? "Done.");
      setApiUrl(""); setShowBuilder(false);
    } catch { say("Couldn't build that connector. Paste docs text via API instead."); }
    setBusy(false);
  };

  const useTemplate = async (id: string) => {
    setBusy(true);
    try {
      const r = await post(`/api/templates/${id}/use`, { user_id: "local" }) as { reply_en?: string };
      say(r.reply_en ?? "Ready. Say 'ok' to start.");
    } catch { say("API not reachable."); }
    setBusy(false);
  };

  const runFlow = async (id: string) => {
    await post(`/api/flows/${id}/run`, {});
    say("Started! I'll tell you what happens.");
    void refresh();
  };

  const connected = (p: string) => conns.some((c) => c.provider === p);

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", fontFamily: "system-ui", padding: 12, background: "#f0fdf4", minHeight: "100vh" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 22, margin: "8px 0" }}>💬 TalkFlow <span style={{ fontWeight: 400, fontSize: 14 }}>$0 · just say it</span></h1>
        <span style={{ fontSize: 12 }}>{online ? "🟢 online" : `🟠 offline${queued ? ` (${queued} queued)` : ""}`}</span>
      </header>

      <section style={{ background: "#fff", borderRadius: 12, padding: 10, marginBottom: 10 }}>
        <b>🔌 Connections</b>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", fontSize: 13 }}>
          <span style={{ padding: "4px 10px", borderRadius: 12, background: connected("google") ? "#dcfce7" : "#fee2e2" }}>
            Gmail+Sheets {connected("google") ? "✅" : "❌"}
          </span>
          {!connected("google") && <button onClick={() => void connectGoogle()}>Connect Google</button>}
          <button onClick={() => setShowBuilder((s) => !s)}>+ Build connector from API</button>
        </div>
        {showBuilder && (
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://api.example.com/openapi.json" style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #ccc", fontSize: 13 }} />
            <button onClick={() => void buildConnector()} disabled={busy}>Build</button>
          </div>
        )}
      </section>

      <section style={{ background: "#fff", borderRadius: 12, padding: 10, marginBottom: 10 }}>
        <b>📦 Ready automations — one tap</b>
        {templates.length === 0 && <div style={{ fontSize: 13, color: "#555" }}>Loading…</div>}
        {templates.map((t) => (
          <div key={t.id} style={{ padding: "6px 0", borderTop: "1px solid #eee", fontSize: 13 }}>
            <div><b>{t.title_en}</b> — {t.description_en}</div>
            <div style={{ marginTop: 4 }}>
              <button onClick={() => void useTemplate(t.id)} disabled={busy}>Use this</button>
              <small style={{ color: "#666" }}> or say ‘{t.say_to_use_en}’</small>
            </div>
          </div>
        ))}
      </section>

      <section style={{ background: "#fff", borderRadius: 12, padding: 10, marginBottom: 10 }}>
        <b>Your automations ({flows.length})</b>
        {flows.length === 0 && <div style={{ fontSize: 13, color: "#555" }}>None yet — use a template above or describe one below.</div>}
        {flows.map((f) => (
          <div key={f.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid #eee", fontSize: 14 }}>
            <span>⚡ {f.title_en} <small>({f.status})</small></span>
            <button onClick={() => void runFlow(f.id)}>▶️</button>
          </div>
        ))}
      </section>

      <section style={{ background: "#fff", borderRadius: 12, padding: 10, minHeight: 220 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ textAlign: m.from === "you" ? "right" : "left", margin: "6px 0" }}>
            <span style={{ display: "inline-block", padding: "8px 12px", borderRadius: 14, background: m.from === "you" ? "#16a34a" : "#e5e7eb", color: m.from === "you" ? "#fff" : "#111", maxWidth: "85%", fontSize: 14, wordBreak: "break-word" }}>
              {m.text}
            </span>
          </div>
        ))}
        <div ref={bottom} />
      </section>

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={mic} title="Speak" style={{ fontSize: 20 }}>🎤</button>
        <input
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
          placeholder="Say: every morning summarize Gmail to Telegram…"
          style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ccc" }}
        />
        <button onClick={() => void send()} disabled={busy} style={{ padding: "10px 16px", borderRadius: 10, background: "#16a34a", color: "#fff", border: 0 }}>
          {busy ? "…" : "Send"}
        </button>
      </div>

      {runs.length > 0 && (
        <section style={{ background: "#fff", borderRadius: 12, padding: 10, marginTop: 10 }}>
          <b>Recent runs</b>
          {runs.map((r) => (
            <div key={r.id} style={{ fontSize: 13, borderTop: "1px solid #eee", padding: "6px 0" }}>
              {r.status === "ok" ? "✅" : "❌"} {r.output_summary_en.slice(0, 160)}
            </div>
          ))}
        </section>
      )}

      {usage && (
        <section style={{ background: "#fff", borderRadius: 12, padding: 10, marginTop: 10, fontSize: 13 }}>
          <b>💰 Free usage — ${usage.spent_usd.toFixed(2)} spent</b>
          <div>Today: {usage.you_today.chats}/{usage.limits.chats_per_user_per_day} chats · {usage.you_today.runs}/{usage.limits.runs_per_user_per_day} runs</div>
          <div>AI calls today: {Object.keys(usage.calls_today_by_provider).length ? Object.entries(usage.calls_today_by_provider).map(([k, v]) => `${k}×${v}`).join(", ") : "none yet"}</div>
        </section>
      )}

      <p style={{ fontSize: 12, color: "#555" }}>Examples: “templates”, “use morning digest”, “connect gmail”, “why did last run fail?” · Works offline — messages queue and send later.</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
