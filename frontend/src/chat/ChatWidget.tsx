import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  getInitialChatSessionId,
  makeChatSessionId,
  makeInitialChatMessage,
  renderMarkdown,
} from "./chatUtils";
import "./ChatWidget.css";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatWidgetProps = {
  apiBase: string;
  lang: string;
  t: (value: string) => string;
  toggleToken?: number;
  hideFab?: boolean;
  hideFabOnMobileNav?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export default function ChatWidget({
  apiBase,
  lang,
  t,
  toggleToken,
  hideFab = false,
  hideFabOnMobileNav = false,
  onOpenChange,
}: ChatWidgetProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => [
    makeInitialChatMessage(t) as ChatMessage,
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatSessionId, setChatSessionId] = useState(getInitialChatSessionId);
  const chatMessagesRef = useRef<HTMLDivElement | null>(null);

  const translator = useMemo(() => t, [t]);

  useEffect(() => {
    if (!chatMessagesRef?.current) return;
    chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
  }, [chatMessages, chatStreaming, chatOpen]);

  useEffect(() => {
    if (toggleToken === undefined || toggleToken === 0) return;
    setChatOpen((prev) => {
      const next = !prev;
      if (!next) setChatExpanded(false);
      return next;
    });
  }, [toggleToken]);

  useEffect(() => {
    onOpenChange?.(chatOpen);
  }, [chatOpen, onOpenChange]);

  useEffect(() => {
    const body = document.body;
    if (chatOpen && chatExpanded) {
      body.classList.add("chat-modal-open");
    } else {
      body.classList.remove("chat-modal-open");
    }
    return () => body.classList.remove("chat-modal-open");
  }, [chatOpen, chatExpanded]);

  useEffect(() => {
    setChatMessages((prev) => {
      if (prev.length === 1 && prev[0]?.role === "assistant") {
        return [makeInitialChatMessage(translator) as ChatMessage];
      }
      return prev;
    });
  }, [translator]);

  const resetChatSession = useCallback(() => {
    const nextId = makeChatSessionId();
    setChatSessionId(nextId);
    setChatMessages([makeInitialChatMessage(translator) as ChatMessage]);
    setChatInput("");
    setChatStreaming(false);
    try {
      window.localStorage.setItem("chatSessionId", nextId);
    } catch {
      // ignore storage errors
    }
  }, [translator]);

  const sendChatMessage = useCallback(async () => {
    if (!chatInput.trim()) return;
    const userMessage: ChatMessage = { role: "user", content: chatInput.trim() };
    const requestPayload = {
      session_id: chatSessionId,
      message: userMessage.content,
      language: lang,
    };
    const streamStartedAt = Date.now();
    const streamUrl = `${apiBase}/api/chat`;
    const streamPrefix = `[chat-stream][${chatSessionId}]`;
    let assistantText = "";
    const setAssistantMessage = (content: string) => {
      setChatMessages((prev) => {
        const updated = [...prev];
        if (updated.length && updated[updated.length - 1]?.role === "assistant") {
          updated[updated.length - 1] = { role: "assistant", content };
        } else {
          updated.push({ role: "assistant", content });
        }
        return updated;
      });
    };
    setChatMessages((prev) => [...prev, userMessage]);
    setChatInput("");
    setChatStreaming(true);
    console.info(`${streamPrefix} request:start`, {
      url: streamUrl,
      lang,
      messageChars: userMessage.content.length,
    });
    try {
      const response = await fetch(streamUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });
      console.info(`${streamPrefix} request:response`, {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        transferEncoding: response.headers.get("transfer-encoding"),
        cacheControl: response.headers.get("cache-control"),
      });
      if (!response.ok) {
        throw new Error(`Chat backend error: ${response.status}`);
      }
      if (!response.body) throw new Error("No stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let chunkCount = 0;
      let totalBytes = 0;
      setChatMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.info(`${streamPrefix} stream:end`, {
            chunkCount,
            totalBytes,
            totalChars: assistantText.length,
            elapsedMs: Date.now() - streamStartedAt,
          });
          break;
        }
        const chunkBytes = value?.byteLength || 0;
        chunkCount += 1;
        totalBytes += chunkBytes;
        const chunkText = decoder.decode(value, { stream: true });
        assistantText += chunkText;
        if (chunkCount <= 3 || chunkCount % 20 === 0) {
          console.debug(`${streamPrefix} stream:chunk`, {
            chunkIndex: chunkCount,
            chunkBytes,
            totalBytes,
            chunkChars: chunkText.length,
            totalChars: assistantText.length,
            preview: chunkText.slice(0, 80),
          });
        }
        setAssistantMessage(assistantText);
      }
    } catch (err) {
      console.error(`${streamPrefix} stream:error`, err);
      const errText =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err || "unknown error");
      const shouldFallbackToSync =
        err instanceof TypeError ||
        /ERR_HTTP2_PROTOCOL_ERROR|network error|failed to fetch/i.test(errText);

      if (shouldFallbackToSync) {
        const fallbackUrl = `${streamUrl}?stream=false`;
        console.warn(`${streamPrefix} fallback:sync:start`, { fallbackUrl, reason: errText });
        try {
          const fallbackResponse = await fetch(fallbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload),
          });
          console.info(`${streamPrefix} fallback:sync:response`, {
            status: fallbackResponse.status,
            ok: fallbackResponse.ok,
            contentType: fallbackResponse.headers.get("content-type"),
          });
          if (fallbackResponse.ok) {
            const fallbackJson = (await fallbackResponse.json()) as { message?: unknown };
            const fallbackText =
              typeof fallbackJson?.message === "string" ? fallbackJson.message.trim() : "";
            if (fallbackText) {
              setAssistantMessage(fallbackText);
              console.info(`${streamPrefix} fallback:sync:success`, {
                chars: fallbackText.length,
              });
              return;
            }
          }
        } catch (fallbackErr) {
          console.error(`${streamPrefix} fallback:sync:error`, fallbackErr);
        }
      }

      if (assistantText) {
        setAssistantMessage(assistantText);
      } else {
        setAssistantMessage(translator("Chatbot call failed"));
      }
    } finally {
      console.info(`${streamPrefix} stream:finish`, {
        elapsedMs: Date.now() - streamStartedAt,
      });
      setChatStreaming(false);
    }
  }, [apiBase, chatInput, chatSessionId, lang, translator]);

  return (
    <>
      {!hideFab && (
        <div
          className={`chat-fab ${chatOpen ? "open" : ""}${hideFabOnMobileNav ? " mobile-nav-hidden" : ""}`}
          onClick={() =>
            setChatOpen((v) => {
              const next = !v;
              if (!next) setChatExpanded(false);
              return next;
            })
          }
        >
          💬
        </div>
      )}
      {chatOpen && chatExpanded && <div className="chat-backdrop" />}
      {chatOpen && (
        <div className={`chat-panel ${chatExpanded ? "expanded" : ""}`}>
          <div className="chat-header">
            <div className="flex-center">
              <span aria-hidden="true">💬</span>
              <strong>{translator("Chat")}</strong>
            </div>
            <div className="chat-header-actions">
              <button
                className="icon-btn"
                type="button"
                title={translator(chatExpanded ? "Exit full screen" : "Full screen")}
                aria-label={translator(chatExpanded ? "Exit full screen" : "Full screen")}
                onClick={() => setChatExpanded((v) => !v)}
                disabled={chatStreaming}
              >
                ⤢
              </button>
              <button
                className="icon-btn"
                type="button"
                title={translator("New chat")}
                aria-label={translator("New chat")}
                onClick={resetChatSession}
                disabled={chatStreaming}
              >
                ↻
              </button>
              <button
                className="icon-btn"
                type="button"
                title={translator("Close")}
                aria-label={translator("Close")}
                onClick={() => {
                  setChatExpanded(false);
                  setChatOpen(false);
                }}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="chat-messages" ref={chatMessagesRef}>
            {chatMessages.map((m, idx) => {
              const isStreamingPlaceholder =
                chatStreaming &&
                m.role === "assistant" &&
                !m.content &&
                idx === chatMessages.length - 1;
              if (isStreamingPlaceholder) return null;
              return (
                <div key={idx} className={`chat-bubble ${m.role === "user" ? "user" : "ai"}`}>
                  {m.role === "assistant" ? (
                    <div
                      className="chat-markdown"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                    />
                  ) : (
                    m.content
                  )}
                </div>
              );
            })}
            {chatStreaming && (
              <div className="chat-bubble ai chat-typing">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
          <div className="chat-input">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={translator("Ask a question")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !chatStreaming) sendChatMessage();
              }}
            />
            <button onClick={sendChatMessage} disabled={chatStreaming || !chatInput.trim()}>
              {translator("Send")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
