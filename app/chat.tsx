"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThemeToggle } from "./theme-toggle";
import { describeChatError, isAdvisory } from "@/src/lib/chat-errors";

interface ChatProps {
  documentCount: number | null;
  actionButtons: string[];
  maxHistoryMessages: number;
  // Authenticated user's display name (falls back to the github:<id> identity).
  user?: string;
  // Server action that ends the session; wired to the sign-out button.
  signOutAction?: () => Promise<void>;
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
export function Chat({ documentCount, actionButtons, maxHistoryMessages, user, signOutAction }: ChatProps) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error, regenerate, clearError } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // Client-held history, trimmed to the last N messages sent per request.
      // `id` is useChat's stable per-mount chat id; the route forwards it to
      // Langfuse as session.id, so one page visit = one traced session.
      prepareSendMessagesRequest: ({ id, messages }) => ({
        body: { messages: messages.slice(-maxHistoryMessages), chatId: id },
      }),
    }),
  });

  const isBusy = status === "submitted" || status === "streaming";

  // Keep the newest content in view as messages arrive / stream in.
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function submit(text: string) {
    const t = text.trim();
    if (!t || isBusy) return;
    sendMessage({ text: t });
    setInput("");
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>VulnCopilot</h1>
        <p className="tagline">CISA KEV / NIST NVD vulnerability assistant.</p>
        {actionButtons.length > 0 && (
          <div className="quick-queries">
            <span className="qq-label">Quick queries</span>
            {actionButtons.map((label) => (
              <button key={label} type="button" className="pill" onClick={() => submit(label)} disabled={isBusy}>
                {label}
              </button>
            ))}
          </div>
        )}
        {user && (
          <div className="account">
            <span className="account-user" title={user}>
              {user}
            </span>
            <ThemeToggle />
            {signOutAction && (
              <form action={signOutAction}>
                <button type="submit" className="signout-btn">
                  Sign out
                </button>
              </form>
            )}
          </div>
        )}
      </aside>

      <section className="chat">
        <div className="banner">
          {documentCount != null
            ? `Ready! ${documentCount.toLocaleString()} vulnerability records available.`
            : "Ask about CISA KEV / NIST NVD vulnerabilities."}
        </div>

        <div className="transcript">
          {messages.length === 0 && <div className="empty">Ask a question to get started.</div>}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {status === "submitted" && <div className="thinking">Thinking…</div>}
          {error && (
            <ErrorNotice
              message={error.message}
              // regenerate() drops a partially-streamed assistant message and
              // re-sends the last user turn; with no messages there is nothing
              // to regenerate, so the button is withheld rather than throwing.
              onRetry={
                messages.length > 0
                  ? () => {
                      clearError();
                      void regenerate();
                    }
                  : undefined
              }
            />
          )}
          <div ref={endRef} />
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Tell me about Log4Shell…"
          />
          <button type="submit" className="send-btn" disabled={isBusy}>
            Send
          </button>
        </form>
      </section>
    </div>
  );
}

// A failed turn, rendered as a typed notice rather than a raw dump of whatever
// string landed in `error.message`. That string can be a plain-text body from
// our own route or an in-band stream error from the provider (the latter used
// to arrive as JSON-with-stack-trace — see src/lib/chat-errors.ts), so the
// classification lives in that shared module and this component only presents
// it: tone (advisory vs. fault) and the one action that actually helps.
function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const info = describeChatError(message);
  const advisory = isAdvisory(info.kind);
  // A dead session or a blown context window can't be fixed by re-sending;
  // reloading re-runs auth and starts a fresh (client-held) conversation.
  const canReload = info.kind === "session-expired" || info.kind === "context-length";
  const canRetry = info.retryable && onRetry != null;

  return (
    <div className={advisory ? "notice notice-advisory" : "notice notice-fault"} role="alert">
      <div className="notice-head">
        <span aria-hidden="true">{advisory ? "⚠️" : "⛔"}</span>
        <strong>{info.title}</strong>
      </div>
      <p className="notice-detail">{info.detail}</p>
      {info.technical && (
        <details className="notice-technical">
          <summary>Technical detail</summary>
          <pre>{info.technical}</pre>
        </details>
      )}
      {(canRetry || canReload) && (
        <div className="notice-actions">
          {canRetry && (
            <button type="button" className="pill" onClick={onRetry}>
              Retry
            </button>
          )}
          {canReload && (
            <button type="button" className="pill" onClick={() => window.location.reload()}>
              Reload
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={isUser ? "bubble bubble-user" : "bubble bubble-assistant"}>
      <strong className="role">{isUser ? "You" : "Assistant"}</strong>
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
    <div className="tool-step">
      🔧 {name} · {label}
    </div>
  );
}
