export interface FlowStep {
  tool: "schedule" | "http" | "gmail" | "sheets" | "telegram" | "whatsapp" | "custom";
  action: string;
  args: Record<string, string>;
  say_en: string;
}

export interface FlowPlan {
  title_en: string;
  confirm_en: string;
  trigger_en: string;
  steps: FlowStep[];
}

export const ALLOWED_TOOLS = ["schedule", "http", "gmail", "sheets", "telegram", "whatsapp", "custom"] as const;

export function safeParsePlan(jsonText: string): FlowPlan {
  // LLM often wraps JSON in ```json fences — strip them
  const cleaned = jsonText.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Planner did not return JSON");
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as FlowPlan;
  if (!obj.title_en || !Array.isArray(obj.steps)) throw new Error("Invalid plan shape");
  for (const s of obj.steps) {
    if (!(ALLOWED_TOOLS as readonly string[]).includes(s.tool)) {
      throw new Error(`Unknown tool ${s.tool}. Allowed: ${ALLOWED_TOOLS.join(",")}`);
    }
  }
  return obj;
}

export function uid(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
