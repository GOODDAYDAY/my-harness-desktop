import { describe, expect, it } from "vitest";
import { pairRecords, parseIndex, parseLogText, shardNumber } from "./log-model";

describe("parseLogText", () => {
  it("解析 request/response 行,跳过坏行与形态不合法行", () => {
    const text = [
      '{"seq":1,"ts":100,"kind":"request","payload":{}}',
      '{"seq":1,"ts":200,"kind":"response","status":200,"message":{}}',
      '{"seq":2,"ts":300', // 崩溃半截行
      '{"kind":"request"}', // 缺 seq/ts
      "",
      '{"seq":3,"ts":400,"kind":"unknown"}', // 未知 kind
    ].join("\n");
    const lines = parseLogText(text);
    expect(lines).toHaveLength(2);
    expect(lines[0].kind).toBe("request");
    expect(lines[1].kind).toBe("response");
  });
});

describe("pairRecords", () => {
  it("同 seq 配对,倒序;无 response 的为孤儿", () => {
    const lines = parseLogText([
      '{"seq":1,"ts":100,"kind":"request","payload":{}}',
      '{"seq":1,"ts":200,"kind":"response","status":200,"message":{}}',
      '{"seq":2,"ts":300,"kind":"request","payload":{}}',
    ].join("\n"));
    const pairs = pairRecords(lines);
    expect(pairs.map((p) => p.seq)).toEqual([2, 1]);
    expect(pairs[0].response).toBeNull();
    expect(pairs[1].response?.status).toBe(200);
  });

  it("孤儿 response(无 request 配对)丢弃", () => {
    const lines = parseLogText('{"seq":9,"ts":100,"kind":"response","message":{}}');
    expect(pairRecords(lines)).toHaveLength(0);
  });
});

describe("shardNumber", () => {
  const base = "2026-08-05T10-00-00-000Z_abc.jsonl";
  it("首片 = 1,编号分片 = N;非分片文件为 null", () => {
    expect(shardNumber(base, base)).toBe(1);
    expect(shardNumber(`${base}.2.jsonl`, base)).toBe(2);
    expect(shardNumber(`${base}.10.jsonl`, base)).toBe(10);
    expect(shardNumber("index.json", base)).toBeNull();
    expect(shardNumber("other.jsonl", base)).toBeNull();
    expect(shardNumber(`${base}.jsonl`, base)).toBeNull(); // 双后缀不是分片
  });
});

describe("parseIndex", () => {
  it("正常解析;垃圾返回 null", () => {
    expect(parseIndex('{"version":1,"sessions":{"a.jsonl":{"bytes":10,"requests":2,"updatedAt":1}}}'))
      .toEqual({ "a.jsonl": { bytes: 10, requests: 2, updatedAt: 1 } });
    expect(parseIndex("not json")).toBeNull();
    expect(parseIndex('{"version":1}')).toBeNull();
  });
});
