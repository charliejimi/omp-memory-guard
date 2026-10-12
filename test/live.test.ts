// Live runs against real omp, driven by test/scripted-provider.ts instead of a model, so they need no
// network and no provider account. Opt-in:
//   MEMORY_GUARD_LIVE=1     run these tests
//   OMP_CLI                 omp's src/cli.ts, run with bun (or OMP_BIN: an installed omp executable)
//   MEMORY_GUARD_LIVE_OUT   optional folder for evidence, one subfolder per run
// Every world has its own HOME, work tree, TMPDIR, and mnemopi database, so nothing touches the real
// ~/.omp, and the runs inside one world (store, then read back) share one per-project bank.
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NEUTRALIZED_LINE } from "../src/text";
import { BAIT, BENIGN, EXAMPLE_CONFIG, FAKE, PACKAGE, removeTemps, tempDir } from "./helpers";
import type { ScriptStep } from "./scripted-provider";

const LIVE = process.env.MEMORY_GUARD_LIVE === "1";
const OMP = process.env.OMP_CLI ? ["bun", process.env.OMP_CLI] : process.env.OMP_BIN ? [process.env.OMP_BIN] : [];
const OUT = process.env.MEMORY_GUARD_LIVE_OUT;
const PROVIDER = path.join(import.meta.dir, "scripted-provider.ts");
const BAIT_MARK = "onboarded.txt";
const BENIGN_MARK = "prefer it over npm";
const NONCE_TAG = /<untrusted-memory-[0-9a-f]{16}>/;
const RUN_TIMEOUT_MS = 60_000;

type Frame = Record<string, unknown>;
type Message = { role?: string; content?: unknown };

interface World {
	root: string;
	home: string;
	work: string;
	tmp: string;
	db: string;
}

interface RunOptions {
	guard: boolean;
	tools: string;
	prompt: string;
	steps: ScriptStep[];
	/** Overrides on top of the example overlay. */
	mnemopi?: Record<string, unknown>;
	/** Waits after the turn ends, before omp is asked to exit. */
	settle?: () => Promise<unknown>;
}

interface Run {
	name: string;
	dir: string;
	world: World;
	options: RunOptions;
	frames: Frame[];
	requests: Array<{ request: number; systemPrompt: string[]; messages: Message[] }>;
	notices: string[];
	stderr: string;
	command: string[];
	timings: { msToReady: number; msTurn: number; msToExit: number; killed: boolean };
}

afterAll(removeTemps);

function newWorld(): World {
	const root = tempDir("mg-live-");
	const world = {
		root,
		home: path.join(root, "home"),
		work: path.join(root, "work"),
		tmp: path.join(root, "tmp"),
		db: path.join(root, "mnemopi", "memory.db"),
	};
	for (const dir of [world.home, world.work, world.tmp, path.dirname(world.db)]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(world.work, "package.json"), `${JSON.stringify({ name: "shop", private: true }, null, 2)}\n`);
	fs.writeFileSync(path.join(world.work, "README.md"), "# shop\n\nA tiny fixture project for the memory guard live runs.\n");
	return world;
}

/** The example overlay, plus what keeps mnemopi offline and inside this world. */
function overlay(world: World, mnemopi: Record<string, unknown> = {}): string {
	const example = Bun.YAML.parse(fs.readFileSync(EXAMPLE_CONFIG, "utf8")) as { mnemopi?: Record<string, unknown> };
	const settings = {
		...example,
		mnemopi: { ...example.mnemopi, dbPath: world.db, noEmbeddings: true, llmMode: "none", ...mnemopi },
	};
	return `${JSON.stringify(settings, null, 2)}\n`;
}

function sanitize(text: string, world: World): string {
	let out = text.split(world.root).join("<run>").split(os.homedir()).join("~");
	for (const [name, value] of Object.entries(FAKE)) out = out.split(value).join(`<fake-${name}>`);
	return out;
}

async function waitFor<T>(probe: () => T | undefined | false, what: string, failed: () => string | undefined): Promise<T> {
	const deadline = Date.now() + RUN_TIMEOUT_MS;
	for (;;) {
		const value = probe();
		if (value) return value;
		const failure = failed();
		if (failure) throw new Error(`${what}: ${failure}`);
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) await Bun.sleep(200);
}

