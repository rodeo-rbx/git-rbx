// Screenshots the editor viewer. It runs the extension's own extension.js
// against a stubbed `vscode`, and shows the webview it builds in a headless
// browser: the page, its script and style, the git-rbx JSON and the rhr
// pictures are all the extension's, and only the editor around the webview is
// stubbed.
//
//   node viewer.js <out.png> view <file>
//   node viewer.js <out.png> diff <repo> <ref> <file> [<ref2>]
//
// A diff without ref2 compares ref with the working tree, as Source Control
// opens it. Env: GIT_RBX and RHR (the executables), STORAGE (a scratch
// directory), WIDTH and HEIGHT (the page size in CSS pixels), CLICKS (a JSON
// list of Playwright selectors to click before the screenshot).
const Module = require("module");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { launch } = require("./browser");

const EXTENSION = path.join(__dirname, "..", "..", "editors", "vscode");
const storage = process.env.STORAGE;
const [outFile, mode, ...rest] = process.argv.slice(2);

// VS Code serves webview resources from its own origin; file:// would block the
// cross-origin image loads the page makes (Studio's class icons), so they come
// over http here.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((request, response) => {
	const file = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
	fs.readFile(file, (error, data) => {
		if (error) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
		response.end(data);
	});
});
let origin;
let page;
let pageLoaded;

class Uri {
	constructor(scheme, fsPath, query = "") {
		this.scheme = scheme;
		this.path = fsPath;
		this.fsPath = fsPath;
		this.query = query;
	}
	static file(fsPath) {
		return new Uri("file", path.resolve(fsPath));
	}
	static joinPath(base, ...parts) {
		return new Uri(base.scheme, path.join(base.path, ...parts), base.query);
	}
	static parse(text) {
		return new Uri("external", text);
	}
	toString() {
		return this.scheme === "file" ? `file://${this.path}` : this.path;
	}
}
class TabInputTextDiff {
	constructor(original, modified) {
		this.original = original;
		this.modified = modified;
	}
}
class TabInputText {
	constructor(uri) {
		this.uri = uri;
	}
}

const hostListeners = [];
function fakeWebview() {
	const webview = {
		options: {},
		cspSource: "http:",
		asWebviewUri: (uri) => ({ toString: () => `${origin}${encodeURI(uri.fsPath)}` }),
		onDidReceiveMessage(listener) {
			hostListeners.push(listener);
			return { dispose: () => hostListeners.splice(hostListeners.indexOf(listener), 1) };
		},
		async postMessage(message) {
			await pageLoaded;
			await page.evaluate((m) => window.postMessage(m, "*"), JSON.parse(JSON.stringify(message)));
			return true;
		},
	};
	Object.defineProperty(webview, "html", {
		set(html) {
			// The CSP names VS Code's resource origin, which this isn't.
			const file = path.join(storage, "page.html");
			fs.writeFileSync(file, html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""));
			pageLoaded = page.goto(`${origin}${encodeURI(file)}`);
		},
	});
	return webview;
}

let tabListener;
let customEditor;
const settings = { path: process.env.GIT_RBX, rhrPath: process.env.RHR };
const vscode = {
	Uri,
	TabInputTextDiff,
	TabInputText,
	ViewColumn: { Active: -1, One: 1 },
	ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
	workspace: {
		getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
		fs: { readFile: async (uri) => fs.readFileSync(uri.fsPath) },
	},
	window: {
		activeColorTheme: { kind: 2 },
		registerCustomEditorProvider: (_id, provider) => {
			customEditor = provider;
			return { dispose() {} };
		},
		tabGroups: {
			onDidChangeTabs: (listener) => {
				tabListener = listener;
				return { dispose() {} };
			},
			close: async () => true,
		},
		createWebviewPanel: () => ({ webview: fakeWebview(), reveal() {}, onDidDispose() {}, title: "" }),
		showErrorMessage: (message) => console.error(message),
	},
	env: { openExternal: async () => true },
	commands: { executeCommand: async () => undefined },
};
const load = Module._load;
Module._load = function (request, ...args) {
	return request === "vscode" ? vscode : load.call(this, request, ...args);
};

