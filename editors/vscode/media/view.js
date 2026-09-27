// Renders a `git rbx view` document the way git-rbx's Studio diff viewer
// does: Rojo's patch visualizer (studio-viewer/shared/ui/PatchVisualizer).
//
// The diff is a sparse tree of the changed instances plus the ancestors that
// reach them, siblings alphabetical. Each row has line guides, a marker for its
// kind of change, the class icon and name tinted by that kind (bold when the
// instance itself changed), and its number of changes. Expanding a row shows
// its table, then its children; it opens with what `git rbx diff` prints.
// Tables read like a git diff: `-` old value over `+` new value, in the CLI's
// value format. "Show unchanged" fills in the rest of the tree and the
// unchanged properties. A single file is the full tree with no changes.
//
// fromDocument, buildTree and flatten follow fromDocument.luau and
// patchTree.luau; rows are drawn by a virtual list, since a file can hold
// hundreds of thousands of instances.

const vscode = acquireVsCodeApi();
const header = document.getElementById("header");
const list = document.getElementById("list");

const ROW_HEIGHT = 24;
const OVERSCAN = 12;

// Lucide icons, as the Studio viewer's markers.
const MARKER_SVG = {
	Add: '<path d="M5 12h14m-7-7v14"/>',
	Remove: '<path d="M5 12h14"/>',
	Edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4"/>',
	Reparent: '<path d="m18 8l4 4l-4 4M2 12h20"/>',
	Pivot: '<path d="m15.194 13.707l3.814 1.86l-1.86 3.814m-.676-11.853A5 10 0 1 0 13 21.798"/><path d="M21.798 11A10 5 0 1 0 19 15.57"/>',
};

const KIND_CLASS = { Add: "add", Remove: "remove", Edit: "edit", Reparent: "reparent", Pivot: "pivot" };

// Disclosure triangles, as the Studio resolver's explorer (Boxicons).
const DISCLOSURE_SVG = {
	closed: '<path fill="currentColor" d="M5.536 21.886a1 1 0 0 0 1.033-.064l13-9a1 1 0 0 0 0-1.644l-13-9A1 1 0 0 0 5 3v18a1 1 0 0 0 .536.886"/>',
	open: '<path fill="currentColor" d="M11.178 19.569a.998.998 0 0 0 1.644 0l9-13A.999.999 0 0 0 21 5H3a1.002 1.002 0 0 0-.822 1.569z"/>',
};

// Where a row's pieces sit, from its tree indent: a disclosure slot, then
// the class icon, then the name; the table under it starts 8px past the icon.
const DISCLOSURE_OFFSET = 3;
const ICON_OFFSET = 14;
const NAME_OFFSET = 34;
const TABLE_OFFSET = ICON_OFFSET + 8;

// An opened asset preview's height, in rows.
const PREVIEW_ROWS = 6;

const PROPERTIES = { prefix: "", title: "Property", valueTitle: "Value" };
const ATTRIBUTES = { prefix: "Attributes.", title: "Attribute", valueTitle: "Value" };
const TAGS = { prefix: "Tags.", title: "Tag", valueTitle: "" };
const SECTIONS = [PROPERTIES, ATTRIBUTES, TAGS];

// An instance the CLI prints a line for: a changed one, the root of an added
// subtree (its descendants are part of that line), or a removed one.
function isEntry(node) {
	return node.kind !== undefined && (node.kind !== "Add" || node.subtreeCount !== undefined);
}

function sectionOf(name) {
	return name.startsWith(ATTRIBUTES.prefix) ? ATTRIBUTES : name.startsWith(TAGS.prefix) ? TAGS : PROPERTIES;
}

let view;

// Asset previews the extension has resolved: key -> { uri } or { state }.
// Keys are "asset:<id>" for Roblox assets and "local:<path>" for files in the
// Studio install. Rows ask for theirs as they're drawn.
const previews = new Map();
const requested = new Set();
let previewQueue = [];
let previewTimer;

function requestPreview(key) {
	if (requested.has(key)) {
		return;
	}
	requested.add(key);
	previewQueue.push(key);
	previewTimer ??= setTimeout(() => {
		vscode.postMessage({ type: "previews", keys: previewQueue });
		previewQueue = [];
		previewTimer = undefined;
	}, 30);
}

// The asset a Content value points at, if it's one that can be previewed.
function assetKey(text) {
	const local = /^rbxasset:\/\/(.+)$/i.exec(text);
	if (local) {
		return `local:${local[1]}`;
	}
	const match =
		/^rbxassetid:\/\/(\d+)$/i.exec(text) ??
		/^(?:https?:\/\/(?:www\.)?roblox\.com\/asset\/?|https?:\/\/assetdelivery\.roblox\.com\/v1\/asset\/?|rbxthumb:\/\/)\S*?[?&]id=(\d+)/i.exec(text);
	return match ? `asset:${match[1]}` : undefined;
}

