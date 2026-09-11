import { describe, expect, test } from "bun:test";
import factory from "../src/index.ts";

describe("extension entry", () => {
	test("default export is a factory", () => {
		expect(typeof factory).toBe("function");
	});
});
