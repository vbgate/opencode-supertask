import { describe, test, expect } from "bun:test";
import { parseDuration } from "../src/core/duration";

describe("parseDuration", () => {
    test("秒", () => {
        expect(parseDuration("30s")).toBe(30_000);
        expect(parseDuration("1s")).toBe(1000);
        expect(parseDuration("5sec")).toBe(5000);
        expect(parseDuration("10seconds")).toBe(10_000);
        expect(parseDuration("2 second")).toBe(2000);
    });

    test("分钟", () => {
        expect(parseDuration("1min")).toBe(60_000);
        expect(parseDuration("5min")).toBe(300_000);
        expect(parseDuration("30minutes")).toBe(1_800_000);
        expect(parseDuration("1 minute")).toBe(60_000);
        expect(parseDuration("1m")).toBe(60_000);
    });

    test("小时", () => {
        expect(parseDuration("1h")).toBe(3_600_000);
        expect(parseDuration("2h")).toBe(7_200_000);
        expect(parseDuration("1hours")).toBe(3_600_000);
        expect(parseDuration("1 hour")).toBe(3_600_000);
    });

    test("天", () => {
        expect(parseDuration("1d")).toBe(86_400_000);
        expect(parseDuration("2d")).toBe(172_800_000);
        expect(parseDuration("1days")).toBe(86_400_000);
        expect(parseDuration("3 day")).toBe(259_200_000);
    });

    test("周", () => {
        expect(parseDuration("1w")).toBe(604_800_000);
        expect(parseDuration("2weeks")).toBe(1_209_600_000);
    });

    test("毫秒", () => {
        expect(parseDuration("500ms")).toBe(500);
        expect(parseDuration("1000ms")).toBe(1000);
    });

    test("小数", () => {
        expect(parseDuration("1.5h")).toBe(5_400_000);
        expect(parseDuration("0.5d")).toBe(43_200_000);
    });

    test("ISO 8601 duration", () => {
        expect(parseDuration("PT30M")).toBe(1_800_000);
        expect(parseDuration("PT1H")).toBe(3_600_000);
        expect(parseDuration("PT1H30M")).toBe(5_400_000);
        expect(parseDuration("P1DT12H")).toBe(129_600_000);
        expect(parseDuration("PT45S")).toBe(45_000);
    });

    test("纯数字（毫秒）", () => {
        expect(parseDuration("60000")).toBe(60_000);
        expect(parseDuration("1000")).toBe(1000);
    });

    test("大小写不敏感", () => {
        expect(parseDuration("1H")).toBe(3_600_000);
        expect(parseDuration("5Min")).toBe(300_000);
        expect(parseDuration("2D")).toBe(172_800_000);
    });

    test("带空格", () => {
        expect(parseDuration("  1h  ")).toBe(3_600_000);
        expect(parseDuration("5 min")).toBe(300_000);
    });

    test("无效输入返回 null", () => {
        expect(parseDuration("abc")).toBeNull();
        expect(parseDuration("")).toBeNull();
        expect(parseDuration("0")).toBeNull();
        expect(parseDuration("-1h")).toBeNull();
    });
});
