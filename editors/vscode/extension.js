// Shows rbxm/rbxl files as instance trees, and diffs of them as git-rbx's
// Studio diff viewer does (Rojo's patch visualizer).
//
// The editor opens rbx files it can't display as binary placeholder tabs: a
// text tab for a single file, a text diff tab for a diff (Source Control,
// Graph, Timeline). A diff tab knows exactly which two versions it compares, so
// when one opens we close it and open our diff panel on the same two URIs. A
// single-file tab is reopened in the viewer (a custom editor, so "Open With"
// works too).

const vscode = require("vscode");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VIEWER = "gitRbx.viewer";
const RBX_EXTENSIONS = new Set([".rbxm", ".rbxl"]);
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

function isRbx(uri) {
	return RBX_EXTENSIONS.has(path.extname(uri.path).toLowerCase());
}

function run(file, args, options) {
	return new Promise((resolve, reject) => {
		childProcess.execFile(
			file,
			args,
			{ encoding: "buffer", maxBuffer: MAX_OUTPUT_BYTES, ...options },
			(error, stdout, stderr) => {
				if (error) {
					const message = stderr.toString().trim() || error.message;
					reject(new Error(`${path.basename(file)} ${args.join(" ")}: ${message}`));
				} else {
					resolve(stdout);
				}
			},
		);
	});
}

async function repoRootOf(fsPath) {
	try {
		const out = await run("git", ["-C", path.dirname(fsPath), "rev-parse", "--show-toplevel"]);
		return out.toString().trim();
	} catch {
		return undefined;
	}
}

// Where a URI's content comes from, in git terms.
//   kind "file":   the working tree
//   kind "index":  the staged version (`:path`)
//   kind "commit": `ref:path`
//   kind "other":  another extension's scheme, read through its file system
function describe(uri) {
	if (uri.scheme === "file") {
		return { kind: "file", uri, fsPath: uri.fsPath, label: "Working Tree" };
	}
	if (uri.scheme === "git") {
		// The built-in git extension's URIs: query is { path, ref }. "" is the
		// index; "~" is "index if staged, else HEAD", which `:path` also is.
		const { path: fsPath, ref } = JSON.parse(uri.query);
		if (ref === "" || ref === "~") {
			return { kind: "index", uri, fsPath, label: "Index" };
		}
		const label = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
		return { kind: "commit", uri, fsPath, ref, label };
	}
	return { kind: "other", uri, fsPath: uri.path, label: uri.scheme };
}

let tempDir;
function tempFileFor(bytes, fsPath) {
	tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "git-rbx-viewer-"));
	const name = crypto.createHash("sha1").update(bytes).digest("hex") + path.extname(fsPath);
	const file = path.join(tempDir, name);
	if (!fs.existsSync(file)) {
		fs.writeFileSync(file, bytes);
	}
	return file;
}

// A file on disk holding this version, or undefined when the version doesn't
// have the file (the side before an add, or after a delete). `cat-file
// --filters` runs the checkout filters, so Git LFS pointers come back as the
// real file.
async function materialize(version, root) {
	try {
		if (version.kind === "file") {
			return fs.existsSync(version.fsPath) ? version.fsPath : undefined;
		}
		if (version.kind === "other") {
			const bytes = Buffer.from(await vscode.workspace.fs.readFile(version.uri));
			return tempFileFor(bytes, version.fsPath);
		}
		const relative = path.relative(root, version.fsPath).split(path.sep).join("/");
		const object = version.kind === "index" ? `:${relative}` : `${version.ref}:${relative}`;
		const bytes = await run("git", ["-C", root, "cat-file", "--filters", object]);
		return tempFileFor(bytes, version.fsPath);
	} catch {
		return undefined;
	}
}

async function gitRbxView(cwd, files) {
	const executable = vscode.workspace.getConfiguration("gitRbx").get("path") || "git-rbx";
	const out = await run(executable, ["view", ...files], { cwd });
	return JSON.parse(out.toString());
}

