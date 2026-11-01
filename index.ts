/**
 * session-board — opencode-style session switching for omp, backed by tmux.
 *
 * One omp process runs one session, so concurrency comes from tmux: every
 * session lives in its own pane. Sessions you are not looking at sit in a
 * detached tmux session named `omp-pool` and keep running.
 *
 *   Ctrl+X L   session switcher, grouped: Done (recently finished first, plus
 *              anything waiting on you), Working, and Saved (collapsed; Tab
 *              toggles, typing a filter searches them too). ↑/↓ to move,
 *              Enter to open, Ctrl+N new, Esc close. Opening swaps the chosen
 *              session into the current pane; the one you leave keeps running
 *              in the pool.
 *   Ctrl+X N   new session in the current directory, swapped into this pane.
 *   /board     same switcher as Ctrl+X L.
 *
 * Every interactive omp publishes its state to `<agentDir>/session-board/<pid>.json`
 * and polls the others, which drives the switcher's live status, the footer
 * summary, and toasts when another session finishes, fails, or waits on you.
 */
import type { ExtensionAPI, ExtensionContext as Ctx } from "@oh-my-pi/pi-coding-agent";
import { type Component, isKeyRelease, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type State = "idle" | "working" | "waiting" | "done" | "error" | "aborted";

interface Entry {
	pid: number;
	state: State;
	since: number; // ms epoch of last state change
	seen: boolean; // user has interacted since the run settled
	title: string;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	lastText?: string; // last assistant text, truncated
	tmuxPane?: string; // e.g. "%12"
	tty?: string;
}

type Group = "done" | "working" | "saved";

/** One selectable row in the switcher: a live process or a saved session file. */
interface Row {
	title: string;
	cwd: string;
	since: number;
	group: Group;
	live?: Entry;
	file?: string; // saved session to resume (non-live rows)
}

type Pick = { row: Row } | { newSession: true };

const POLL_MS = 2000;
const LEADER_TIMEOUT_MS = 1500;
const SNIPPET = 90;
const MAX_SAVED = 200;
const POOL = "omp-pool";

const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
const boardDir = path.join(agentDir, "session-board");
const sessionsDir = path.join(agentDir, "sessions");
const ownFile = path.join(boardDir, `${process.pid}.json`);

const ICON: Record<State, string> = {
	idle: "·",
	working: "⏳",
	waiting: "❓",
	done: "✓",
	error: "✗",
	aborted: "⊘",
};

const GROUP_ORDER: Group[] = ["done", "working", "saved"];
const GROUP_LABEL: Record<Group, string> = { done: "Done", working: "Working", saved: "Saved" };

const STATE_COLOR: Record<State, string> = {
	idle: "dim",
	working: "accent",
	waiting: "warning",
	done: "success",
	error: "error",
	aborted: "muted",
};

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readBoard(): Entry[] {
	let names: string[];
	try {
		names = fs.readdirSync(boardDir);
	} catch {
		return [];
	}
	const out: Entry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(boardDir, name);
		try {
			const entry = JSON.parse(fs.readFileSync(file, "utf8")) as Entry;
			if (!isAlive(entry.pid)) {
				fs.rmSync(file, { force: true }); // crashed/killed process
				continue;
			}
			out.push(entry);
		} catch {
			// partially written or foreign file; skip
		}
	}
	return out;
}

