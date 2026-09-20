import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../hooks/useAgent";
import { noticeLabel, receiptDetail, receiptLabel, unknownLabel } from "../lib/agent/receipts";

interface AssistantPanelProps {
  open: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  isThinking: boolean;
  onSend: (text: string) => void;
  onReset: () => void;
  onFocusMapObject: (objectId: string) => void;
}

const SUGGESTIONS = [
  "Plan a shadowed afternoon walk near here",
  "Where's a shady spot to sit at 2pm?",
  "Plan a 3-stop day trip that stays out of the sun",
];

export default function AssistantPanel({
  open,
  onClose,
  messages,
  isThinking,
  onSend,
  onReset,
  onFocusMapObject,
}: AssistantPanelProps) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageCount = messages.length;

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messageCount, isThinking]);

  if (!open) return null;

  function submit() {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  }

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-2xl border shadow-2xl"
      style={{
        bottom: "1rem",
        right: "1rem",
        width: "min(380px, calc(100vw - 2rem))",
        height: "min(560px, calc(100vh - 2rem))",
        background: "var(--color-raised)",
        borderColor: "var(--color-hairline)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b"
        style={{ borderColor: "var(--color-hairline)" }}
      >
        <span
          className="material-symbols-outlined text-ink"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          wb_sunny
        </span>
        <div className="flex-1">
          <div className="text-sm font-bold" style={{ color: "var(--color-ink)" }}>
            Umbra Assistant
          </div>
          <div className="text-[10px]" style={{ color: "var(--color-ink-muted)" }}>
            Plans shadow-aware outings
          </div>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-canvas transition-colors"
          title="New conversation"
          style={{ color: "var(--color-ink-muted)" }}
        >
          <span className="material-symbols-outlined text-lg">refresh</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-canvas transition-colors"
          title="Close"
          style={{ color: "var(--color-ink-muted)" }}
        >
          <span className="material-symbols-outlined text-lg">close</span>
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2">
        {messages.length === 0 && (
          <div className="flex flex-col gap-2 mt-2">
            <p className="text-xs px-1" style={{ color: "var(--color-ink-muted)" }}>
              Ask me to plan around the sun. I can read the live shadows, check whether a spot is
              shadowed at a given hour, and draw shadow-aware routes.
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => onSend(s)}
                className="text-left text-xs px-3 py-2 rounded-xl border hover:bg-canvas transition-colors"
                style={{ borderColor: "var(--color-hairline)", color: "var(--color-ink)" }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m) => {
          if (m.role === "tool") {
            return (
              <div key={m.id} className="flex items-center gap-2 px-2 py-1 self-start">
                <span
                  className="material-symbols-outlined text-sm animate-pulse"
                  style={{ color: "var(--color-ink-muted)" }}
                >
                  bolt
                </span>
                <span
                  className="text-[11px] italic"
                  style={{ color: "var(--color-ink-muted)" }}
                >
                  {m.text}
                </span>
              </div>
            );
          }
          const isUser = m.role === "user";
          return (
            <div
              key={m.id}
              className="max-w-[88%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words"
              style={{
                alignSelf: isUser ? "flex-end" : "flex-start",
                background: isUser
                  ? "var(--color-ink)"
                  : "var(--color-canvas)",
                color: isUser ? "var(--color-on-ink)" : "var(--color-ink)",
                borderBottomRightRadius: isUser ? 4 : undefined,
                borderBottomLeftRadius: isUser ? undefined : 4,
              }}
            >
              {m.answer ? (
                <div className="flex flex-col gap-1.5">
                  {m.answer.blocks.map((block) => {
                    if (block.kind === "unknown")
                      return (
                        <span key={`unknown:${block.claimKind}`}>
                          {unknownLabel(block.claimKind)}
                        </span>
                      );
                    if (block.kind === "notice")
                      return <span key={`notice:${block.code}`}>{noticeLabel(block)}</span>;
                    const receipt = m.answer!.receipts.find(
                      (candidate) => candidate.claimId === block.claimId,
                    );
                    if (!receipt) return null;
                    const mapObjectId = "mapObjectId" in receipt ? receipt.mapObjectId : undefined;
                    return (
                      <div
                        key={receipt.claimId}
                        className="rounded-lg border px-2 py-1.5"
                        style={{ borderColor: "var(--color-hairline)" }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (mapObjectId && receipt.verification === "verified")
                              onFocusMapObject(mapObjectId);
                          }}
                          disabled={!mapObjectId || receipt.verification !== "verified"}
                          className="w-full text-left text-xs font-semibold disabled:cursor-default"
                          aria-label={`${receiptLabel(receipt)}. ${receiptDetail(receipt)}`}
                        >
                          {receiptLabel(receipt)}
                        </button>
                        <p
                          className="mt-0.5 text-[10px]"
                          style={{ color: "var(--color-ink-muted)" }}
                        >
                          {receiptDetail(receipt)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                m.text
              )}
            </div>
          );
        })}

        {isThinking && (
          <div className="flex items-center gap-1.5 px-3 py-2 self-start">
            <span
              className="w-1.5 h-1.5 rounded-full bg-ink-muted animate-bounce"
              style={{ animationDelay: "0ms" }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-ink-muted animate-bounce"
              style={{ animationDelay: "120ms" }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full bg-ink-muted animate-bounce"
              style={{ animationDelay: "240ms" }}
            />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-2 border-t" style={{ borderColor: "var(--color-hairline)" }}>
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask about shadow, routes, or a day trip…"
            className="flex-1 resize-none rounded-xl border px-3 py-2 text-sm focus:outline-none"
            style={{
              borderColor: "var(--color-hairline)",
              color: "var(--color-ink)",
              maxHeight: 96,
            }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={isThinking || !input.trim()}
            className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors disabled:opacity-40"
            style={{ background: "var(--color-ink)", color: "var(--color-on-ink)" }}
            title="Send"
          >
            <span className="material-symbols-outlined text-lg">send</span>
          </button>
        </div>
      </div>
    </div>
  );
}