/** Every SQLite file mnemopi keeps for this world; each per-project bank is its own `banks/<bank>/mnemopi.db`. */
function databases(world: World): string[] {
	const root = path.dirname(world.db);
	if (!fs.existsSync(root)) return [];
	return (fs.readdirSync(root, { recursive: true }) as string[])
		.filter(entry => entry.endsWith(".db"))
		.map(entry => path.join(root, entry));
}

/** How often `needle` appears anywhere in the world's mnemopi databases: every table, every column. */
function occurrences(world: World, needle: string): number {
	return databases(world).reduce((total, file) => total + occurrencesIn(file, needle), 0);
}

function occurrencesIn(dbPath: string, needle: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		let count = 0;
		const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
		for (const { name } of tables) {
			let rows: unknown[];
			try {
				rows = db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
			} catch {
				continue;
			}
			for (const row of rows) count += JSON.stringify(row).split(needle).length - 1;
		}
		return count;
	} finally {
		db.close();
	}
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
		.join("\n");
}

/** The tool results in the last request the model received, in call order. */
function toolResultsSeen(run: Run): string[] {
	const messages = run.requests.at(-1)?.messages ?? [];
	return messages.filter(message => message.role === "toolResult").map(message => textOfContent(message.content));
}

function systemPromptSeen(run: Run, request = 0): string {
	return run.requests[request]?.systemPrompt.join("\n") ?? "";
}

