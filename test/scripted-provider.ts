// Test-only model provider for the live runs. It plays a script instead of calling a model, so real
// omp runs its real tools, hooks, settings, and memory without network access, and it records every
// request it receives: exactly what a model would have seen.
//   SCRIPTED_PROVIDER_SCRIPT  JSON file: { "steps": [{ "toolCalls": [{ "name", "arguments" }] } | { "text" }],
//                             "summary": "…" }. Main request N plays step N; once the steps run out it
//                             answers "done". A compaction summary request (omp's summarization system
//                             prompt) is answered with `summary` and uses no step.
//   SCRIPTED_PROVIDER_LOG     JSONL file; each request's kind, system prompt, and messages are appended.
// omp resolves the @oh-my-pi imports to its own copies when it loads this file.
import * as fs from "node:fs";
import type { Api, AssistantMessage, Context, Model, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export interface ScriptStep {
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
	text?: string;
}

interface Script {
	steps?: ScriptStep[];
	summary?: string;
}

/** How omp's summarization system prompt for compaction begins. */
const SUMMARIZATION_PROMPT = "Summarize user";

let requests = 0;
let mainRequests = 0;

function script(): Script {
	const file = process.env.SCRIPTED_PROVIDER_SCRIPT;
	if (!file) return {};
	return JSON.parse(fs.readFileSync(file, "utf8")) as Script;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as Usage;
}

function play(model: Model<Api>, context: Context) {
	const index = requests++;
	const loaded = script();
	const kind = (context.systemPrompt ?? []).join("\n").startsWith(SUMMARIZATION_PROMPT) ? "summary" : "main";
	const log = process.env.SCRIPTED_PROVIDER_LOG;
	if (log) {
		const entry = { request: index, kind, systemPrompt: context.systemPrompt ?? [], messages: context.messages };
		fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
	}
	const step: ScriptStep =
		kind === "summary" ? { text: loaded.summary ?? "## Goal\n- (scripted summary)" } : (loaded.steps?.[mainRequests++] ?? { text: "done" });
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	if (step.toolCalls && step.toolCalls.length > 0) {
		for (const [n, call] of step.toolCalls.entries()) {
			const toolCall: ToolCall = { type: "toolCall", id: `scripted-${index}-${n}`, name: call.name, arguments: call.arguments };
			message.content.push(toolCall);
			const contentIndex = message.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex, partial: message });
			stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: message });
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
		}
		message.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message });
	} else {
		const text = step.text ?? "done";
		message.content.push({ type: "text", text });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	}
	return stream;
}

export default function scriptedProvider(pi: ExtensionAPI): void {
	pi.registerProvider("scripted", {
		api: "scripted" as Api,
		baseUrl: "http://127.0.0.1:9",
		apiKey: "SCRIPTED_PROVIDER_KEY",
		streamSimple: play,
		models: [
			{
				id: "scripted",
				name: "Scripted test model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			},
		],
	});
}