// The `view` document for two versions. When one side doesn't have the file,
// the other side's tree stands alone and every instance counts as added or
// removed.
async function loadDiff(original, modified) {
	const root = (await repoRootOf(modified.fsPath)) ?? (await repoRootOf(original.fsPath));
	const cwd = root ?? path.dirname(modified.fsPath);
	const [oldFile, newFile] = await Promise.all([materialize(original, root), materialize(modified, root)]);
	if (oldFile && newFile) {
		return gitRbxView(cwd, [oldFile, newFile]);
	}
	if (newFile) {
		const view = await gitRbxView(cwd, [newFile]);
		return { old: null, new: view.new, document: null, whole: "added", defaults: view.defaults, content: view.content };
	}
	if (oldFile) {
		const view = await gitRbxView(cwd, [oldFile]);
		return { old: view.new, new: null, document: null, whole: "removed", defaults: view.defaults, content: view.content };
	}
	throw new Error(`Neither ${original.label} nor ${modified.label} has ${path.basename(modified.fsPath)}`);
}

function webviewHtml(webview, media) {
	const nonce = crypto.randomBytes(16).toString("hex");
	const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "view.js"));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "view.css"));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="header">Loading…</div>
<div id="list"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

// Sets up a webview for view.js and resolves once its script is listening.
// It then asks for asset previews as rows come into view.
function prepareWebview(webview, media) {
	const icons = studioIcons();
	const roots = [media, vscode.Uri.file(previewDirectory)];
	if (icons) {
		roots.push(vscode.Uri.file(icons.content));
	}
	webview.options = { enableScripts: true, localResourceRoots: roots };
	const ready = new Promise((resolve) => {
		const listener = webview.onDidReceiveMessage((message) => {
			if (message.type === "ready") {
				listener.dispose();
				resolve();
			}
		});
	});
	webview.onDidReceiveMessage((message) => {
		if (message.type === "previews") {
			for (const key of message.keys) {
				void previewFor(key).then((result) =>
					webview.postMessage({
						type: "previews",
						results: {
							[key]: result.file ? { uri: webview.asWebviewUri(vscode.Uri.file(result.file)).toString() } : { state: result.state },
						},
					}),
				);
			}
		} else if (message.type === "openAsset" && /^\d+$/.test(message.id)) {
			void vscode.env.openExternal(vscode.Uri.parse(`https://create.roblox.com/store/asset/${message.id}`));
		}
	});
	webview.html = webviewHtml(webview, media);
	return ready;
}

// ---------------------------------------------------------------------------
// Asset previews, for the values of Content and ContentId properties. Roblox
// assets come from the public thumbnails API, without signing in, so a private
// or unmoderated asset reports its state instead of an image. Images are
// cached on disk by asset id. `rbxasset://` paths are files in the local
// Studio install.

const THUMBNAILS = "https://thumbnails.roblox.com/v1/assets";
const THUMBNAIL_BATCH = 100;
let previewDirectory;
// key ("asset:<id>" or "local:<path>") -> Promise<{ file } | { state }>
const previews = new Map();
let queued = new Map();
let flushTimer;

function previewFor(key) {
	let result = previews.get(key);
	if (!result) {
		result = resolvePreview(key).then((resolved) => {
			// Worth retrying later; every other state is the asset's own.
			if (resolved.state === "Offline") {
				previews.delete(key);
			}
			return resolved;
		});
		previews.set(key, result);
	}
	return result;
}

function resolvePreview(key) {
	if (key.startsWith("local:")) {
		const content = studioIcons()?.content;
		const file = content && path.resolve(content, key.slice("local:".length));
		const inside = file && file.startsWith(content + path.sep) && fs.existsSync(file);
		return Promise.resolve(inside ? { file } : { state: "Missing" });
	}
	const id = key.slice("asset:".length);
	if (!/^\d+$/.test(id)) {
		return Promise.resolve({ state: "Invalid" });
	}
	const cached = path.join(previewDirectory, `${id}.png`);
	if (fs.existsSync(cached)) {
		return Promise.resolve({ file: cached });
	}
	// Requests arriving together share one thumbnails call.
	return new Promise((resolve) => {
		queued.set(id, resolve);
		flushTimer ??= setTimeout(flushThumbnails, 30);
	});
}

