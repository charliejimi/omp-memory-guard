import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { configNotices } from "../src/index";
import { EXAMPLE_CONFIG, PACKAGE, closeRegistry, initSettings, loadGuard, removeTemps, tempDir } from "./helpers";

afterEach(() => {
	resetSettingsForTest();
	removeTemps();
});
afterAll(closeRegistry);

const RECOMMENDED = {
	"memory.backend": "mnemopi",
	"mnemopi.autoRecall": false,
	"mnemopi.autoRetain": false,
	"mnemopi.scoping": "per-project",
	extensions: [PACKAGE],
};

describe("example overlay (AC-5)", () => {
	it("turns automatic recall and retention off through omp's own settings loader", async () => {
		const settings = await initSettings(tempDir("mg-cfg-"), {}, [EXAMPLE_CONFIG]);
		expect(settings.get("memory.backend")).toBe("mnemopi");
		expect(settings.get("mnemopi.autoRecall")).toBe(false);
		expect(settings.get("mnemopi.autoRetain")).toBe(false);
		expect(settings.get("mnemopi.scoping")).toBe("per-project");
	});

	it("does not take the same keys written flat, which is why the example nests them", async () => {
		const dir = tempDir("mg-cfg-");
		const flat = path.join(dir, "flat.yml");
		fs.writeFileSync(flat, "memory.backend: mnemopi\nmnemopi.autoRecall: false\nmnemopi.autoRetain: false\n");
		const settings = await initSettings(dir, {}, [flat]);
		expect(settings.get("mnemopi.autoRecall")).toBe(true);
		expect(settings.get("mnemopi.autoRetain")).toBe(true);
	});
});

describe("startup notices (AC-5)", () => {
	async function noticesWith(overrides: Record<string, unknown>) {
		const cwd = tempDir("mg-notice-");
		await initSettings(cwd, { ...RECOMMENDED, ...overrides });
		const loaded = await loadGuard([PACKAGE], cwd);
		expect(await loaded.toolCall("read", { path: "README.md" })).toBeUndefined();
		expect(loaded.handlerErrors).toEqual([]);
		return loaded.notices;
	}

	it("says nothing when omp runs the recommended settings with the guard loaded last", async () => {
		expect(await noticesWith({})).toEqual([]);
	});

	const cases: Array<[string, Record<string, unknown>, string]> = [
		["automatic retention on", { "mnemopi.autoRetain": true }, "mnemopi.autoRetain"],
		["automatic recall on", { "mnemopi.autoRecall": true }, "mnemopi.autoRecall"],
		["one global bank", { "mnemopi.scoping": "global" }, "mnemopi.scoping"],
		["project writes with shared recall", { "mnemopi.scoping": "per-project-tagged" }, "mnemopi.scoping"],
		["the local backend", { "memory.backend": "local" }, "local"],
		["another extension listed after the guard", { extensions: [PACKAGE, "/opt/omp-extensions/team-memory"] }, "load order"],
		["the guard missing from a non-empty extensions list", { extensions: ["/opt/omp-extensions/team-memory"] }, "load order"],
	];
	for (const [name, overrides, named] of cases) {
		it(`warns about ${name}, naming ${named}, without blocking tools`, async () => {
			const notices = await noticesWith(overrides);
			expect(notices.length).toBe(1);
			expect(notices[0]!.type).toBe("warning");
			expect(notices[0]!.message).toContain(named);
		});
	}
});

describe("load order from the command line (AC-5, A4)", () => {
	const self = [PACKAGE, path.join(PACKAGE, "src", "index.ts")];
	const settings = (extensions: string[]) => (key: string) => ({ ...RECOMMENDED, extensions })[key as keyof typeof RECOMMENDED];

	it("accepts the guard as the last -e when the settings list no extensions", () => {
		expect(configNotices(settings([]), ["-e", "/opt/x", "-e", PACKAGE], self, "/")).toEqual([]);
		expect(configNotices(settings([]), [`--extension=${PACKAGE}/src/index.ts`], self, "/")).toEqual([]);
	});

	it("warns when another -e comes after the guard", () => {
		const notices = configNotices(settings([]), ["-e", PACKAGE, "--extension", "/opt/x"], self, "/");
		expect(notices.join("\n")).toContain("load order");
	});

	it("resolves relative entries against the working directory", () => {
		const parent = path.dirname(PACKAGE);
		expect(configNotices(settings([path.basename(PACKAGE)]), [], self, parent)).toEqual([]);
	});

	it("reports settings it cannot read instead of throwing", () => {
		const unreadable = () => {
			throw new Error("Settings not initialized");
		};
		expect(configNotices(unreadable, [], self, "/").join("\n")).toContain("could not be read");
	});
});
