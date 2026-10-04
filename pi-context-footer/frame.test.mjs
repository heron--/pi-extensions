import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FRAME_CASES } from "./frame-cases.mjs";
import { plain, startFooter } from "./harness.mjs";

const expected = JSON.parse(readFileSync(new URL("./fixtures/frame.json", import.meta.url), "utf8"));

FRAME_CASES.forEach((frameCase, index) => {
	test(`frame: ${frameCase.name}`, async () => {
		// A fresh module per case, so no state carries over between them.
		const host = await startFooter(new URL(`./index.ts?case=${index}`, import.meta.url).href, frameCase.options);
		try {
			await frameCase.setup?.(host);
			const lines = frameCase.footer ? host.renderFooter(frameCase.width) : host.renderEditor(frameCase.width);
			assert.deepEqual(lines.map(plain), expected[frameCase.name]);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= frameCase.width, `over-wide row: ${JSON.stringify(plain(line))}`);
			}
			if (!frameCase.footer) {
				// While the frame draws, the footer row stays empty.
				assert.deepEqual(host.renderFooter(frameCase.width), []);
			}
		} finally {
			await host.shutdown();
		}
	});
});
