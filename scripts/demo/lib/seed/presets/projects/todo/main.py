# todo CLI — 演示项目
def load():
    # 读本地 JSON 数据文件
    with open("db.json") as f:
        return json.load(f)


def main():
    print("todo v0.1")


if __name__ == "__main__":
    main()
