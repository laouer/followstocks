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
};

export default function ChatWidget({ apiBase, lang, t }: ChatWidgetProps) {
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
    setChatMessages((prev) => [...prev, userMessage]);
    setChatInput("");
    setChatStreaming(true);
    try {
      const response = await fetch(`${apiBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: chatSessionId,
          message: userMessage.content,
          language: lang,
        }),
      });
      if (!response.ok) {
        throw new Error(`Chat backend error: ${response.status}`);
      }
      if (!response.body) throw new Error("No stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";
      setChatMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });
        setChatMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: assistantText };
          return updated;
        });
      }
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: translator("Chatbot call failed") },
      ]);
    } finally {
      setChatStreaming(false);
    }
  }, [apiBase, chatInput, chatSessionId, lang, translator]);

  return (
    <>
      <div
        className={`chat-fab ${chatOpen ? "open" : ""}`}
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