async function flushThumbnails() {
	flushTimer = undefined;
	const batch = [...queued];
	queued = new Map();
	for (let start = 0; start < batch.length; start += THUMBNAIL_BATCH) {
		const chunk = batch.slice(start, start + THUMBNAIL_BATCH);
		let entries;
		try {
			const ids = chunk.map(([id]) => id).join(",");
			const response = await fetch(`${THUMBNAILS}?assetIds=${ids}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`);
			entries = new Map(((await response.json()).data ?? []).map((entry) => [String(entry.targetId), entry]));
		} catch {
			for (const [, resolve] of chunk) {
				resolve({ state: "Offline" });
			}
			continue;
		}
		await Promise.all(
			chunk.map(async ([id, resolve]) => {
				const entry = entries.get(id);
				if (entry?.state !== "Completed" || !entry.imageUrl) {
					resolve({ state: entry?.state ?? "Unavailable" });
					return;
				}
				try {
					const image = Buffer.from(await (await fetch(entry.imageUrl)).arrayBuffer());
					const file = path.join(previewDirectory, `${id}.png`);
					fs.writeFileSync(file, image);
					resolve({ file });
				} catch {
					resolve({ state: "Offline" });
				}
			}),
		);
	}
}

// Studio's own class icons, read from the local install (what its Explorer
// and the Studio diff viewer show). Undefined when Studio isn't installed.
const iconCache = new Map();
function studioIcons() {
	const light = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(
		vscode.window.activeColorTheme.kind,
	);
	const theme = light ? "Light" : "Dark";
	if (iconCache.has(theme)) {
		return iconCache.get(theme);
	}
	const configured = vscode.workspace.getConfiguration("gitRbx").get("studioContentPath");
	const contents = configured ? [configured] : studioContentCandidates();
	let icons;
	for (const content of contents) {
		const directory = path.join(content, "studio_svg_textures", "Shared", "InsertableObjects", theme, "Standard");
		try {
			const classes = fs
				.readdirSync(directory)
				.filter((file) => file.endsWith(".png") && !file.includes("@"))
				.map((file) => file.slice(0, -4));
			icons = { directory, classes, content };
			break;
		} catch {
			// Not this install.
		}
	}
	iconCache.set(theme, icons);
	return icons;
}

function studioContentCandidates() {
	if (process.platform === "darwin") {
		return ["/Applications/RobloxStudio.app/Contents/Resources/content"];
	}
	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		const versions = path.join(process.env.LOCALAPPDATA, "Roblox", "Versions");
		try {
			return fs
				.readdirSync(versions)
				.map((version) => path.join(versions, version))
				.filter((directory) => fs.existsSync(path.join(directory, "RobloxStudioBeta.exe")))
				.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
				.map((directory) => path.join(directory, "content"));
		} catch {
			return [];
		}
	}
	return [];
}

function iconsFor(webview) {
	const icons = studioIcons();
	return icons && { base: webview.asWebviewUri(vscode.Uri.file(icons.directory)).toString(), classes: icons.classes };
}

function previewsEnabled() {
	return vscode.workspace.getConfiguration("gitRbx").get("assetPreviews", true);
}

function errorText(error) {
	return String(error?.message ?? error);
}

class ViewerProvider {
	constructor(media) {
		this.media = media;
	}

	openCustomDocument(uri) {
		return { uri, dispose() {} };
	}

	// Returns without waiting: the editor only shows the webview (and runs its
	// script, which sends "ready") once this resolves, so awaiting "ready" here
	// would never finish.
	resolveCustomEditor(document, panel) {
		const ready = prepareWebview(panel.webview, this.media);
		void this.load(document.uri, panel, ready);
	}

