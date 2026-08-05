import { describe, it, expect } from "vitest";
import { buildFileIconIndex, resolveFileIcon } from "./file-icons";
import type { FileIconContribution } from "./contributions";

const code: FileIconContribution = { id: "code", icon: "file-code", extensions: ["ts", "tsx", "js"] };
const json: FileIconContribution = { id: "json", icon: "file-json", extensions: ["json"] };
const docker: FileIconContribution = { id: "docker", icon: "container", filenames: ["dockerfile", ".dockerignore"] };
const git: FileIconContribution = { id: "git", icon: "git-branch", filenames: [".gitignore"] };

describe("buildFileIconIndex + resolveFileIcon", () => {
  const index = buildFileIconIndex([code, json, docker, git]);

  it("按扩展名命中,大小写不敏感", () => {
    expect(resolveFileIcon(index, "app.TS")?.icon).toBe("file-code");
    expect(resolveFileIcon(index, "data.Json")?.icon).toBe("file-json");
  });

  it("文件名精确匹配优先于扩展名", () => {
    expect(resolveFileIcon(index, "Dockerfile")?.icon).toBe("container");
    expect(resolveFileIcon(index, ".dockerignore")?.icon).toBe("container");
  });

  it("点开头文件整体是文件名,不取扩展名", () => {
    expect(resolveFileIcon(index, ".gitignore")?.icon).toBe("git-branch");
    expect(resolveFileIcon(index, ".ts")).toBeNull();
  });

  it("未命中返回 null", () => {
    expect(resolveFileIcon(index, "README.md")).toBeNull();
    expect(resolveFileIcon(index, "noext")).toBeNull();
  });

  it("后出现的贡献项在同一 key 上覆盖先出现者(高优先级 source 胜出)", () => {
    const override: FileIconContribution = { id: "custom-ts", icon: "file-emoji", extensions: ["ts"] };
    const merged = buildFileIconIndex([code, override]);
    expect(resolveFileIcon(merged, "a.ts")?.icon).toBe("file-emoji");
    expect(resolveFileIcon(merged, "a.tsx")?.icon).toBe("file-code");
  });

  it("文件名与扩展名两个维度独立覆盖", () => {
    const override: FileIconContribution = { id: "custom-dockerfile", icon: "file-cog", filenames: ["dockerfile"] };
    const merged = buildFileIconIndex([docker, override]);
    expect(resolveFileIcon(merged, "Dockerfile")?.icon).toBe("file-cog");
    expect(resolveFileIcon(merged, ".dockerignore")?.icon).toBe("container");
  });
});
