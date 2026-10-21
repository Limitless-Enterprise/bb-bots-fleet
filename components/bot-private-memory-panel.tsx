import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import { botMemoryKindSchema, type BotMemoryKind } from "../lib/bot-memory-kinds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type IndexLine = { id: string; title: string; kind: BotMemoryKind; hook: string };

export function BotPrivateMemoryPanel({ botId, disabled }: { botId: string; disabled?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [entries, setEntries] = useState<IndexLine[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<BotMemoryKind>("fact");
  const [importance, setImportance] = useState(50);
  const [body, setBody] = useState("");
  const [sha256, setSha256] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await rpc.call("bot_memory_list", { botId, limit: 100 });
    setEntries(result.entries);
  }, [botId, rpc]);

  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [refresh]);

  async function loadEntry(entryId: string) {
    setPending(true); setError(null);
    try {
      const result = await rpc.call("bot_memory_read", { botId, entryId });
      setSelectedId(entryId);
      setTitle(result.entry.title);
      setKind(result.entry.kind);
      setImportance(result.entry.importance);
      setBody(result.entry.body);
      setSha256(result.entry.sha256);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }

  async function saveEntry() {
    if (!selectedId || !sha256) return;
    setPending(true); setError(null);
    try {
      const entry = await rpc.call("bot_memory_write", {
        botId, entryId: selectedId, title, kind: botMemoryKindSchema.parse(kind), importance, body, reviewBy: null, expectedSha256: sha256,
      });
      setSha256(entry.sha256);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }

  return <div className="space-y-3 text-sm">
    <p className="text-[11px] text-muted-foreground">Private level-1 memory for this bot. Not visible to other bots.</p>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <ul className="max-h-28 space-y-1 overflow-y-auto rounded border border-border p-2">
      {entries.length ? entries.map((entry) => (
        <li key={entry.id}>
          <button type="button" disabled={disabled || pending} className="w-full text-left hover:bg-state-hover rounded px-1 py-0.5" onClick={() => void loadEntry(entry.id)}>
            <span className="font-medium">{entry.title}</span> <span className="text-muted-foreground">· {entry.kind}</span>
            <div className="truncate text-[10px] text-muted-foreground">{entry.hook}</div>
          </button>
        </li>
      )) : <li className="text-muted-foreground text-xs">No memory entries yet.</li>}
    </ul>
    {selectedId ? <div className="space-y-2">
      <label className="block space-y-1 text-xs font-medium text-muted-foreground">Title<Input disabled={disabled || pending} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="block space-y-1 text-xs font-medium text-muted-foreground">Kind
        <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" disabled={disabled || pending} value={kind} onChange={(event) => setKind(botMemoryKindSchema.parse(event.target.value))}>
          {botMemoryKindSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label className="block space-y-1 text-xs font-medium text-muted-foreground">Importance (0–100)<Input type="number" min={0} max={100} disabled={disabled || pending} value={importance} onChange={(event) => setImportance(Number(event.target.value))} /></label>
      <label className="block space-y-1 text-xs font-medium text-muted-foreground">Body<textarea className="min-h-24 w-full rounded-md border border-input bg-background px-2 py-1 text-sm" disabled={disabled || pending} value={body} onChange={(event) => setBody(event.target.value)} /></label>
      <Button type="button" size="sm" disabled={disabled || pending} onClick={() => void saveEntry()}>Save entry</Button>
    </div> : null}
  </div>;
}