/** Saved sessions across all projects, newest first. Reads only the first 4KB of each file. */
function readSaved(exclude: Set<string>): Row[] {
	const files: Array<{ file: string; mtime: number }> = [];
	let dirs: string[];
	try {
		dirs = fs.readdirSync(sessionsDir);
	} catch {
		return [];
	}
	for (const dir of dirs) {
		const full = path.join(sessionsDir, dir);
		let names: string[];
		try {
			names = fs.readdirSync(full);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl") || name.startsWith(".")) continue;
			const file = path.join(full, name);
			if (exclude.has(file)) continue;
			try {
				files.push({ file, mtime: fs.statSync(file).mtimeMs });
			} catch {}
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);

	const rows: Row[] = [];
	const buf = Buffer.alloc(4096);
	for (const { file, mtime } of files.slice(0, MAX_SAVED)) {
		let head: string;
		try {
			const fd = fs.openSync(file, "r");
			const n = fs.readSync(fd, buf, 0, buf.length, 0);
			fs.closeSync(fd);
			head = buf.toString("utf8", 0, n);
		} catch {
			continue;
		}
		let title: string | undefined;
		let cwd: string | undefined;
		for (const line of head.split("\n").slice(0, 2)) {
			try {
				const rec = JSON.parse(line) as { type?: string; title?: string; cwd?: string };
				if (rec.type === "title" || rec.type === "session") title ||= rec.title?.trim();
				if (rec.type === "session") cwd = rec.cwd;
			} catch {}
		}
		if (!cwd) continue; // not a session file we understand
		rows.push({ title: title || "(untitled)", cwd, since: mtime, group: "saved", file });
	}
	return rows;
}

function ago(ms: number): string {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function tmux(args: string[]): { ok: boolean; out: string; err: string } {
	const res = spawnSync("tmux", args, { encoding: "utf8", timeout: 3000 });
	return { ok: res.status === 0, out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim() };
}

function detectTty(): string | undefined {
	const res = spawnSync("tty", [], { encoding: "utf8", stdio: ["inherit", "pipe", "ignore"], timeout: 1000 });
	const tty = res.stdout?.trim();
	return res.status === 0 && tty ? tty : undefined;
}

function assistantText(message: unknown): string | undefined {
	const msg = message as { role?: string; content?: unknown } | undefined;
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return undefined;
	const text = msg.content
		.filter((b: { type?: string }) => b?.type === "text")
		.map((b: { text?: string }) => b.text ?? "")
		.join(" ");
	return text.trim() ? oneLine(text, SNIPPET) : undefined;
}

function settledState(event: unknown): State {
	const messages = (event as { messages?: Array<{ role?: string; stopReason?: string }> })?.messages;
	const last = Array.isArray(messages) ? [...messages].reverse().find(m => m?.role === "assistant") : undefined;
	if (last?.stopReason === "error") return "error";
	if (last?.stopReason === "aborted") return "aborted";
	return "done";
}

/** Bring `target` pane into view. Pool panes are swapped into the current pane; others are jumped to. */
function showPane(target: string): string | undefined {
	const here = process.env.TMUX_PANE;
	if (!here) return "not running inside tmux";
	const where = tmux(["display-message", "-p", "-t", target, "#{session_name}"]);
	if (!where.ok) return where.err || "pane not found";
	const res =
		where.out === POOL
			? tmux(["swap-pane", "-s", target, "-t", here, ";", "select-pane", "-t", target])
			: tmux(["switch-client", "-t", target, ";", "select-window", "-t", target, ";", "select-pane", "-t", target]);
	return res.ok ? undefined : res.err || "tmux failed";
}

/** Start omp in a new pool pane and swap it into view. */
function openInPool(cwd: string, ompArgs: string[], name: string): string | undefined {
	const here = process.env.TMUX_PANE;
	if (!here) return "not running inside tmux";
	// Drop to a shell when omp exits so the pane (and possibly the user's window) doesn't vanish.
	const cmd = `omp ${ompArgs.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}; exec "\${SHELL:-/bin/zsh}" -l`;
	const size = tmux(["display-message", "-p", "-t", here, "#{pane_width} #{pane_height}"]).out.split(" ");
	const created = tmux(["has-session", "-t", `=${POOL}`]).ok
		? tmux(["new-window", "-d", "-t", `=${POOL}:`, "-n", name, "-c", cwd, "-P", "-F", "#{pane_id}", cmd])
		: tmux(["new-session", "-d", "-s", POOL, "-n", name, "-x", size[0] || "200", "-y", size[1] || "50", "-c", cwd, "-P", "-F", "#{pane_id}", cmd]);
	if (!created.ok) return created.err || "could not create pane";
	return showPane(created.out);
}

class Switcher implements Component {
	#query = "";
	#index = 0;
	#showSaved = false;
	#all: Row[] = [];
	#rows: Row[] = [];

	constructor(
		private readonly tui: TUI,
		private readonly theme: { fg(color: string, text: string): string },
		private readonly done: (pick: Pick | undefined) => void,
		private readonly load: () => Row[],
	) {
		this.reload();
	}

	reload() {
		const selected = this.#rows[this.#index];
		this.#all = this.load();
		this.#filter();
		// Keep the cursor on the same row across live refreshes.
		const key = selected?.live?.pid ?? selected?.file;
		const again = this.#rows.findIndex(r => (r.live?.pid ?? r.file) === key);
		if (again >= 0) this.#index = again;
		this.tui.requestRender();
	}

	/** Saved sessions are hidden unless toggled with Tab or a filter is typed. */
	#filter() {
		const q = this.#query.toLowerCase();
		this.#rows = q
			? this.#all.filter(r => `${r.title} ${path.basename(r.cwd)} ${r.live?.lastText ?? ""}`.toLowerCase().includes(q))
			: this.#showSaved
				? this.#all
				: this.#all.filter(r => r.group !== "saved");
		this.#index = Math.min(this.#index, Math.max(0, this.#rows.length - 1));
	}

	handleInput(data: string) {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(undefined);
		if (matchesKey(data, "enter")) {
			const row = this.#rows[this.#index];
			return row ? this.done({ row }) : undefined;
		}
		if (matchesKey(data, "ctrl+n")) return this.done({ newSession: true });
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			this.#index = Math.max(0, this.#index - 1);
		} else if (matchesKey(data, "down")) {
			this.#index = Math.min(this.#rows.length - 1, this.#index + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.#index = Math.max(0, this.#index - this.#visible());
		} else if (matchesKey(data, "pageDown")) {
			this.#index = Math.min(this.#rows.length - 1, this.#index + this.#visible());
		} else if (matchesKey(data, "tab")) {
			this.#showSaved = !this.#showSaved;
			const firstSaved = this.#all.findIndex(r => r.group === "saved");
			this.#filter();
			// Opening the saved section jumps to it; closing it keeps the cursor in range.
			if (this.#showSaved && !this.#query && firstSaved >= 0) this.#index = firstSaved;
		} else if (matchesKey(data, "backspace")) {
			this.#query = this.#query.slice(0, -1);
			this.#filter();
		} else if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.#query += data;
			this.#index = 0;
			this.#filter();
		} else {
			return;
		}
		this.tui.requestRender();
	}

	#visible(): number {
		return Math.max(5, Math.min(20, this.tui.terminal.rows - 8));
	}

	#rowLine(r: Row, sel: boolean, width: number): string {
		const t = this.theme;
		const e = r.live;
		const status = e
			? t.fg(STATE_COLOR[e.state], `${ICON[e.state]} ${e.state.padEnd(7)}`)
			: t.fg("dim", "  saved  ");
		const unseen = e && !e.seen ? t.fg("warning", "•") : " ";
		const titleWidth = Math.max(20, Math.min(50, width - 45));
		const title = oneLine(r.title, titleWidth);
		const titleCell = title + " ".repeat(Math.max(0, titleWidth - visibleWidth(title)));
		const extra = e?.lastText ? t.fg("dim", `— ${e.lastText}`) : "";
		const titleStyled = sel ? t.fg("accent", titleCell) : e ? titleCell : t.fg("muted", titleCell);
		return `${sel ? t.fg("accent", " ▸ ") : "   "}${status} ${unseen} ${t.fg("dim", ago(r.since).padStart(3))}  ${titleStyled}  ${t.fg(
			"muted",
			oneLine(path.basename(r.cwd), 20).padEnd(20),
		)} ${extra}`;
	}

	render(width: number): readonly string[] {
		const t = this.theme;
		const count = (g: Group) => this.#all.filter(r => r.group === g).length;
		const lines = [
			`${t.fg("accent", " Sessions")}${t.fg("dim", `  ${GROUP_ORDER.map(g => `${count(g)} ${g}`).join(" · ")}`)}`,
			` ${t.fg("accent", "›")} ${this.#query}${t.fg("dim", "▏")}${this.#query ? "" : t.fg("dim", "type to filter")}`,
		];

		// Flatten into display items: a group header (string) before the first row of each group, then row indices.
		const items: Array<string | number> = [];
		for (let i = 0; i < this.#rows.length; i++) {
			const g = this.#rows[i].group;
			if (i === 0 || this.#rows[i - 1].group !== g) {
				const n = this.#rows.filter(r => r.group === g).length;
				items.push(`${t.fg("accent", ` ${GROUP_LABEL[g]}`)}${t.fg("dim", ` ${n}`)}`);
			}
			items.push(i);
		}

		const visible = this.#visible();
		const at = items.indexOf(this.#index);
		// Keep the selected row's group header in view when it is the first row of its group.
		const anchor = at > 0 && typeof items[at - 1] === "string" ? at - 1 : at;
		const start = Math.max(0, Math.min(anchor - Math.floor(visible / 2), items.length - visible));
		for (const item of items.slice(start, start + visible)) {
			lines.push(typeof item === "string" ? `\n${item}` : this.#rowLine(this.#rows[item], item === this.#index, width));
		}
		if (this.#rows.length === 0) lines.push("", t.fg("dim", this.#query ? "   no matching sessions" : "   no other live sessions"));

		const savedHidden = !this.#query && !this.#showSaved ? count("saved") : 0;
		if (savedHidden) lines.push("", t.fg("dim", `   + ${savedHidden} saved · tab to show`));

		const tab = this.#query ? "" : ` · tab ${this.#showSaved ? "hide" : "show"} saved`;
		lines.push("", t.fg("dim", ` ↑↓ move · enter open${tab} · ctrl+n new session · esc close`));
		return lines.flatMap(l => l.split("\n")).map(l => truncateToWidth(l, width));
	}
}

export default function sessionBoard(pi: ExtensionAPI) {
	pi.setLabel("Session Board");

	const self: Entry = {
		pid: process.pid,
		state: "idle",
		since: Date.now(),
		seen: true,
		title: path.basename(process.cwd()),
		cwd: process.cwd(),
		tmuxPane: process.env.TMUX_PANE,
		tty: detectTty(),
	};

	let active = false; // true once an interactive (hasUI) session owns this process
	let lastWritten = "";
	let others = new Map<number, Entry>();
	let lastStatus = "";
	let switcher: Switcher | undefined;
	let unsubscribeInput: (() => void) | undefined;

	function refreshIdentity(ctx: Ctx) {
		const sm = ctx.sessionManager as unknown as {
			getSessionId?: () => string;
			getSessionFile?: () => string | undefined;
			getSessionName?: () => string | undefined;
		};
		self.cwd = ctx.cwd;
		self.sessionId = sm.getSessionId?.();
		self.sessionFile = sm.getSessionFile?.();
		const name = (pi.getSessionName?.() as string | undefined) ?? sm.getSessionName?.();
		self.title = name?.trim() || path.basename(ctx.cwd);
	}

	function publish() {
		if (!active) return;
		const json = JSON.stringify(self);
		if (json === lastWritten) return;
		fs.mkdirSync(boardDir, { recursive: true });
		const tmp = `${ownFile}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, json);
		fs.renameSync(tmp, ownFile); // atomic for readers
		lastWritten = json;
	}

	function setState(state: State) {
		if (self.state === state) return;
		self.state = state;
		self.since = Date.now();
		self.seen = state === "working" || state === "waiting" || state === "idle";
		publish();
	}

	function poll(ctx: Ctx) {
		refreshIdentity(ctx); // picks up /rename
		publish();

		const next = new Map<number, Entry>();
		for (const e of readBoard()) if (e.pid !== process.pid) next.set(e.pid, e);

		for (const [pid, e] of next) {
			const prev = others.get(pid);
			if (!prev || prev.state === e.state) continue;
			const who = `${e.title} (${path.basename(e.cwd)})`;
			if (e.state === "done") ctx.ui.notify(`✓ ${who} finished${e.lastText ? `: ${e.lastText}` : ""}`, "info");
			else if (e.state === "waiting") ctx.ui.notify(`❓ ${who} is waiting for your answer`, "warning");
			else if (e.state === "error") ctx.ui.notify(`✗ ${who} stopped with an error`, "error");
		}
		others = next;

		const tally: Record<State, number> = { idle: 0, working: 0, waiting: 0, done: 0, error: 0, aborted: 0 };
		for (const e of next.values()) tally[e.state]++;
		tally.done += tally.aborted;
		const parts = (["waiting", "error", "working", "done"] as const).flatMap(k => (tally[k] ? [`${tally[k]} ${k}`] : []));
		const status = parts.length ? `⧉ ${parts.join(", ")}  ^X L` : "";
		if (status !== lastStatus) {
			ctx.ui.setStatus("session-board", status || undefined);
			lastStatus = status;
		}
		switcher?.reload();
	}

	/** Other live sessions (Done group: waiting first, then most recent; then Working), followed by saved ones. */
	function loadRows(): Row[] {
		const board = readBoard();
		const live = board.filter(e => e.pid !== process.pid);
		const liveRows: Row[] = live
			.map(e => ({ title: e.title, cwd: e.cwd, since: e.since, group: e.state === "working" ? ("working" as const) : ("done" as const), live: e }))
			.sort(
				(a, b) =>
					GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
					Number(b.live.state === "waiting") - Number(a.live.state === "waiting") ||
					b.since - a.since,
			);
		const liveFiles = new Set(board.flatMap(e => (e.sessionFile ? [e.sessionFile] : []))); // includes this pane's own file
		return [...liveRows, ...readSaved(liveFiles)];
	}

	function newSession(ctx: Ctx) {
		const err = openInPool(ctx.cwd, [], path.basename(ctx.cwd));
		if (err) ctx.ui.notify(`New session failed: ${err}`, "error");
	}

	async function openSwitcher(ctx: Ctx) {
		if (switcher) return;
		if (!process.env.TMUX_PANE) {
			ctx.ui.notify("Session switching needs omp running inside tmux", "warning");
			return;
		}
		const pick = await ctx.ui.custom<Pick | undefined>(
			(tui, theme, _kb, done) => {
				switcher = new Switcher(tui, theme as unknown as Switcher["theme"], done, loadRows);
				return switcher;
			},
			{ overlay: true },
		);
		switcher = undefined;
		if (!pick) return;
		if ("newSession" in pick) return newSession(ctx);

		const { live, file, cwd, title } = pick.row;
		const err = live
			? live.tmuxPane
				? showPane(live.tmuxPane)
				: `"${live.title}" is not in tmux (${live.tty ?? `pid ${live.pid}`})`
			: openInPool(cwd, ["--resume", file!], oneLine(title, 20));
		if (err) ctx.ui.notify(`Switch failed: ${err}`, "error");
	}

	/** Ctrl+X leader: next key selects the action; anything else is passed through. */
	function installLeader(ctx: Ctx) {
		unsubscribeInput?.();
		let armedAt = 0;
		unsubscribeInput = ctx.ui.onTerminalInput((data: string) => {
			if (switcher || isKeyRelease(data)) return undefined;
			if (armedAt && Date.now() - armedAt < LEADER_TIMEOUT_MS) {
				armedAt = 0;
				ctx.ui.setStatus("session-board-leader", undefined);
				if (matchesKey(data, "l")) void openSwitcher(ctx);
				else if (matchesKey(data, "n")) newSession(ctx);
				else return undefined; // not ours: deliver the key normally, drop the leader
				return { consume: true };
			}
			if (!matchesKey(data, "ctrl+x")) return undefined;
			armedAt = Date.now();
			ctx.ui.setStatus("session-board-leader", "^X  l sessions · n new");
			ctx.setTimeout(() => {
				if (armedAt && Date.now() - armedAt >= LEADER_TIMEOUT_MS) {
					armedAt = 0;
					ctx.ui.setStatus("session-board-leader", undefined);
				}
			}, LEADER_TIMEOUT_MS);
			return { consume: true };
		});
	}

	function start(ctx: Ctx) {
		if (!ctx.hasUI) return; // subagents / print mode: not a board member
		refreshIdentity(ctx);
		if (!active) {
			active = true;
			ctx.setInterval(() => poll(ctx), POLL_MS);
		}
		installLeader(ctx);
		publish();
		poll(ctx);
	}

	pi.on("session_start", (_e, ctx) => start(ctx));
	pi.on("session_switch", (_e, ctx) => {
		self.lastText = undefined;
		setState("idle");
		start(ctx);
	});

	pi.on("input", (_e, ctx) => {
		if (!ctx.hasUI || !active || self.seen) return;
		self.seen = true;
		publish();
	});
	pi.on("agent_start", (_e, ctx) => {
		if (ctx.hasUI && active) setState("working");
	});
	pi.on("tool_execution_start", (e, ctx) => {
		if (ctx.hasUI && active && (e as { toolName?: string }).toolName === "ask") setState("waiting");
	});
	pi.on("tool_execution_end", (e, ctx) => {
		if (ctx.hasUI && active && (e as { toolName?: string }).toolName === "ask") setState("working");
	});
	pi.on("message_end", (e, ctx) => {
		if (!ctx.hasUI || !active) return;
		const text = assistantText((e as { message?: unknown }).message);
		if (text) {
			self.lastText = text;
			publish();
		}
	});
	pi.on("agent_end", (e, ctx) => {
		if (!ctx.hasUI || !active) return;
		if ((e as { isTerminal?: boolean }).isTerminal === false) return;
		setState(settledState(e));
	});
	pi.on("session_shutdown", (_e, ctx) => {
		if (!ctx.hasUI) return;
		active = false;
		unsubscribeInput?.();
		fs.rmSync(ownFile, { force: true });
	});

	pi.registerCommand("board", {
		description: "Session switcher (also Ctrl+X L): live + saved sessions, open one in this pane",
		handler: async (_args, ctx) => openSwitcher(ctx),
	});
}