// What VS Code puts on every webview: the theme's colors as variables, the
// body's theme class, and its fonts. The theme is Dark Modern, VS Code's
// default; the fonts are its macOS defaults.
const THEME = `
html {
	--vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
	--vscode-font-size: 13px;
	--vscode-editor-font-family: Menlo, Monaco, 'Courier New', monospace;
	--vscode-editor-font-size: 12px;
	--vscode-editor-background: #1f1f1f;
	--vscode-editor-foreground: #cccccc;
	--vscode-foreground: #cccccc;
	--vscode-input-background: #313131;
	--vscode-input-foreground: #cccccc;
	--vscode-input-border: #3c3c3c;
	--vscode-focusBorder: #0078d4;
	--vscode-errorForeground: #f85149;
	--vscode-editor-findMatchHighlightBackground: #ea5c0055;
	--vscode-dropdown-background: #313131;
	--vscode-dropdown-foreground: #cccccc;
	--vscode-dropdown-border: #3c3c3c;
	--vscode-button-secondaryBackground: #313131;
	--vscode-button-secondaryForeground: #cccccc;
	--vscode-button-secondaryHoverBackground: #3c3c3c;
}
`;

(async () => {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	const browser = await launch();
	const context = await browser.newContext({
		viewport: { width: Number(process.env.WIDTH ?? 960), height: Number(process.env.HEIGHT ?? 760) },
		deviceScaleFactor: 2,
	});
	page = await context.newPage();
	page.on("pageerror", (error) => console.error("page error:", error.message));
	await page.exposeFunction("__toHost", (message) => {
		for (const listener of [...hostListeners]) {
			listener(message);
		}
	});
	await page.addInitScript((theme) => {
		window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(m), getState: () => undefined, setState() {} });
		document.addEventListener("DOMContentLoaded", () => {
			const style = document.createElement("style");
			style.textContent = theme;
			document.head.prepend(style);
			document.body.classList.add("vscode-dark");
		});
	}, THEME);

	fs.mkdirSync(storage, { recursive: true });
	require(path.join(EXTENSION, "extension.js")).activate({
		extensionUri: Uri.file(EXTENSION),
		globalStorageUri: Uri.file(storage),
		subscriptions: [],
	});
	if (mode === "view") {
		customEditor.resolveCustomEditor({ uri: Uri.file(rest[0]) }, { webview: fakeWebview() });
	} else {
		// The built-in git extension's URIs, which Source Control and the Graph open.
		const [repo, ref, file, ref2] = rest;
		const absolute = path.join(repo, file);
		const gitUri = (version) => new Uri("git", absolute, JSON.stringify({ path: absolute, ref: version }));
		const modified = ref2 ? gitUri(ref2) : Uri.file(absolute);
		tabListener({ opened: [{ input: new TabInputTextDiff(gitUri(ref), modified), group: { viewColumn: 1 }, isPreview: false }] });
	}

	// Done once the tree is up and every picture has loaded.
	await page.waitForFunction(
		() => {
			const header = document.getElementById("header");
			const renders = document.getElementById("renders");
			if (!header || header.textContent.includes("Loading")) {
				return false;
			}
			if (renders.hidden) {
				return true;
			}
			return !renders.textContent.includes("Rendering") && [...renders.querySelectorAll("img")].every((img) => img.complete && img.naturalWidth > 0);
		},
		null,
		{ timeout: 180_000, polling: 250 },
	);
	// The README's shots all have pictures, so a shot without them is a failure.
	const failure = await page.evaluate(() => {
		const header = document.getElementById("header");
		const renders = document.getElementById("renders");
		if (header.className === "error") {
			return header.textContent;
		}
		if (renders.hidden || renders.querySelectorAll("img").length === 0) {
			return `no pictures (${renders.textContent.trim() || "the extension didn't run rhr"})`;
		}
		return undefined;
	});
	if (failure) {
		throw new Error(`the viewer shows an error: ${failure}`);
	}
	for (const selector of JSON.parse(process.env.CLICKS ?? "[]")) {
		await page.click(selector);
		await page.waitForTimeout(300);
	}
	await page.waitForTimeout(1500);
	await page.screenshot({ path: outFile });
	await browser.close();
	process.exit(0);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