	async load(uri, panel, ready) {
		const version = describe(uri);
		let message;
		try {
			const root = await repoRootOf(version.fsPath);
			const file = await materialize(version, root);
			if (!file) {
				throw new Error(`${version.label} has no ${path.basename(version.fsPath)}`);
			}
			const view = await gitRbxView(root ?? path.dirname(version.fsPath), [file]);
			message = {
				type: "load",
				mode: "single",
				new: view.new,
				labels: { new: version.label },
				icons: iconsFor(panel.webview),
				defaults: view.defaults,
				content: view.content,
				previews: previewsEnabled(),
			};
		} catch (error) {
			message = { type: "error", message: errorText(error) };
		}
		await ready;
		await panel.webview.postMessage(message);
	}
}

class DiffPanels {
	constructor(media) {
		this.media = media;
		// "original|modified" -> panel
		this.panels = new Map();
		// Opened from a preview tab: the next preview diff replaces it, the way
		// the editor reuses its preview tab.
		this.preview = undefined;
	}

	async open(originalUri, modifiedUri, { viewColumn, preview }) {
		const key = `${originalUri}|${modifiedUri}`;
		const existing = this.panels.get(key);
		if (existing) {
			existing.panel.reveal(viewColumn);
			return;
		}

		const original = describe(originalUri);
		const modified = describe(modifiedUri);
		const title = `${path.basename(modified.fsPath)} (${original.label} ↔ ${modified.label})`;

		let entry = preview ? this.preview : undefined;
		if (entry) {
			this.panels.delete(entry.key);
			entry.panel.title = title;
			entry.panel.reveal(viewColumn);
		} else {
			const panel = vscode.window.createWebviewPanel("gitRbx.diff", title, viewColumn ?? vscode.ViewColumn.Active, {
				enableScripts: true,
				retainContextWhenHidden: true,
			});
			entry = { panel, ready: prepareWebview(panel.webview, this.media) };
			panel.onDidDispose(() => {
				this.panels.delete(entry.key);
				if (this.preview === entry) {
					this.preview = undefined;
				}
			});
			if (preview) {
				this.preview = entry;
			}
		}
		entry.key = key;
		this.panels.set(key, entry);

		await entry.ready;
		await entry.panel.webview.postMessage({ type: "loading", title });
		let message;
		try {
			const view = await loadDiff(original, modified);
			message = {
				type: "load",
				mode: "diff",
				old: view.old,
				new: view.new,
				document: view.document,
				whole: view.whole,
				labels: { old: original.label, new: modified.label },
				icons: iconsFor(entry.panel.webview),
				defaults: view.defaults,
				content: view.content,
				previews: previewsEnabled(),
			};
		} catch (error) {
			message = { type: "error", message: errorText(error) };
		}
		// A preview panel may have moved on to another diff meanwhile.
		if (entry.key === key) {
			await entry.panel.webview.postMessage(message);
		}
	}
}

async function closeTab(tab) {
	try {
		await vscode.window.tabGroups.close(tab);
	} catch {
		// Already closed.
	}
}

function activate(context) {
	const media = vscode.Uri.joinPath(context.extensionUri, "media");
	previewDirectory = path.join(context.globalStorageUri.fsPath, "asset-previews");
	fs.mkdirSync(previewDirectory, { recursive: true });
	const diffPanels = new DiffPanels(media);

	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(VIEWER, new ViewerProvider(media), {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: true,
		}),
		vscode.window.tabGroups.onDidChangeTabs(({ opened }) => {
			for (const tab of opened) {
				const input = tab.input;
				const options = { viewColumn: tab.group.viewColumn, preview: tab.isPreview };
				// Open the replacement first (the panel is created before open's
				// first await), so closing a group's only tab doesn't close the group.
				if (input instanceof vscode.TabInputTextDiff && (isRbx(input.original) || isRbx(input.modified))) {
					void diffPanels.open(input.original, input.modified, options).catch((error) => {
						void vscode.window.showErrorMessage(`git-rbx: ${errorText(error)}`);
					});
					void closeTab(tab);
				} else if (input instanceof vscode.TabInputText && isRbx(input.uri)) {
					void Promise.resolve(vscode.commands.executeCommand("vscode.openWith", input.uri, VIEWER, options)).then(() =>
						closeTab(tab),
					);
				}
			}
		}),
	);
}

function deactivate() {
	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

module.exports = { activate, deactivate };
