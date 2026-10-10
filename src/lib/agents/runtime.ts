import type { AgentName } from '../types';

/** A capability an agent may use. `run` is plain code — it is where money and stock rules live. */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown;
}

export interface AgentSpec {
  name: AgentName;
  system: string;
  tools: Tool[];
  /** Model round-trips allowed before the agent is cut off. */
  maxSteps?: number;
  /** Checked after each round of tool calls; when true the agent is finished and no further model call is made. */
  done?: () => boolean;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/** LLM_MODEL may list several models, comma-separated. Free tiers limit each model separately. */
const models = () => (process.env.LLM_MODEL ?? '').split(',').map((m) => m.trim()).filter(Boolean);

export function llmConfigured(): boolean {
  return !!(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && models().length);
}

export class RateLimited extends Error {}

// When a model answers "rate limit reached" it is rested until the time it
// gave, and the next model in the list takes over. Kept on globalThis so every
// route sees the same clocks.
const g = globalThis as unknown as { __streamsenseCooling?: Map<string, number> };
const cooling = (g.__streamsenseCooling ??= new Map<string, number>());

/** When agents can run again, or undefined if at least one model is available now. */
export function agentsRestingUntil(): number | undefined {
  const list = models();
  const times = list.map((m) => cooling.get(m) ?? 0);
  return list.length && times.every((t) => t > Date.now()) ? Math.min(...times) : undefined;
}

export function clearCooling(): void {
  cooling.clear();
}

async function chat(messages: WireMessage[], tools: Tool[]): Promise<WireMessage> {
  const available = models().filter((m) => (cooling.get(m) ?? 0) <= Date.now());
  if (available.length === 0) throw new RateLimited('every model is rate-limited');

  for (const model of available) {
    const res = await fetch(`${process.env.LLM_BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` },
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS) || 8000),
      body: JSON.stringify({
        model,
        temperature: 0,
        ...(process.env.LLM_REASONING_EFFORT ? { reasoning_effort: process.env.LLM_REASONING_EFFORT } : {}),
        messages,
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto',
      }),
    });
    if (res.status === 429) {
      const wait = Math.min(Math.max(Number(res.headers.get('retry-after')) || 20, 2), 120);
      cooling.set(model, Date.now() + wait * 1000);
      console.warn(`[agents] ${model} is rate-limited for ${wait}s`);
      continue;
    }
    if (!res.ok) throw new Error(`model returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const msg = body?.choices?.[0]?.message;
    if (!msg) throw new Error('model returned no message');
    return { role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls };
  }
  throw new RateLimited('every model is rate-limited');
}

/**
 * The agent loop: the model reads the situation, picks tools, sees what each
 * tool returned, and decides again — until it stops calling tools or runs out
 * of steps. Nothing here is scripted; the trace is whatever the model chose.
 */
export async function runAgent(spec: AgentSpec, input: unknown): Promise<ToolCallRecord[]> {
  const messages: WireMessage[] = [
    { role: 'system', content: spec.system },
    { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
  ];
  const trace: ToolCallRecord[] = [];

  for (let step = 0; step < (spec.maxSteps ?? 4); step++) {
    const reply = await chat(messages, spec.tools);
    messages.push(reply);
    if (!reply.tool_calls?.length) break;

    for (const call of reply.tool_calls) {
      const tool = spec.tools.find((t) => t.name === call.function.name);
      let args: Record<string, unknown> = {};
      let result: unknown;
      try {
        args = JSON.parse(call.function.arguments || '{}');
        result = tool ? tool.run(args) : { error: `unknown tool ${call.function.name}` };
      } catch (err) {
        result = { error: (err as Error).message };
      }
      trace.push({ tool: call.function.name, args, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result ?? null) });
    }
    if (spec.done?.()) break;
  }
  return trace;
}
