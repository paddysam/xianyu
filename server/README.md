# 闲鱼智能客服助手 · 本地后端（MySQL）

给浏览器插件用的本地 HTTP 后端。启用后，**卡密库存、发货记录、知识库/商品规则**都存到你的 MySQL；
自动发货时"取卡密 + 扣库存 + 去重"在**数据库事务**里完成，并发也不会发错/发重。

## 为什么需要它

浏览器插件在沙箱里不能直接连数据库（TCP 连不了），必须经一个本地后端中转。
插件通过 HTTP 调这个后端，后端读写 MySQL。

## 启动步骤

前置：本机已装并启动 MySQL 8.0+、Node.js。

```bash
cd server
npm install                 # 装依赖
cp .env.example .env        # 复制配置，然后编辑 .env 填 MySQL 密码等
npm run init-db             # 建库 + 建表（读 schema.sql）
npm start                   # 启动，默认 http://127.0.0.1:8788
```

看到 `✓ 闲鱼助手后端已启动` 即成功。浏览器打开 <http://127.0.0.1:8788/api/health> 应返回 `"db":"ok"`。

然后在插件设置页「高级 → 数据源」填后端地址 `http://127.0.0.1:8788`，点「测试连接」→「保存全部设置」。
本地已有的规则会在保存时一并迁移进数据库。

## .env 配置

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=xianyu_assistant
PORT=8788
AUTH_TOKEN=            # 可选，设了插件里要填一样的值；本机使用一般留空即可
```

## 数据表

| 表 | 作用 |
|---|---|
| `products` | 发货规则（商品标题 + 规格 + 价格 + 发货方式/模板） |
| `cards` | 卡密库存（available 在库 / used 已发） |
| `deliveries` | 发货记录（order_id 唯一，去重 + 对账） |
| `kb_entries` | 知识库关键词问答 |
| `kv_store` | 杂项（店铺知识文本等） |

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（含数据库连通状态） |
| GET | `/api/products` | 规则列表（含每规则在库数 stock、已发数 sold） |
| POST/PUT/DELETE | `/api/products[/:id]` | 规则增改删 |
| GET | `/api/products/:id/cards` | 查看某规则卡密 |
| POST | `/api/products/:id/cards` | 补货（批量加卡密） |
| POST | `/api/deliver` | **原子发货**：事务内去重+匹配规则+锁卡扣减+记录 |
| POST | `/api/deliver/rollback` | 聊天发送失败时回滚（恢复卡密、删记录） |
| GET | `/api/deliveries` | 发货记录（对账） |
| GET/PUT | `/api/kb` | 知识库读写 |

## 安全说明

- 默认只监听 `127.0.0.1`（本机），不对外网开放。
- 如需简单鉴权，设 `.env` 的 `AUTH_TOKEN`，插件设置里填相同值即可。
