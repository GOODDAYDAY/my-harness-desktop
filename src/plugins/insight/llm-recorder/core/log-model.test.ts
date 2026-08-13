import { describe, expect, it } from "vitest";
import { mergeRecords, nextCursor, pairRecords, parseIndex, parseLogText, shardNumber } from "./log-model";

describe("nextCursor", () => {
  it("游标指向最后一个非空行之后——增量读不丢新增行", () => {
    // 两条记录的完整文件:末尾 \n 会被 split 拆成空串,游标若按 split length 会多 1
    const t1 = '{"seq":1,"ts":100,"kind":"request"}\n{"seq":1,"ts":200,"kind":"response"}\n';
    const cursor = nextCursor(t1);
    expect(cursor).toBe(2);
    // 追加一行后,从游标继续解析能读到新增行(而不是被空串错位漏掉)
    const t2 = t1 + '{"seq":2,"ts":300,"kind":"request"}\n';
    expect(parseLogText(t2, cursor).map((l) => l.seq)).toEqual([2]);
  });

  it("空/全空文本返回 0;坏行(半截)也算消费位,不重复解析", () => {
    expect(nextCursor("")).toBe(0);
    expect(nextCursor("\n\n")).toBe(0);
    // 坏行是「非空」行,占一个 split 位——游标把它算进已消费,parseLogText 从游标起不再碰它
    const bad = '{"seq":1,"ts":100,"kind":"request"}\n{"seq":2,"ts":300';
    const cursor = nextCursor(bad);
    expect(cursor).toBe(2);
    const appended = bad + '\n{"seq":3,"ts":400,"kind":"request"}\n';
    // 坏行 index 1 已被消费,从游标(2)起是新增的 seq 3
    expect(parseLogText(appended, cursor).map((l) => l.seq)).toEqual([3]);
  });
});

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

describe("mergeRecords", () => {
  const req = (seq: number): string =>
    `{"seq":${seq},"ts":${seq * 100},"kind":"request","payload":{}}`;
  const res = (seq: number): string =>
    `{"seq":${seq},"ts":${seq * 100 + 50},"kind":"response","status":200,"message":{}}`;

  it("response 后于 request 落盘(中间态)：request 已在 prev，response 到达命中并流转", () => {
    // 全量读到 request seq=2(无 response)，显示「未返回」
    const prev = pairRecords(parseLogText([req(1), res(1), req(2)].join("\n")));
    expect(prev.find((p) => p.seq === 2)?.response).toBeNull();
    // 增量只读到 response seq=2 —— pairRecords 会把它当孤儿丢弃，mergeRecords 命中 prev
    const merged = mergeRecords(prev, parseLogText(res(2)));
    expect(merged.find((p) => p.seq === 2)?.response?.status).toBe(200);
    expect(merged.map((p) => p.seq)).toEqual([2, 1]);
  });

  it("request+response 同批到达：正确配对，不重复", () => {
    const prev = pairRecords(parseLogText([req(1), res(1)].join("\n")));
    const merged = mergeRecords(prev, parseLogText([req(2), res(2)].join("\n")));
    expect(merged.map((p) => p.seq)).toEqual([2, 1]);
    expect(merged.find((p) => p.seq === 2)?.response?.status).toBe(200);
  });

  it("request 先到、response 后到，分两次增量：第二次后状态从「未返回」流转为返回", () => {
    let pairs = pairRecords(parseLogText(req(1)));
    expect(pairs[0].response).toBeNull();
    pairs = mergeRecords(pairs, parseLogText(res(1)));
    expect(pairs[0].response?.status).toBe(200);
  });

  it("空 newLines 返回 prev 本身语义（不新增不丢）", () => {
    const prev = pairRecords(parseLogText([req(1), res(1)].join("\n")));
    expect(mergeRecords(prev, [])).toHaveLength(1);
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