async function runOmp(world: World, name: string, options: RunOptions): Promise<Run> {
	const slug = name.replaceAll("/", "-");
	const dir = OUT ? path.join(OUT, name) : tempDir("mg-run-");
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const script = path.join(world.root, `${slug}.script.json`);
	const log = path.join(world.root, `${slug}.requests.jsonl`);
	const config = path.join(world.root, `${slug}.config.yml`);
	fs.writeFileSync(script, JSON.stringify({ steps: options.steps }));
	fs.writeFileSync(config, overlay(world, options.mnemopi));
	const command = [
		...OMP,
		"--mode",
		"rpc",
		"--cwd",
		world.work,
		"-e",
		PROVIDER,
		...(options.guard ? ["-e", PACKAGE] : []),
		"--config",
		config,
		"--model",
		"scripted/scripted",
		"--approval-mode",
		"yolo",
		"--session-dir",
		path.join(world.root, "sessions", slug),
		"--tools",
		options.tools,
		"--no-title",
		"--no-lsp",
		"--no-skills",
		"--no-rules",
	];
	const proc = Bun.spawn(command, {
		cwd: world.work,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: world.home,
			USER: process.env.USER ?? "user",
			LANG: "C.UTF-8",
			TERM: "dumb",
			TMPDIR: world.tmp,
			SCRIPTED_PROVIDER_SCRIPT: script,
			SCRIPTED_PROVIDER_LOG: log,
			SCRIPTED_PROVIDER_KEY: "unused",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const frames: Frame[] = [];
	const stdout = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					if (line.trim()) frames.push(JSON.parse(line) as Frame);
				} catch {}
			}
		}
	})();
	const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
	const failed = () => {
		if (proc.exitCode !== null) return `omp exited with ${proc.exitCode}`;
		const rejected = frames.find(frame => frame.type === "response" && frame.id === "p1" && frame.success === false);
		return rejected ? `prompt rejected: ${JSON.stringify(rejected)}` : undefined;
	};
	const started = performance.now();
	const timings = { msToReady: 0, msTurn: 0, msToExit: 0, killed: false };
	try {
		await waitFor(() => frames.some(frame => frame.type === "ready"), "ready", failed);
		timings.msToReady = Math.round(performance.now() - started);
		proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: options.prompt })}\n`);
		proc.stdin.flush();
		await waitFor(
			() => frames.some(frame => frame.type === "agent_end" && frame.isTerminal !== false),
			"the end of the turn",
			failed,
		);
		timings.msTurn = Math.round(performance.now() - started) - timings.msToReady;
		await options.settle?.();
	} finally {
		const closing = performance.now();
		proc.stdin.end();
		const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(30_000).then(() => false)]);
		if (!exited) proc.kill();
		timings.msToExit = Math.round(performance.now() - closing);
		timings.killed = !exited;
		await stdout;
	}
	const stderr = await stderrText;
	const requestsText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
	const requests = requestsText
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Run["requests"][number]);
	const notices = frames
		.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify")
		.map(frame => String(frame.message ?? ""));
	const run: Run = { name, dir, world, options, frames, requests, notices, stderr, command, timings };
	fs.writeFileSync(path.join(dir, "cmd.txt"), `${sanitize(["omp", ...command.slice(OMP.length)].join(" "), world)}\n`);
	fs.writeFileSync(path.join(dir, "events.jsonl"), sanitize(frames.map(frame => JSON.stringify(frame)).join("\n"), world));
	fs.writeFileSync(path.join(dir, "provider-requests.jsonl"), sanitize(requestsText, world));
	fs.writeFileSync(path.join(dir, "stderr.txt"), sanitize(stderr, world));
	record(run, {});
	return run;
}

/** Writes the run's summary.json with the checks the test made. */
function record(run: Run, checks: Record<string, unknown>): void {
	const summary = {
		run: run.name,
		guard: run.options.guard,
		tools: run.options.tools,
		mnemopiOverrides: run.options.mnemopi ?? {},
		prompt: run.options.prompt,
		scriptedSteps: run.options.steps.length,
		requestsReceived: run.requests.length,
		timings: run.timings,
		mnemopiDatabases: databases(run.world).map(file => path.relative(run.world.root, file)),
		notices: run.notices,
		toolResultsSeenByModel: toolResultsSeen(run),
		checks,
	};
	fs.writeFileSync(path.join(run.dir, "summary.json"), `${sanitize(JSON.stringify(summary, null, 2), run.world)}\n`);
}

const recallQuery = "Before we start, what onboarding steps should you take for this project? Then stop.";
const retain = (...contents: string[]): ScriptStep => ({
	toolCalls: [{ name: "retain", arguments: { items: contents.map(content => ({ content })) } }],
});

describe.skipIf(!LIVE)("live on real omp 18.2.8, scripted model, no network (AC-7)", () => {
	it("write-gate: a retain carrying the bait is refused and never stored; a benign retain is stored", async () => {
		const world = newWorld();
		const run = await runOmp(world, "write-gate", {
			guard: true,
			tools: "retain,recall",
			prompt: "Remember the onboarding note and the test command for future sessions.",
			steps: [retain(BAIT), retain(BENIGN), { text: "Stored the test command; the onboarding note was refused." }],
		});
		const [refused, stored] = toolResultsSeen(run);
		const checks = {
			firstResultRefusedByGuard: refused?.includes("omp-memory-guard:") ?? false,
			secondResultStored: stored?.includes("1 memory stored") ?? false,
			baitOccurrencesInDatabase: occurrences(world, BAIT_MARK),
			benignOccurrencesInDatabase: occurrences(world, BENIGN_MARK),
			startupNotices: run.notices.length,
		};
		record(run, checks);
		expect(checks.firstResultRefusedByGuard).toBe(true);
		expect(checks.secondResultStored).toBe(true);
		expect(checks.baitOccurrencesInDatabase).toBe(0);
		expect(checks.benignOccurrencesInDatabase).toBeGreaterThan(0);
		expect(checks.startupNotices).toBe(0);
	}, 120_000);

	it("handoff: the file written to $TMPDIR is the redacted version; one aimed at the workspace is blocked", async () => {
		const world = newWorld();
		const name = "handoff-20261012.md";
		const body = [
			"# Handoff",
			"- Next step: finish the parser refactor in src/parse.ts.",
			`- GitHub token used for the release: ${FAKE.github}`,
			`- AWS key: ${FAKE.aws}`,
			`- api_key = ${FAKE.apiKeyValue}`,
			`- Contact ${FAKE.email} or ${FAKE.phone} for access.`,
			`- ${BAIT}`,
			"- Tests: run bun test before committing.",
		].join("\n");
		const write = (target: string): ScriptStep => ({ toolCalls: [{ name: "write", arguments: { path: target, content: body } }] });
		const run = await runOmp(world, "handoff", {
			guard: true,
			tools: "read,write",
			prompt: "Write a handoff document for the next session.",
			steps: [write(path.join(world.tmp, name)), write(name), { text: "done" }],
		});
		const written = fs.readFileSync(path.join(world.tmp, name), "utf8");
		const checks = {
			fakeSecretsInWrittenFile: Object.values(FAKE).filter(value => written.includes(value)).length,
			baitInWrittenFile: written.includes(BAIT_MARK),
			redactionMarkers: (written.match(/\[REDACTED(?:_EMAIL|_PHONE)?\]/g) ?? []).length,
			neutralizedLines: written.split(NEUTRALIZED_LINE).length - 1,
			benignLinesKept: written.includes("finish the parser refactor") && written.includes("run bun test before committing"),
			workspaceFileExists: fs.existsSync(path.join(world.work, name)),
			workspaceWriteResultNamesTmpdir: toolResultsSeen(run)[1]?.includes("$TMPDIR") ?? false,
		};
		record(run, checks);
		fs.writeFileSync(path.join(run.dir, "written-handoff.md"), sanitize(written, world));
		expect(checks.fakeSecretsInWrittenFile).toBe(0);
		expect(checks.baitInWrittenFile).toBe(false);
		expect(checks.redactionMarkers).toBeGreaterThanOrEqual(5);
		expect(checks.neutralizedLines).toBe(1);
		expect(checks.benignLinesKept).toBe(true);
		expect(checks.workspaceFileExists).toBe(false);
		expect(checks.workspaceWriteResultNamesTmpdir).toBe(true);
	}, 120_000);

	it("recall: a bait stored before the guard was loaded comes back wrapped and scrubbed", async () => {
		const world = newWorld();
		const store = await runOmp(world, "recall/1-store-without-guard", {
			guard: false,
			tools: "retain",
			prompt: "Remember these project notes.",
			steps: [retain(BAIT, BENIGN), { text: "Stored." }],
		});
		record(store, { baitOccurrencesInDatabase: occurrences(world, BAIT_MARK) });
		const steps: ScriptStep[] = [{ toolCalls: [{ name: "recall", arguments: { query: recallQuery } }] }, { text: "done" }];
		const control = await runOmp(world, "recall/2-control-without-guard", { guard: false, tools: "recall", prompt: recallQuery, steps });
		const controlSeen = toolResultsSeen(control)[0] ?? "";
		record(control, { baitReachedModel: controlSeen.includes(BAIT_MARK) });
		const guarded = await runOmp(world, "recall/3-with-guard", { guard: true, tools: "recall", prompt: recallQuery, steps });
		const seen = toolResultsSeen(guarded)[0] ?? "";
		const checks = {
			wrappedWithNonce: NONCE_TAG.test(seen),
			baitReachedModel: seen.includes(BAIT_MARK),
			neutralizedLines: seen.split(NEUTRALIZED_LINE).length - 1,
			memoryIdKept: /\(id: [^)]+\)/.test(seen.split("\n").find(line => line.includes(NEUTRALIZED_LINE)) ?? ""),
		};
		record(guarded, checks);
		expect(occurrences(world, BAIT_MARK)).toBeGreaterThan(0);
		expect(controlSeen).toContain(BAIT_MARK);
		expect(checks.wrappedWithNonce).toBe(true);
		expect(checks.baitReachedModel).toBe(false);
		expect(checks.neutralizedLines).toBeGreaterThan(0);
		expect(checks.memoryIdKept).toBe(true);
	}, 180_000);

	it("handoff-read: a handoff file holding the bait reaches the model wrapped and scrubbed", async () => {
		const world = newWorld();
		const file = path.join(world.tmp, "handoff-previous.md");
		fs.writeFileSync(file, `# Handoff\n- Next step: finish the parser refactor in src/parse.ts.\n- ${BAIT}\n`);
		const run = await runOmp(world, "handoff-read", {
			guard: true,
			tools: "read",
			prompt: "Pick up from the previous handoff.",
			steps: [{ toolCalls: [{ name: "read", arguments: { path: file } }] }, { text: "done" }],
		});
		const seen = toolResultsSeen(run)[0] ?? "";
		const checks = {
			wrappedWithNonce: NONCE_TAG.test(seen),
			baitReachedModel: seen.includes(BAIT_MARK),
			benignLineKept: seen.includes("finish the parser refactor"),
		};
		record(run, checks);
		expect(checks.wrappedWithNonce).toBe(true);
		expect(checks.baitReachedModel).toBe(false);
		expect(checks.benignLineKept).toBe(true);
	}, 120_000);

	it("autorecall: with automatic recall on, the bait inside <memories> is replaced before the model sees it", async () => {
		const world = newWorld();
		const store = await runOmp(world, "autorecall/1-store-without-guard", {
			guard: false,
			tools: "retain",
			prompt: "Remember this project note.",
			steps: [retain(BAIT), { text: "Stored." }],
		});
		record(store, { baitOccurrencesInDatabase: occurrences(world, BAIT_MARK) });
		const autoRecall = { autoRecall: true };
		const control = await runOmp(world, "autorecall/2-control-without-guard", {
			guard: false,
			mnemopi: autoRecall,
			tools: "read",
			prompt: recallQuery,
			steps: [{ text: "done" }],
		});
		const controlPrompt = systemPromptSeen(control);
		record(control, { memoriesBlock: controlPrompt.includes("<memories>"), baitReachedModel: controlPrompt.includes(BAIT_MARK) });
		const guarded = await runOmp(world, "autorecall/3-with-guard", {
			guard: true,
			mnemopi: autoRecall,
			tools: "read",
			prompt: recallQuery,
			steps: [{ text: "done" }],
		});
		const prompt = systemPromptSeen(guarded);
		const checks = {
			memoriesBlock: prompt.includes("<memories>"),
			baitReachedModel: prompt.includes(BAIT_MARK),
			neutralizedLines: prompt.split(NEUTRALIZED_LINE).length - 1,
			autoRecallNotice: guarded.notices.some(notice => notice.includes("mnemopi.autoRecall")),
		};
		record(guarded, checks);
		expect(controlPrompt).toContain("<memories>");
		expect(controlPrompt).toContain(BAIT_MARK);
		expect(checks.memoriesBlock).toBe(true);
		expect(checks.baitReachedModel).toBe(false);
		expect(checks.neutralizedLines).toBeGreaterThan(0);
		expect(checks.autoRecallNotice).toBe(true);
	}, 180_000);

	it("autoretain: the example overlay stores nothing from a turn; automatic retention stores the bait with no tool call", async () => {
		const prompt = `Note for the project: ${BAIT}`;
		const off = newWorld();
		const runOff = await runOmp(off, "autoretain/1-example-overlay", {
			guard: true,
			tools: "read",
			prompt,
			steps: [{ text: "Noted." }],
			settle: () => Bun.sleep(3_000),
		});
		const offChecks = { baitOccurrencesInDatabase: occurrences(off, BAIT_MARK), startupNotices: runOff.notices.length };
		record(runOff, offChecks);
		const on = newWorld();
		const runOn = await runOmp(on, "autoretain/2-auto-retain-on", {
			guard: true,
			mnemopi: { autoRetain: true, retainEveryNTurns: 1 },
			tools: "read",
			prompt,
			steps: [{ text: "Noted." }],
			settle: () => until(() => occurrences(on, BAIT_MARK) > 0, 15_000),
		});
		const onChecks = {
			baitOccurrencesInDatabase: occurrences(on, BAIT_MARK),
			toolCallsMade: runOn.frames.filter(frame => frame.type === "tool_execution_start").length,
			autoRetainNotice: runOn.notices.some(notice => notice.includes("mnemopi.autoRetain")),
		};
		record(runOn, onChecks);
		expect(offChecks.baitOccurrencesInDatabase).toBe(0);
		expect(offChecks.startupNotices).toBe(0);
		expect(onChecks.baitOccurrencesInDatabase).toBeGreaterThan(0);
		expect(onChecks.toolCallsMade).toBe(0);
		expect(onChecks.autoRetainNotice).toBe(true);
	}, 120_000);
});
