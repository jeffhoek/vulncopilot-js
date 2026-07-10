"use client";

import { useState } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

// Phase 1: minimal chat page — input + submit + plain transcript in React
// state. No streaming, markdown, or tool-step display yet (Phase 2). History is
// client-held and sent whole on each request.
export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const nextMessages: Message[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = (await res.json()) as { text?: string; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setMessages([...nextMessages, { role: "assistant", content: data.text ?? "" }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>VulnCopilot</h1>
      <p style={{ color: "#666", marginBottom: "1.5rem" }}>
        Ask about CISA KEV / NIST NVD vulnerabilities.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1.5rem" }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              whiteSpace: "pre-wrap",
              padding: "0.75rem 1rem",
              borderRadius: 8,
              background: m.role === "user" ? "#eef2ff" : "#f5f5f5",
            }}
          >
            <strong style={{ display: "block", fontSize: "0.75rem", color: "#888", marginBottom: 4 }}>
              {m.role === "user" ? "You" : "Assistant"}
            </strong>
            {m.content}
          </div>
        ))}
        {loading && <div style={{ color: "#888" }}>Thinking…</div>}
        {error && <div style={{ color: "#b00020" }}>Error: {error}</div>}
      </div>

      <form onSubmit={sendMessage} style={{ display: "flex", gap: "0.5rem" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tell me about Log4Shell…"
          style={{ flex: 1, padding: "0.6rem 0.75rem", borderRadius: 8, border: "1px solid #ccc" }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{ padding: "0.6rem 1.2rem", borderRadius: 8, border: "none", background: "#4f46e5", color: "#fff", cursor: "pointer" }}
        >
          Send
        </button>
      </form>
    </main>
  );
}
