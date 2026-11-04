// A headless Chrome or Edge, whichever is installed (SCREENSHOT_BROWSER picks
// one: a Playwright channel such as "chrome" or "msedge").
const { chromium } = require("playwright-core");

async function launch() {
	const channels = process.env.SCREENSHOT_BROWSER ? [process.env.SCREENSHOT_BROWSER] : ["chrome", "msedge"];
	for (const channel of channels) {
		try {
			return await chromium.launch({ channel, headless: true });
		} catch {
			// Not installed.
		}
	}
	throw new Error(`no browser found (tried ${channels.join(", ")}); set SCREENSHOT_BROWSER`);
}

module.exports = { launch };
