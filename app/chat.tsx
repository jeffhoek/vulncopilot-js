"use client";

import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatProps {
  documentCount: number | null;
  actionButtons: string[];
  maxHistoryMessages: number;
}

// Phase 2 chat UI: streaming via useChat, markdown rendering, visible tool-call
// steps, quick-query action buttons, and the "Ready! N records" banner. History
// is client-held (React state) and trimmed to the last maxHistoryMessages before
// each request (see prepareSendMessagesRequest below).
//
// NOTE (flagged divergence from reference): the reference trims
// all_messages()[-N:], which counts internal tool-call/return messages; here N
// counts UI turns (each turn is one message with tool steps as inner parts). With
// the default of 50 this is immaterial, but the unit differs by design.
export function Chat({ documentCount, actionButtons, maxHistoryMessages }: ChatProps) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // Client-held history, trimmed to the last N messages sent per request.
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { messages: messages.slice(-maxHistoryMessages) },
      }),
    }),
  });

  const isBusy = status === "submitted" || status === "streaming";

  function submit(text: string) {
    const t = text.trim();
    if (!t || isBusy) return;
    sendMessage({ text: t });
    setInput("");
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "0.25rem" }}>VulnCopilot</h1>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        {documentCount != null
          ? `Ready! ${documentCount.toLocaleString()} vulnerability records available.`
          : "Ask about CISA KEV / NIST NVD vulnerabilities."}
      </p>

      {actionButtons.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1.5rem" }}>
          {actionButtons.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => submit(label)}
              disabled={isBusy}
              style={{
                padding: "0.4rem 0.75rem",
                borderRadius: 999,
                border: "1px solid #ccc",
                background: "#fafafa",
                cursor: isBusy ? "default" : "pointer",
                fontSize: "0.85rem",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1.5rem" }}>
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {status === "submitted" && <div style={{ color: "#888" }}>Thinking…</div>}
        {error && <div style={{ color: "#b00020" }}>Error: {error.message}</div>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        style={{ display: "flex", gap: "0.5rem" }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tell me about Log4Shell…"
          style={{ flex: 1, padding: "0.6rem 0.75rem", borderRadius: 8, border: "1px solid #ccc" }}
        />
        <button
          type="submit"
          disabled={isBusy}
          style={{ padding: "0.6rem 1.2rem", borderRadius: 8, border: "none", background: "#4f46e5", color: "#fff", cursor: "pointer" }}
        >
          Send
        </button>
      </form>
    </main>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      style={{
        padding: "0.75rem 1rem",
        borderRadius: 8,
        background: isUser ? "#eef2ff" : "#f5f5f5",
      }}
    >
      <strong style={{ display: "block", fontSize: "0.75rem", color: "#888", marginBottom: 4 }}>
        {isUser ? "You" : "Assistant"}
      </strong>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <div key={i} className="md">
              {/* remark-gfm enables GFM tables/strikethrough/autolinks — base
                  react-markdown is CommonMark-only and renders tables as raw text. */}
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        // Static tool parts arrive as `tool-<name>`; dynamically-registered tools
        // as `dynamic-tool`. Show a small step chip for either so the tool call is
        // visible in the transcript.
        if (part.type === "dynamic-tool") {
          return <ToolStep key={i} name={part.toolName} state={part.state} />;
        }
        if (part.type.startsWith("tool-")) {
          return <ToolStep key={i} name={part.type.slice("tool-".length)} state={(part as { state?: string }).state} />;
        }
        return null;
      })}
    </div>
  );
}

function ToolStep({ name, state }: { name: string; state?: string }) {
  const done = state === "output-available";
  const failed = state === "output-error";
  const label = failed ? "failed" : done ? "done" : "running…";
  return (
    <div
      style={{
        display: "inline-block",
        margin: "0.25rem 0",
        padding: "0.15rem 0.5rem",
        borderRadius: 6,
        background: "#eaeaea",
        color: "#555",
        fontSize: "0.75rem",
        fontFamily: "ui-monospace, monospace",
      }}
    >
      🔧 {name} · {label}
    </div>
  );
}