window.addEventListener("message", (event) => {
	const message = event.data;
	if (message.type === "previews") {
		for (const [key, result] of Object.entries(message.results)) {
			previews.set(key, result);
		}
		view?.draw();
	} else if (message.type === "loading") {
		view = undefined;
		header.className = "";
		header.textContent = `Loading ${message.title}…`;
		list.replaceChildren();
	} else if (message.type === "error") {
		view = undefined;
		header.className = "error";
		header.textContent = message.message;
		list.replaceChildren();
	} else if (message.type === "load") {
		view = createView(message);
	}
});

window.addEventListener("keydown", (event) => {
	// The editor's own next/previous change keys.
	if (view && event.altKey && event.key === "F5") {
		event.preventDefault();
		view.navigate(event.shiftKey ? -1 : 1);
	}
});

list.addEventListener("scroll", () => view?.draw());
window.addEventListener("resize", () => view?.draw());

vscode.postMessage({ type: "ready" });

// ---------------------------------------------------------------------------
// Values: the CLI's text (format_property_value in src/output.rs). Numbers
// arrive as the shortest text of their float32, which String() reproduces.
// Beyond the CLI: strings are whole (the cell truncates), references show
// their target's path, colors get a swatch, and sequences list keypoints.

// One CFrame component: snapped to an integer within 1e-6 so rotation float
// dust reads as the 0/1/-1 it represents, and -0 as 0 (fmt_component).
function cframeComponent(value) {
	const rounded = Math.round(value);
	const snapped = Math.abs(value - rounded) < 1e-6 ? rounded : value;
	return snapped === 0 ? "0" : String(snapped);
}

// A pure translation drops its identity rotation (format_cframe_value).
function formatCFrame(c) {
	const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	const unrotated = c.slice(3).every((component, index) => Math.abs(component - identity[index]) < 1e-6);
	return `CFrame(${(unrotated ? c.slice(0, 3) : c).map(cframeComponent).join(", ")})`;
}

