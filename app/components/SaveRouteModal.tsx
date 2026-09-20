// app/components/SaveRouteModal.tsx
import { useEffect, useId, useRef, useState } from "react";
import { getFolders, createFolder } from "../lib/savedRoutes";
import type { SavedFolder } from "../lib/savedRoutes";

interface Props {
  defaultName: string; // e.g. "Shortest route"
  onSave: (name: string, folderId: string | null) => void;
  onCancel: () => void;
}

export default function SaveRouteModal({ defaultName, onSave, onCancel }: Props) {
  const nameInputId = useId();
  const folderSelectId = useId();
  const [name, setName]   = useState(defaultName);
  const [folders, setFolders] = useState<SavedFolder[]>(getFolders);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (showNewFolder) newFolderInputRef.current?.focus();
  }, [showNewFolder]);

  function handleAddFolder() {
    if (!newFolderName.trim()) return;
    const f = createFolder(newFolderName.trim());
    setFolders(prev => [...prev, f]);
    setFolderId(f.id);
    setNewFolderName("");
    setShowNewFolder(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        className="rounded-2xl shadow-2xl w-80 p-5 flex flex-col gap-4 border"
        style={{
          background: "white",
          borderColor: "var(--color-hairline)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <h2 className="text-sm font-bold" style={{ color: "var(--color-ink)" }}>Save Route</h2>

        {/* Name */}
        <div className="flex flex-col gap-1">
          <label htmlFor={nameInputId} className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>Name</label>
          <input
            id={nameInputId}
            ref={nameInputRef}
            value={name}
            onChange={e => setName(e.target.value)}
            className="border rounded px-2 py-1.5 text-xs focus:outline-none"
            style={{
              background: "var(--color-canvas)",
              color: "var(--color-ink)",
              borderColor: "var(--color-hairline)",
              fontFamily: "var(--font-sans)",
            }}
            placeholder="Route name"
          />
        </div>

        {/* Folder */}
        <div className="flex flex-col gap-1">
          <label htmlFor={folderSelectId} className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>Folder</label>
          <select
            id={folderSelectId}
            value={folderId ?? ""}
            onChange={e => setFolderId(e.target.value || null)}
            className="border rounded px-2 py-1.5 text-xs focus:outline-none"
            style={{
              background: "white",
              color: "var(--color-ink)",
              borderColor: "var(--color-hairline)",
              fontFamily: "var(--font-sans)",
            }}
          >
            <option value="">None</option>
            {folders.map(f => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>

        {/* New folder */}
        {showNewFolder ? (
          <div className="flex gap-2">
            <input
              ref={newFolderInputRef}
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleAddFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
              className="flex-1 border rounded px-2 py-1 text-xs focus:outline-none"
              style={{
                background: "var(--color-canvas)",
                color: "var(--color-ink)",
                borderColor: "var(--color-hairline)",
              }}
              placeholder="Folder name"
            />
            <button type="button"
              onClick={handleAddFolder}
              className="text-xs px-2 py-1 rounded font-medium transition-colors"
              style={{ background: "var(--color-chrome-soft)", color: "var(--color-ink)" }}
            >
              Add
            </button>
            <button type="button" onClick={() => setShowNewFolder(false)} className="text-xs px-2 py-1 text-ink-faint hover:text-ink-muted transition-colors">
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
        ) : (
          <button type="button"
            onClick={() => setShowNewFolder(true)}
            className="text-[11px] hover:text-chrome self-start transition-colors"
            style={{ color: "var(--color-chrome)" }}
          >
            + New folder
          </button>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button type="button"
            onClick={() => onSave(name.trim() || defaultName, folderId)}
            disabled={!name.trim()}
            className="flex-1 py-1.5 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ background: "var(--color-chrome)", color: "var(--color-on-chrome)" }}
          >
            Save
          </button>
          <button type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-xs text-ink-muted hover:text-ink border transition-colors"
            style={{ borderColor: "var(--color-hairline)" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
