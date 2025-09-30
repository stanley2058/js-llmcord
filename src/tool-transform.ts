import type { ModelMessage } from "ai";

export function buildToolAuditNote(messages: ModelMessage[]) {
  const order = [];
  const byId = new Map<
    string,
    { id: string; name: string; inputs: unknown[]; results: unknown[] }
  >();

  for (const m of messages || []) {
    const content = Array.isArray(m?.content) ? m.content : [];

    if (m?.role === "assistant") {
      for (const p of content) {
        if (p?.type !== "tool-call") continue;

        const id = p.toolCallId || "unknown_tool_use_id";
        const name = p.toolName || "unknown_tool";
        const input = p.input ?? null;

        let entry = byId.get(id);
        if (!entry) {
          entry = { id, name, inputs: [], results: [] };
          byId.set(id, entry);
          order.push(entry);
        }
        if (input !== null) entry.inputs.push(input);
      }
    }

    if (m?.role === "tool") {
      for (const p of content) {
        if (p?.type !== "tool-result") continue;

        const id = p.toolCallId || "unknown_tool_use_id";
        const name = p.toolName || "unknown_tool";
        const output = p.output ?? null;

        let entry = byId.get(id);
        if (!entry) {
          entry = { id, name, inputs: [], results: [] };
          byId.set(id, entry);
          order.push(entry);
        }
        if (output !== null) entry.results.push(output);
      }
    }
  }

  const lines: string[] = [];
  lines.push("[Tool calls]");
  let i = 1;

  for (const e of order) {
    lines.push(`${i}. ${e.name} (${e.id})`);

    if (e.inputs.length) {
      const v = e.inputs.length === 1 ? e.inputs[0] : e.inputs;
      lines.push(
        "- input: " +
          (() => {
            try {
              return typeof v === "string" ? v : JSON.stringify(v, null, 2);
            } catch {
              return String(v);
            }
          })(),
      );
    } else {
      lines.push("- input: <none>");
    }

    if (e.results.length) {
      const v = e.results.length === 1 ? e.results[0] : e.results;
      lines.push(
        "- result: " +
          (() => {
            try {
              // AI SDK often wraps json outputs as { type: 'json', value: ... }
              if (
                v &&
                typeof v === "object" &&
                "type" in v &&
                "value" in v &&
                v.type === "json"
              ) {
                return JSON.stringify(v.value, null, 2);
              }
              if (
                v &&
                typeof v === "object" &&
                "type" in v &&
                "text" in v &&
                v.type === "text"
              ) {
                return String(v.text ?? "");
              }
              return typeof v === "string" ? v : JSON.stringify(v, null, 2);
            } catch {
              return String(v);
            }
          })(),
      );
    } else {
      lines.push("- result: <none>");
    }

    i++;
    lines.push("");
  }

  if (order.length === 0) return "";

  return lines.join("\n").trim();
}

export function stripToolTraffic(messages: ModelMessage[]) {
  const out: ModelMessage[] = [];

  for (const m of messages || []) {
    if (!m || !m.role) continue;

    // Drop tool role messages entirely
    if (m.role === "tool") continue;
    if (m.role !== "assistant") {
      out.push(m);
      continue;
    }

    const content = Array.isArray(m.content) ? m.content : [];

    // Keep only non-tool parts
    const filtered = content.filter((p) => {
      if (!p || typeof p !== "object") return false;
      const t = p.type;
      return t !== "tool-call" && t !== "tool-result";
    });

    // Optionally prune empty text parts
    const cleaned = filtered.filter((p) => {
      if (p.type === "text") return typeof p.text === "string" && p.text.trim();
      return true;
    });

    // If nothing remains (e.g., assistant only had tool calls), skip
    if (cleaned.length === 0) continue;

    out.push({
      role: m.role,
      content: cleaned,
    });
  }

  return out;
}