function formatValue(encoded) {
	const value = encoded.value ?? {};
	switch (encoded.type) {
		case "nil":
			return "nil";
		case "bool":
		case "int32":
		case "int64":
		case "float32":
		case "float64":
			return String(value.value);
		case "string":
			return `"${String(value.value).replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
		case "binary_string":
			return `<binary ${value.len} bytes>`;
		case "ref":
			return `Ref(${value.value})`;
		case "vector2":
			return `(${value.x}, ${value.y})`;
		case "vector3":
			return `(${value.x}, ${value.y}, ${value.z})`;
		case "c_frame":
			return formatCFrame(value);
		case "color3":
			return `Color3(${value.r}, ${value.g}, ${value.b})`;
		case "brick_color":
			return `BrickColor(${value.value})`;
		case "enum":
			return `Enum(${value.value})`;
		case "u_dim":
			return `UDim(${value.scale}, ${value.offset})`;
		case "u_dim2":
			return `UDim2({${value.x_scale}, ${value.x_offset}}, {${value.y_scale}, ${value.y_offset}})`;
		case "number_range":
			return `NumberRange(${value.min}, ${value.max})`;
		case "number_sequence":
			return `NumberSequence(${value.keypoints
				.map((k) => `${k.time}: ${k.value}${k.envelope ? ` ±${k.envelope}` : ""}`)
				.join(", ")})`;
		case "color_sequence":
			return `ColorSequence(${value.keypoints.map((k) => `${k.time}: Color3(${k.r}, ${k.g}, ${k.b})`).join(", ")})`;
		case "rect":
			return `Rect(${value.min_x}, ${value.min_y}, ${value.max_x}, ${value.max_y})`;
		case "other":
			return `<${value.type_name}>`;
	}
	return String(encoded.type);
}

function rgb(r, g, b) {
	return `rgb(${r * 255}, ${g * 255}, ${b * 255})`;
}

// A color's swatch, or a sequence's gradient, before its text.
function displayValue(value, text) {
	const cell = element("span", "value");
	if (text === undefined && value?.type === "color3") {
		const swatch = element("span", "swatch");
		swatch.style.background = rgb(value.value.r, value.value.g, value.value.b);
		cell.append(swatch);
	} else if (text === undefined && value?.type === "color_sequence") {
		const swatch = element("span", "swatch gradient");
		const stops = value.value.keypoints.map((k) => `${rgb(k.r, k.g, k.b)} ${k.time * 100}%`);
		swatch.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
		cell.append(swatch);
	}
	text ??= value === undefined ? "" : formatValue(value);
	const label = element("span", "label", text);
	label.title = text;
	cell.append(label);
	return cell;
}

// ---------------------------------------------------------------------------
// Patch (fromDocument.luau)

// Nodes keyed by id: changed instances and the ancestors that reach them,
// with change rows. Instance lists stand in for the document's manifests.
function fromDocument({ ops, pivots, oldById, newById, addProperties }) {
	const nodes = new Map();

	function pathOf(byId, id) {
		const parts = [];
		for (let cursor = byId.get(id); cursor; cursor = byId.get(cursor.parent)) {
			parts.unshift(cursor.name);
		}
		return parts.join(".");
	}

	// Materialize a node and its ancestors, preferring the requested version
	// and falling back to the other for shared ancestors.
	function ensure(id, preferNew) {
		const existing = nodes.get(id);
		if (existing) {
			return existing;
		}
		const record = (preferNew ? newById : oldById).get(id) ?? (preferNew ? oldById : newById).get(id);
		if (!record) {
			return undefined;
		}
		const node = { id, name: record.name, className: record.class, parent: record.parent, record, rows: [] };
		nodes.set(id, node);
		if (record.parent !== undefined) {
			ensure(record.parent, preferNew);
		}
		return node;
	}

	for (const op of ops) {
		if (op.op === "add") {
			const root = ensure(op.id, true);
			if (!root) {
				continue;
			}
			root.kind = "Add";
			root.subtreeCount = op.instanceCount;
			for (const added of op.subtree ?? []) {
				// The document lists the whole new subtree, including instances
				// moved into it (and what moved with them); those exist in the
				// old version, and their reparent op places them.
				if (oldById.has(added.id)) {
					continue;
				}
				let node = nodes.get(added.id);
				if (!node) {
					const record = newById.get(added.id);
					node = { id: added.id, name: added.name, className: added.class, parent: added.parent, record, rows: [] };
					nodes.set(added.id, node);
					if (added.parent !== undefined) {
						ensure(added.parent, true);
					}
				}
				node.kind = "Add";
				if (addProperties) {
					for (const [property, value] of Object.entries(node.record?.properties ?? {})) {
						node.rows.push({ property, kind: "Add", incoming: value });
					}
				}
			}
		} else if (op.op === "remove") {
			const node = ensure(op.id, false);
			if (node) {
				node.kind = "Remove";
				node.subtreeCount = op.instanceCount;
			}
		} else if (op.op === "reparent") {
			// Shown under the destination: the node's parent is the new one.
			const node = ensure(op.id, true);
			if (node) {
				node.parent = op.to;
				if (op.to !== undefined) {
					ensure(op.to, true);
				}
				node.rows.push({
					property: "Parent",
					kind: "Reparent",
					currentText: pathOf(oldById, op.from),
					incomingText: pathOf(newById, op.to),
				});
			}
		} else if (op.op === "setName") {
			const node = ensure(op.id, true);
			if (node) {
				node.rows.push({ property: "Name", kind: "Edit", currentText: `"${op.before}"`, incomingText: `"${op.after}"` });
			}
		} else if (op.op === "setProperty") {
			const node = ensure(op.id, true);
			if (node) {
				node.rows.push({ property: op.property ?? "Property", kind: "Edit", current: op.before, incoming: op.after });
			}
		}
	}

	for (const pivot of pivots ?? []) {
		const node = ensure(pivot.id, true);
		if (node) {
			node.kind ??= "Pivot";
			node.rows.push({ property: "Pivot", kind: "Pivot", incomingText: `Δ ${formatCFrame(pivot.delta)}` });
		}
	}

	return nodes;
}

// ---------------------------------------------------------------------------
// Tree (patchTree.luau)

const KIND_RANK = { Add: 0, Remove: 0, Reparent: 1, Pivot: 2, Edit: 3 };

// Marker precedence when a node carries several kinds of change.
function deriveKind(node) {
	if (node.kind) {
		return node.kind;
	}
	let best;
	for (const row of node.rows) {
		const kind = row.kind === "Add" ? "Edit" : row.kind;
		if (!best || KIND_RANK[kind] < KIND_RANK[best]) {
			best = kind;
		}
	}
	return best;
}

function buildTree(nodes) {
	const roots = [];
	for (const node of nodes.values()) {
		node.kind = deriveKind(node);
		node.rows.sort((a, b) => (a.property < b.property ? -1 : a.property > b.property ? 1 : 0));
		node.children = [];
	}
	for (const node of nodes.values()) {
		const parent = node.parent !== undefined ? nodes.get(node.parent) : undefined;
		if (parent) {
			node.parentNode = parent;
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}
	(function finish(siblings, depth) {
		siblings.sort((a, b) => (a.name === b.name ? a.id - b.id : a.name < b.name ? -1 : 1));
		siblings.forEach((node, index) => {
			node.depth = depth;
			node.isFinalChild = index === siblings.length - 1;
			finish(node.children, depth + 1);
		});
	})(roots, 1);
	return roots;
}

// Rows for the virtual list. An expanded node is followed by its table (each
// section's header row, then one row per line), then its children.
// `depthsComplete` is a snapshot per row so line guides know which ancestor
// columns are finished.
function flatten(roots, isExpanded, tableLines) {
	const rows = [];
	const depthsComplete = [];
	let total = 0;
	(function count(nodes) {
		for (const node of nodes) {
			total += 1;
			if (isExpanded(node)) {
				count(node.children);
			}
		}
	})(roots);
	let seen = 0;

	function push(kind, node, entry) {
		rows.push({ kind, node, entry, index: rows.length + 1, isFinalElement: seen === total, depthsComplete: depthsComplete.slice() });
	}

	(function visit(nodes) {
		for (const node of nodes) {
			seen += 1;
			depthsComplete[node.depth] = false;
			depthsComplete.length = node.depth + 1;
			push("node", node);
			if (node.isFinalChild) {
				depthsComplete[node.depth] = true;
			}
			if (isExpanded(node)) {
				for (const entry of tableLines(node)) {
					push(entry.header ? "header" : entry.preview ? "preview" : entry.pad ? "pad" : "change", node, entry);
				}
				visit(node.children);
			}
		}
	})(roots);
	return rows;
}

// ---------------------------------------------------------------------------
// View

function element(tag, className, text) {
	const created = document.createElement(tag);
	if (className) {
		created.className = className;
	}
	if (text !== undefined) {
		created.textContent = text;
	}
	return created;
}

function iconUrl(icons, className) {
	if (!icons) {
		return undefined;
	}
	const name = icons.classes.includes(className) ? className : "Folder";
	const base = `${icons.base}/${encodeURIComponent(name)}`;
	return `-webkit-image-set(url("${base}.png") 1x, url("${base}@2x.png") 2x)`;
}

// Whole-file adds and removes as documents, so they draw like any other diff.
function wholeFileDocument(whole, instances) {
	const byParent = new Map();
	for (const instance of instances) {
		if (!byParent.has(instance.parent)) {
			byParent.set(instance.parent, []);
		}
		byParent.get(instance.parent).push(instance);
	}
	function subtree(root) {
		const out = [];
		const stack = [root];
		while (stack.length > 0) {
			const instance = stack.pop();
			out.push(instance);
			stack.push(...(byParent.get(instance.id) ?? []).slice().reverse());
		}
		return out;
	}
	const roots = byParent.get(undefined) ?? [];
	const ops = roots.map((root) => {
		const instancesUnder = subtree(root);
		return whole === "added"
			? { op: "add", id: root.id, instanceCount: instancesUnder.length, subtree: instancesUnder.map(({ id, parent, name, class: cls }) => ({ id, parent, name, class: cls })) }
			: { op: "remove", id: root.id, instanceCount: instancesUnder.length };
	});
	const counts = { added: 0, removed: 0, modified: 0, reparented: 0, pivoted: 0 };
	counts[whole] = roots.length;
	return { ops, pivots: [], counts };
}

function createView(message) {
	const diff = message.mode === "diff";
	const oldInstances = message.old ?? [];
	const newInstances = message.new ?? [];
	const oldById = new Map(oldInstances.map((instance) => [instance.id, instance]));
	const newById = new Map(newInstances.map((instance) => [instance.id, instance]));
	const document_ = diff
		? message.document ?? wholeFileDocument(message.whole, message.whole === "added" ? newInstances : oldInstances)
		: { ops: [], pivots: [], counts: undefined };

	const defaults = message.defaults ?? {};
	const contentProperties = message.previews === false ? {} : (message.content ?? {});
	// Asset lines whose preview is open, by `${node id}\0${name}\0${sign}`.
	const previewOpen = new Set();
	const expanded = new Set();
	// Expanded only to reach something below (a search match, a change): the
	// children show, the table stays closed until the row is clicked.
	const tableHidden = new Set();
	let seeded = false;
	let selectedId;
	// Instances: "changed" (the changes and the path to them) or "all".
	// Properties shown around the changes: "changed" (none), "nondefault", or
	// "all" (class defaults filled in). A single file has no changes.
	let instanceScope = diff ? "changed" : "all";
	let propertyScope = diff ? "changed" : "nondefault";
	let query = "";
	let revealMatches = false;
	let matches = [];
	let rows = [];
	let roots = [];
	let nodeById = new Map();

	function rebuild() {
		let nodes = fromDocument({ ops: document_.ops, pivots: document_.pivots, oldById, newById, addProperties: true });
		if (instanceScope === "all") {
			for (const instance of newInstances) {
				if (!nodes.has(instance.id)) {
					nodes.set(instance.id, { id: instance.id, name: instance.name, className: instance.class, parent: instance.parent, record: instance, rows: [] });
				}
			}
		}
		if (query) {
			nodes = searched(nodes);
		}
		roots = buildTree(nodes);
		nodeById = nodes;
		if (!seeded) {
			seeded = true;
			seedExpansion(nodes);
		}
		matches = [];
		(function collect(list) {
			for (const node of list) {
				if (node.match) {
					matches.push(node);
				}
				collect(node.children);
			}
		})(query ? roots : []);
		if (revealMatches) {
			revealMatches = false;
			for (const match of matches) {
				reveal(match);
			}
		}
		relayout();
		updateMatchCount();
	}

	// Instances whose name or class contains the query, with the ancestors
	// that reach them.
	function searched(nodes) {
		const needle = query.toLowerCase();
		const kept = new Map();
		for (const node of nodes.values()) {
			if (!node.name.toLowerCase().includes(needle) && !node.className.toLowerCase().includes(needle)) {
				continue;
			}
			node.match = true;
			for (let current = node; current && !kept.has(current.id); current = nodes.get(current.parent)) {
				kept.set(current.id, current);
			}
		}
		return kept;
	}

	// Open the way down to `node`: its ancestors show their children, not
	// their tables.
	function reveal(node) {
		for (let ancestor = node.parentNode; ancestor && !expanded.has(ancestor.id); ancestor = ancestor.parentNode) {
			expanded.add(ancestor.id);
			tableHidden.add(ancestor.id);
		}
	}

	// Open with what `git rbx diff` prints: every entry visible, with the
	// details of edited, moved and pivoted instances. An added or removed
	// instance is one line there, so it starts closed. A single file opens its
	// top level.
	function seedExpansion(nodes) {
		if (!diff) {
			for (const root of roots) {
				expanded.add(root.id);
			}
			return;
		}
		for (const node of nodes.values()) {
			if (node.rows.some((change) => change.kind !== "Add")) {
				expanded.add(node.id);
				reveal(node);
			} else if (isEntry(node)) {
				reveal(node);
			}
		}
	}

	// The lines of an instance's table, git-diff style: a changed property is
	// a `-` line with the old value and a `+` line with the new one; anything
	// else is one plain line. The Properties scope decides what surrounds the
	// changes. A removed instance is all `-` lines, an added one all `+`.
	function tableLines(node) {
		if (node.kind === "Remove") {
			const record = oldById.get(node.id);
			return sectioned(propertyLines(propertyScope === "all" ? withDefaults(record) : (record?.properties ?? {}), "-"));
		}
		const record = newById.get(node.id) ?? oldById.get(node.id);
		const context =
			propertyScope === "changed" ? {} : propertyScope === "nondefault" ? (record?.properties ?? {}) : withDefaults(record);
		if (node.rows.length === 0) {
			return sectioned(propertyLines(context, " "));
		}
		const changes = new Map(node.rows.map((change) => [change.property, change]));
		// Everything about an added instance is new, its defaults included.
		const contextSign = node.kind === "Add" ? "+" : " ";
		const lines = [];
		for (const name of [...new Set([...changes.keys(), ...Object.keys(context)])].sort()) {
			const change = changes.get(name);
			if (!change) {
				lines.push({ name, sign: contextSign, value: context[name] });
				continue;
			}
			// An attribute or tag is nil on the side that doesn't have it.
			const keyed = sectionOf(name) !== PROPERTIES;
			const absent = (value, text) => text === undefined && (value === undefined || (keyed && value.type === "nil"));
			if (change.kind !== "Add" && !absent(change.current, change.currentText)) {
				lines.push({ name, sign: "-", value: change.current, text: change.currentText });
			}
			if (!absent(change.incoming, change.incomingText)) {
				lines.push({ name, sign: "+", value: change.incoming, text: change.incomingText });
			}
		}
		return sectioned(lines);
	}

	// Lines of Content-typed properties that point at an asset get its key;
	// an opened one is followed by its preview, spanning PREVIEW_ROWS rows.
	function withPreviews(node, entries) {
		const assetProperties = contentProperties[node.className];
		if (!assetProperties?.length) {
			return entries;
		}
		const out = [];
		for (const entry of entries) {
			out.push(entry);
			if (entry.header || entry.value?.type !== "string" || !assetProperties.includes(entry.name)) {
				continue;
			}
			entry.asset = assetKey(entry.value.value.value);
			if (!entry.asset) {
				continue;
			}
			entry.lineId = `${node.id}\0${entry.name}\0${entry.sign}`;
			if (previewOpen.has(entry.lineId)) {
				out.push({ preview: true, asset: entry.asset });
				for (let pad = 1; pad < PREVIEW_ROWS; pad += 1) {
					out.push({ pad: true });
				}
			}
		}
		return out;
	}

	function propertyLines(properties, sign) {
		return Object.keys(properties)
			.sort()
			.map((name) => ({ name, sign, value: properties[name] }));
	}

	// The class's defaults under the instance's own values: every property.
	function withDefaults(record) {
		return record ? { ...(defaults[record.class] ?? {}), ...record.properties } : {};
	}

	// Properties, then Attributes, then Tags, each under its own header as in
	// Studio's Properties panel. git-rbx names attributes and tags
	// `Attributes.<key>` and `Tags.<tag>`; the section drops the prefix, and a
	// tag has no value. A name shows once, on its first line.
	function sectioned(lines) {
		const out = [];
		for (const section of SECTIONS) {
			let previous;
			for (const line of lines) {
				if (sectionOf(line.name) !== section) {
					continue;
				}
				if (previous === undefined) {
					out.push({ header: [section.title, "", section.valueTitle] });
				}
				out.push({
					name: line.name,
					sign: line.sign,
					property: line.name === previous ? "" : line.name.slice(section.prefix.length),
					value: section === TAGS ? undefined : line.value,
					text: section === TAGS ? undefined : line.text,
				});
				previous = line.name;
			}
		}
		return out;
	}

	function relayout() {
		rows = flatten(roots, (node) => expanded.has(node.id), (node) =>
			tableHidden.has(node.id) ? [] : withPreviews(node, tableLines(node)),
		);
		spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
		draw();
	}

	// Header band: counts as the Studio viewer titles them and the versions,
	// then the toolbar: search, the two scopes, expand and collapse all.
	header.className = "";
	header.replaceChildren();
	const title = element("div", "title");
	if (diff) {
		const counts = document_.counts;
		title.textContent = counts
			? `${counts.added} ADDED · ${counts.removed} REMOVED · ${counts.modified} MODIFIED · ${counts.reparented} REPARENTED · ${counts.pivoted} PIVOTED`
			: "";
	} else {
		title.textContent = `${newInstances.length} INSTANCES`;
	}
	title.append(element("span", "versions", diff ? `${message.labels.old} → ${message.labels.new}` : message.labels.new));

	const toolbar = element("div", "toolbar");
	const search = element("input", "search");
	search.type = "text";
	search.placeholder = "Search instances";
	search.spellcheck = false;
	const matchCount = element("span", "match-count");
	let searchTimer;
	search.addEventListener("input", () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			query = search.value.trim();
			revealMatches = true;
			rebuild();
		}, 120);
	});
	search.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			step(matches, event.shiftKey ? -1 : 1);
		} else if (event.key === "Escape" && search.value) {
			search.value = "";
			query = "";
			rebuild();
		}
	});

	function scopeSelect(label, options, value, onChange) {
		const wrapper = element("label", "scope");
		const select = element("select");
		for (const [optionValue, text] of options) {
			const option = element("option", undefined, text);
			option.value = optionValue;
			select.append(option);
		}
		select.value = value;
		select.addEventListener("change", () => onChange(select.value));
		wrapper.append(`${label} `, select);
		return wrapper;
	}

	const expandAll = element("button", undefined, "Expand all");
	expandAll.addEventListener("click", () => {
		for (const id of nodeById.keys()) {
			expanded.add(id);
		}
		tableHidden.clear();
		relayout();
	});
	const collapseAll = element("button", undefined, "Collapse all");
	collapseAll.addEventListener("click", () => {
		expanded.clear();
		tableHidden.clear();
		relayout();
	});

	toolbar.append(search, matchCount);
	if (diff) {
		toolbar.append(
			scopeSelect("Instances", [["changed", "Changed"], ["all", "All"]], instanceScope, (value) => {
				instanceScope = value;
				rebuild();
			}),
		);
	}
	toolbar.append(
		scopeSelect(
			"Properties",
			[...(diff ? [["changed", "Changed"]] : []), ["nondefault", "Non-default"], ["all", "All"]],
			propertyScope,
			(value) => {
				propertyScope = value;
				relayout();
			},
		),
		expandAll,
		collapseAll,
	);
	header.append(title, toolbar);

	function updateMatchCount() {
		const current = matches.findIndex((node) => node.id === selectedId);
		matchCount.textContent = !query
			? ""
			: matches.length === 0
				? "No results"
				: current === -1
					? `${matches.length} found`
					: `${current + 1} of ${matches.length}`;
	}

	list.replaceChildren();
	const spacer = element("div", "spacer");
	list.append(spacer);
	const empty = element("div", "empty", "No semantic differences");


	function markerIcon(kind) {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("class", "marker");
		svg.innerHTML = `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">${MARKER_SVG[kind]}</g>`;
		return svg;
	}

	// One instance row (DomLabel.luau), plus the resolver explorer's
	// disclosure triangle on rows that have a table to open.
	function nodeRow(row) {
		const node = row.node;
		const depth = node.depth;
		const indent = (depth - 1) * 12 + 15;
		const half = ROW_HEIGHT / 2;
		const kindClass = node.kind ? KIND_CLASS[node.kind] : "plain";
		const el = element("div", `row node ${kindClass}`);
		const content = element("div", "content");
		el.append(content);

		// Line guides: one per ancestor depth still in progress; the final
		// child's own guide stops halfway to meet the connector.
		for (let i = 2; i <= depth; i += 1) {
			if (row.depthsComplete[i]) {
				continue;
			}
			const short = node.isFinalChild && i === depth;
			const guide = element("span", "guide");
			guide.style.left = `${12 * (i - 1) + 6}px`;
			guide.style.height = short ? `${half + 3}px` : row.isFinalElement ? `${ROW_HEIGHT - (half - 3)}px` : `${ROW_HEIGHT + 2}px`;
			content.append(guide);
		}
		const expandable = node.children.length > 0 || tableLines(node).length > 0;
		if (depth !== 1) {
			// Runs to the triangle, or to the icon when there isn't one.
			const connector = element("span", "connector");
			const left = 12 * depth - 6;
			connector.style.left = `${left}px`;
			connector.style.width = `${indent + (expandable ? DISCLOSURE_OFFSET : ICON_OFFSET) - 2 - left}px`;
			content.append(connector);
		}
		if (expandable) {
			const disclosure = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			disclosure.setAttribute("viewBox", "0 0 24 24");
			disclosure.setAttribute("class", "disclosure");
			disclosure.style.left = `${indent + DISCLOSURE_OFFSET}px`;
			disclosure.innerHTML = DISCLOSURE_SVG[expanded.has(node.id) ? "open" : "closed"];
			content.append(disclosure);
		}

		if (node.kind) {
			content.append(markerIcon(node.kind));
		}
		const icon = element("span", "class-icon");
		icon.style.left = `${indent + ICON_OFFSET}px`;
		const url = iconUrl(message.icons, node.className);
		if (url) {
			icon.style.backgroundImage = url;
			icon.style.webkitMaskImage = url;
		}
		icon.title = node.className;
		content.append(icon);

		const name = element("span", "name");
		const at = node.match ? node.name.toLowerCase().indexOf(query.toLowerCase()) : -1;
		if (at === -1) {
			name.textContent = node.name;
		} else {
			name.append(
				node.name.slice(0, at),
				element("mark", undefined, node.name.slice(at, at + query.length)),
				node.name.slice(at + query.length),
			);
		}
		name.style.left = `${indent + NAME_OFFSET}px`;
		name.title = `${node.name} (${node.className})`;
		content.append(name);

		// Rojo shows the edit count for edited and added nodes and nothing
		// for removals.
		if (node.kind !== "Remove" && node.rows.length > 0) {
			content.append(element("span", "count", String(node.rows.length)));
		}
		return el;
	}

	// The table under an expanded node, indented as ChangeList.luau does:
	// Property / sign / Value.
	function columns(row, cells) {
		const indent = (row.node.depth - 1) * 12 + 15 + TABLE_OFFSET;
		const container = element("div", "columns");
		container.style.left = `${indent}px`;
		container.append(...cells);
		return container;
	}

	// Table rows carry on the tree's line guides, as Rojo's change lists do:
	// every column still in progress, including the instance's own when a
	// sibling follows it and the one down to its children when it has some.
	function tableGuides(row, content, span = 1) {
		const node = row.node;
		const deepest = node.children.length > 0 ? node.depth + 1 : node.depth;
		for (let i = 2; i <= deepest; i += 1) {
			if (row.depthsComplete[i]) {
				continue;
			}
			const guide = element("span", "guide");
			guide.style.left = `${12 * (i - 1) + 6}px`;
			guide.style.height = `${span * ROW_HEIGHT + 2}px`;
			content.append(guide);
		}
	}

	// A preview's image, or its state while loading or when there's none.
	function fillPreview(container, key) {
		const result = previews.get(key);
		if (!result) {
			requestPreview(key);
			container.classList.add("loading");
		} else if (result.uri) {
			const image = element("img");
			image.src = result.uri;
			image.alt = "";
			container.append(image);
		} else {
			container.classList.add("unavailable");
			container.title = result.state;
		}
		return container;
	}

	// The larger preview under an opened asset line.
	function previewRow(row) {
		const key = row.entry.asset;
		const el = element("div", "row preview");
		el.style.height = `${PREVIEW_ROWS * ROW_HEIGHT}px`;
		const content = element("div", "content");
		tableGuides(row, content, PREVIEW_ROWS);
		const frame = element("div", "preview-frame");
		frame.style.left = `${(row.node.depth - 1) * 12 + 15 + TABLE_OFFSET + 12}px`;
		const details = element("div", "preview-details");
		const [kind, reference] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
		details.append(element("div", "preview-title", kind === "asset" ? `Asset ${reference}` : reference));
		const result = previews.get(key);
		const state = !result ? "Loading…" : result.uri ? undefined : `${result.state}${kind === "asset" ? " (only public, approved assets have previews)" : ""}`;
		if (state) {
			details.append(element("div", "preview-state", state));
		}
		if (kind === "asset") {
			const open = element("button", undefined, "Open in Creator Store");
			open.addEventListener("click", (event) => {
				event.stopPropagation();
				vscode.postMessage({ type: "openAsset", id: reference });
			});
			details.append(open);
		}
		frame.append(fillPreview(element("div", "preview-image"), key), details);
		content.append(frame);
		el.append(content);
		return el;
	}

	function tableHeader(row) {
		const el = element("div", "row table-header");
		const content = element("div", "content");
		tableGuides(row, content);
		content.append(columns(row, row.entry.header.map((text) => element("span", "cell", text))));
		el.append(content);
		return el;
	}

	const SIGN_CLASS = { "-": "minus", "+": "plus", " ": "same" };

	function lineRow(row) {
		const line = row.entry;
		const el = element("div", `row line ${SIGN_CLASS[line.sign]}`);
		const property = element("span", "cell property", line.property);
		property.title = line.property;
		const sign = element("span", "cell sign", line.sign.trim());
		const value = displayValue(line.value, line.text);
		value.classList.add("cell");
		if (line.asset) {
			el.classList.add("asset");
			const disclosure = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			disclosure.setAttribute("viewBox", "0 0 24 24");
			disclosure.setAttribute("class", "asset-disclosure");
			disclosure.innerHTML = DISCLOSURE_SVG[previewOpen.has(line.lineId) ? "open" : "closed"];
			value.prepend(disclosure, fillPreview(element("span", "thumb"), line.asset));
		}
		const content = element("div", "content");
		tableGuides(row, content);
		content.append(columns(row, [property, sign, value]));
		el.append(content);
		return el;
	}

	function draw() {
		for (const child of [...list.children]) {
			if (child !== spacer) {
				child.remove();
			}
		}
		if (rows.length === 0) {
			list.append(empty);
			return;
		}
		const first = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - OVERSCAN);
		const last = Math.min(rows.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW_HEIGHT) + OVERSCAN);
		// The selection's ancestors are tinted, as the Studio resolver's
		// explorer does.
		const onPath = new Set();
		for (let node = nodeById.get(selectedId)?.parentNode; node; node = node.parentNode) {
			onPath.add(node.id);
		}
		const fragment = document.createDocumentFragment();
		for (let index = first; index < last; index += 1) {
			const row = rows[index];
			if (row.kind === "pad") {
				continue;
			}
			const el =
				row.kind === "node"
					? nodeRow(row)
					: row.kind === "header"
						? tableHeader(row)
						: row.kind === "preview"
							? previewRow(row)
							: lineRow(row);
			el.style.top = `${index * ROW_HEIGHT}px`;
			if (row.index % 2 === 0) {
				el.classList.add("stripe");
			}
			if (row.kind === "node" && row.node.id === selectedId) {
				el.classList.add("selected");
			} else if (row.kind === "node" && onPath.has(row.node.id)) {
				el.classList.add("on-path");
			}
			el.addEventListener("click", () => {
				selectedId = row.node.id;
				updateMatchCount();
				if (row.kind === "node" && (row.node.children.length > 0 || tableLines(row.node).length > 0)) {
					const id = row.node.id;
					if (expanded.has(id) && !tableHidden.has(id)) {
						expanded.delete(id);
					} else {
						expanded.add(id);
					}
					tableHidden.delete(id);
					relayout();
				} else if (row.kind === "change" && row.entry.asset) {
					if (!previewOpen.delete(row.entry.lineId)) {
						previewOpen.add(row.entry.lineId);
					}
					relayout();
				} else {
					draw();
				}
			});
			fragment.append(el);
		}
		list.append(fragment);
	}

	// Next/previous entry of the CLI diff, in tree order.
	function navigate(direction) {
		const entries = [];
		(function collect(nodes) {
			for (const node of nodes) {
				if (isEntry(node)) {
					entries.push(node);
				}
				collect(node.children);
			}
		})(roots);
		step(entries, direction, true);
	}

	// Select the next/previous node of `targets`, opening the way to it (and
	// its table, when `open`).
	function step(targets, direction, open) {
		if (targets.length === 0) {
			return;
		}
		const currentIndex = targets.findIndex((node) => node.id === selectedId);
		const targetIndex =
			currentIndex === -1
				? direction > 0
					? 0
					: targets.length - 1
				: (currentIndex + direction + targets.length) % targets.length;
		const target = targets[targetIndex];
		selectedId = target.id;
		reveal(target);
		if (open) {
			expanded.add(target.id);
			tableHidden.delete(target.id);
		}
		relayout();
		updateMatchCount();
		const index = rows.findIndex((row) => row.kind === "node" && row.node.id === target.id);
		list.scrollTop = Math.max(0, index * ROW_HEIGHT - list.clientHeight / 3);
		draw();
	}

	rebuild();
	return { draw, navigate };
}
