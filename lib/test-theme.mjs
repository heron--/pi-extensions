// A real pi theme for tests, with every token on its own palette index so
// tests can tell tokens apart.
import { Theme } from "@earendil-works/pi-coding-agent";
import { THEME_BACKGROUNDS, THEME_COLORS } from "./colors.ts";

export function testTheme(mode = "256color") {
	const foregrounds = Object.fromEntries(THEME_COLORS.map((token, index) => [token, index + 1]));
	const backgrounds = Object.fromEntries(THEME_BACKGROUNDS.map((token, index) => [token, 232 + index]));
	return new Theme(foregrounds, backgrounds, mode);
}
