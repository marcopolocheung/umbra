import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../hooks/useAgent";
import { guideNote } from "../lib/agent/guideNote";
import { noticeLabel, receiptDetail, receiptLabel, unknownLabel } from "../lib/agent/receipts";

interface AssistantPanelProps {
  open: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  isThinking: boolean;
  progress?: string | null;
  onSend: (text: string) => void;
  onReset: () => void;
  onFocusMapObject: (objectId: string) => void;
  /** Current map pin identities in their plotted order. */
  stopIds: string[];
  /** Current route objects, supplied by the map owner. */
  routeIds?: string[];
}

const SUGGESTIONS = [
  "Plan a shadowed afternoon walk near here",
  "Where's a shady spot to sit at 2pm?",
  "Plan a 3-stop day trip that stays out of the sun",
];
const focusClass = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current";

export default function AssistantPanel({
  open, onClose, messages, isThinking, progress, onSend, onReset, onFocusMapObject, stopIds, routeIds = [],
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
    <section
      aria-label="Umbra Assistant"
      className="umbra-rise-in fixed z-50 flex flex-col overflow-hidden border-2 shadow-hard-2"
      style={{
        bottom: "1rem", right: "1rem", width: "min(380px, calc(100vw - 2rem))",
        height: "min(560px, calc(100vh - 2rem))", background: "var(--color-panel)",
        borderColor: "var(--color-ink)", color: "var(--color-ink)", fontFamily: "var(--font-sans)",
      }}
    >
      <header
        className="flex min-h-14 items-center gap-1 border-b-2 px-2"
        style={{ background: "var(--color-ink)", color: "var(--color-on-ink)", borderColor: "var(--color-panel)" }}
      >
        <div className="min-w-0 flex-1 px-2">
          <h2 className="font-extrabold uppercase tracking-wider" style={{ fontFamily: "var(--font-label)", fontSize: "var(--text-caption)" }}>Umbra Assistant</h2>
          <p className="truncate" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-caption)" }}>Plans shadow-aware outings</p>
        </div>
        <button type="button" onClick={onReset} aria-label="New conversation" title="New conversation" className={`flex h-11 w-11 shrink-0 items-center justify-center ${focusClass}`}>
          <span className="material-symbols-outlined text-xl" aria-hidden="true">refresh</span>
        </button>
        <button type="button" onClick={onClose} aria-label="Close assistant" title="Close" className={`flex h-11 w-11 shrink-0 items-center justify-center ${focusClass}`}>
          <span className="material-symbols-outlined text-xl" aria-hidden="true">close</span>
        </button>
      </header>

      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="flex flex-col gap-3">
            <div>
              <p className="font-extrabold uppercase tracking-wider" style={{ fontFamily: "var(--font-label)", fontSize: "var(--text-caption)" }}>Field notes</p>
              <p className="font-display text-2xl font-semibold leading-tight">A little less sun.</p>
              <p className="mt-2 text-sm" style={{ color: "var(--color-ink-muted)" }}>
                Ask me to plan around the sun. I can read the live shadows, check whether a spot is
                shadowed at a given hour, and draw shadow-aware routes.
              </p>
            </div>
            <div className="border-y-2" style={{ borderColor: "var(--color-ink)" }}>
              {SUGGESTIONS.map((suggestion) => (
                <button type="button" key={suggestion} onClick={() => onSend(suggestion)}
                  className={`flex min-h-11 w-full items-center border-b px-2 py-2 text-left text-sm last:border-b-0 hover:bg-ground ${focusClass}`}
                  style={{ borderColor: "var(--color-rule)" }}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => {
          if (message.role === "tool") return null;
          if (message.role === "user") return (
            <p key={message.id} className="max-w-[88%] self-end whitespace-pre-wrap break-words border-2 px-3 py-2 text-sm" style={{ background: "var(--color-ink)", borderColor: "var(--color-ink)", color: "var(--color-on-ink)" }}>
              {message.text}
            </p>
          );
          const note = message.answer ? guideNote(message.answer, stopIds, routeIds) : null;
          return (
            <article key={message.id} className="w-full break-words">
              {message.answer ? (
                <div className="border-y-2" style={{ borderColor: "var(--color-ink)" }}>
                  {message.answer.blocks.map((block) => {
                    if (block.kind === "unknown") return (
                      <p key={`unknown:${block.claimKind}`} className="border-b px-2 py-3 text-sm last:border-b-0" style={{ borderColor: "var(--color-rule)" }}>{unknownLabel(block.claimKind)}</p>
                    );
                    if (block.kind === "notice") return (
                      <p key={`notice:${block.code}`} className="border-b px-2 py-3 text-sm last:border-b-0" style={{ borderColor: "var(--color-rule)" }}>{noticeLabel(block)}</p>
                    );
                    const receipt = message.answer!.receipts.find((candidate) => candidate.claimId === block.claimId);
                    if (!receipt) return null;
                    const mapObjectId = "mapObjectId" in receipt ? receipt.mapObjectId : undefined;
                    const stopIndex = receipt.kind === "place" && receipt.verification === "verified" && mapObjectId ? stopIds.indexOf(mapObjectId) : -1;
                    const canFocus = Boolean(mapObjectId && receipt.verification === "verified" && (receipt.kind !== "place" || stopIndex >= 0));
                    const label = receiptLabel(receipt);
                    const detail = receiptDetail(receipt);
                    return (
                      <div key={receipt.claimId} className="border-b py-2 last:border-b-0" style={{ borderColor: "var(--color-rule)" }}>
                        <div className="flex items-center gap-2">
                          {stopIndex >= 0 && mapObjectId && (
                            <button type="button" onClick={() => {
                              onFocusMapObject(mapObjectId);
                              if (window.innerWidth < 640) onClose();
                            }}
                              aria-label={`Focus stop ${stopIndex + 1} on map: ${label}`}
                              className={`flex h-11 w-11 shrink-0 items-center justify-center ${focusClass}`}>
                              <span className="flex items-center justify-center border-2 text-[11px] font-extrabold tabular-nums"
                                style={{ width: 26, height: 26, borderRadius: "var(--radius-pin)", transform: "rotate(var(--angle-marker))", background: "var(--color-map-route)", borderColor: "var(--color-map-casing)", color: "var(--color-map-casing)", fontFamily: "var(--font-numeric)" }}>
                                <span style={{ transform: "rotate(var(--angle-marker-inner))" }}>{stopIndex + 1}</span>
                              </span>
                            </button>
                          )}
                          {canFocus && stopIndex < 0 ? (
                            <button type="button" onClick={() => onFocusMapObject(mapObjectId!)}
                              className={`min-h-11 flex-1 px-2 text-left text-sm font-semibold ${focusClass}`}
                              aria-label={`${label}. ${detail}`}>{label}</button>
                          ) : (
                            <p className="min-w-0 flex-1 px-2 text-sm font-semibold">{label}</p>
                          )}
                        </div>
                        <p className="text-[11px]" style={{ color: "var(--color-ink-muted)", paddingLeft: stopIndex >= 0 ? 60 : 8, paddingRight: 8 }}>{detail}</p>
                      </div>
                    );
                  })}
                </div>
              ) : <p className="whitespace-pre-wrap text-sm">{message.text}</p>}
              {note && (
                <div className="umbra-guide-bubble mt-3 max-w-[92%] border-2 px-3 py-2 text-sm"
                  style={{ background: "var(--color-ground)", borderColor: "var(--color-ink)" }}
                  data-claim-ids={note.claimIds.join(" ")}>
                  <p>{note.text}</p>
                  {note.action && (
                    <button type="button" className={`mt-2 flex min-h-11 items-center border-2 px-3 text-sm font-semibold ${focusClass}`}
                      style={{ background: "var(--color-ink)", color: "var(--color-on-ink)", borderColor: "var(--color-ink)" }}
                      onClick={() => {
                        onFocusMapObject(note.action!.mapObjectId);
                        if (window.innerWidth < 640) onClose();
                      }}>
                      {note.action.label}
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
        {isThinking && (
          <div className="self-start">
            <p className="px-1 py-1" style={{ color: "var(--color-ink-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-caption)" }} aria-hidden="true">
              {progress ?? "Working…"}
            </p>
            <div className="umbra-guide-bubble border-2 px-3 py-3" style={{ background: "var(--color-ground)", borderColor: "var(--color-ink)" }} aria-hidden="true">
              <span className="umbra-typing-squares"><span /><span /><span /></span>
            </div>
          </div>
        )}
        <span role="status" aria-live="polite" className="sr-only">
          {isThinking
            ? "Umbra is working on your request."
            : messages.at(-1)?.role === "assistant"
              ? "Umbra has finished responding."
              : ""}
        </span>
      </div>

      <div className="border-t-2 p-2" style={{ borderColor: "var(--color-ink)" }}>
        <div className="flex items-end gap-2">
          <textarea value={input} onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }}
            rows={1} aria-label="Message to Umbra Assistant" placeholder="Ask about shadow, routes, or a day trip…"
            className={`min-h-11 flex-1 resize-none border-2 px-3 py-2 text-sm ${focusClass}`}
            style={{ background: "var(--color-panel)", borderColor: "var(--color-ink)", color: "var(--color-ink)", maxHeight: 96 }} />
          <button type="button" onClick={submit} disabled={isThinking || !input.trim()} aria-label="Send message" title="Send"
            className={`flex h-11 w-11 shrink-0 items-center justify-center disabled:opacity-40 ${focusClass}`}
            style={{ background: "var(--color-ink)", color: "var(--color-on-ink)" }}>
            <span className="material-symbols-outlined text-xl" aria-hidden="true">send</span>
          </button>
        </div>
      </div>
    </section>
  );
}
