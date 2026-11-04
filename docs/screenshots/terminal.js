// Screenshots a command's output as a terminal window.
//
//   node terminal.js <cwd> <out.png> <command>
//
// The command runs through sh with color forced on (CLICOLOR_FORCE for
// git-rbx, color.ui for git), so it prints what it would on a terminal. ANSI
// colors use VS Code's terminal palette.
const { execFileSync } = require("child_process");
const { launch } = require("./browser");

const [cwd, outFile, command] = process.argv.slice(2);
const output = execFileSync("sh", ["-c", command], {
	cwd,
	env: {
		...process.env,
		CLICOLOR_FORCE: "1",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "color.ui",
		GIT_CONFIG_VALUE_0: "always",
		GIT_PAGER: "cat",
	},
}).toString();

const COLORS = { 31: "#f14c4c", 32: "#23d18b", 33: "#f5f543", 34: "#3b8eea", 35: "#d670d6", 36: "#29b8db", 37: "#e5e5e5", 90: "#666666", 91: "#f14c4c", 92: "#23d18b", 93: "#f5f543", 94: "#3b8eea", 95: "#d670d6", 96: "#29b8db", 97: "#e5e5e5" };
const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// SGR escapes to spans: colors, bold and dim.
function toHtml(text) {
	let html = "";
	let state = {};
	let open = false;
	for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
		const sgr = part.match(/^\x1b\[([0-9;]*)m$/);
		if (!sgr) {
			html += escape(part);
			continue;
		}
		for (const code of (sgr[1] || "0").split(";").map(Number)) {
			if (code === 0) {
				state = {};
			} else if (code === 1) {
				state.bold = true;
			} else if (code === 2) {
				state.dim = true;
			} else if (code === 22) {
				state.bold = state.dim = false;
			} else if (code === 39) {
				delete state.color;
			} else if (COLORS[code]) {
				state.color = COLORS[code];
			}
		}
		const style = [state.color && `color:${state.color}`, state.bold && "font-weight:bold", state.dim && "opacity:0.6"].filter(Boolean).join(";");
		html += `${open ? "</span>" : ""}<span style="${style}">`;
		open = true;
	}
	return html + (open ? "</span>" : "");
}

const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 24px; display: inline-block; }
.window { display: inline-block; min-width: 760px; overflow: hidden; background: #181818; border: 1px solid #2b2b2b; border-radius: 10px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45); }
.bar { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; background: #1f1f1f; border-bottom: 1px solid #2b2b2b; }
.dot { width: 12px; height: 12px; border-radius: 50%; }
pre { margin: 0; padding: 14px 18px 16px; color: #cccccc; font: 13px/1.5 Menlo, Monaco, "Courier New", monospace; }
.prompt { color: #23d18b; }
</style></head><body><div class="window"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span></div><pre><span class="prompt">$</span> ${escape(command)}
${toHtml(output.replace(/\n+$/, ""))}</pre></div></body></html>`;

(async () => {
	const browser = await launch();
	const context = await browser.newContext({ viewport: { width: 1400, height: 400 }, deviceScaleFactor: 2 });
	const tab = await context.newPage();
	await tab.setContent(page);
	await tab.locator("body").screenshot({ path: outFile, omitBackground: true });
	await browser.close();
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
