-- 闲鱼智能客服助手 数据库表结构（MySQL 8.0+）
-- 用 npm run init-db 自动执行，或手动 source 此文件。

CREATE TABLE IF NOT EXISTS style_samples (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  q             VARCHAR(255) NOT NULL DEFAULT '' COMMENT '买家的问',
  a             VARCHAR(500) NOT NULL COMMENT '本人的答（喂给AI学风格；不含账号密码等敏感内容）',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='话术库：本人真实回复样本';

CREATE TABLE IF NOT EXISTS products (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  match_title   VARCHAR(255) NOT NULL COMMENT '商品标题匹配（包含即命中）',
  spec          VARCHAR(255) NOT NULL DEFAULT '' COMMENT '规格（精确匹配，空=不限）',
  price         VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '价格（精确匹配，空=不限）',
  mode          VARCHAR(16)  NOT NULL DEFAULT 'pool' COMMENT 'pool=卡密库存 / fixed=固定内容',
  delivery      TEXT COMMENT '发货话术模板或固定内容',
  note          VARCHAR(255) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='发货规则（商品+规格+价格）';

CREATE TABLE IF NOT EXISTS cards (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  product_id    BIGINT NOT NULL,
  secret        VARCHAR(1024) NOT NULL COMMENT '卡密内容（账号密码/兑换码等）',
  status        VARCHAR(16) NOT NULL DEFAULT 'available' COMMENT 'available=在库 / used=已发',
  used_order_id VARCHAR(64) NULL COMMENT '发出时关联的订单号',
  used_at       DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_product_status (product_id, status),
  CONSTRAINT fk_cards_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='卡密库存';

CREATE TABLE IF NOT EXISTS deliveries (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id      VARCHAR(64) NOT NULL UNIQUE COMMENT '闲鱼订单号，唯一约束保证每单只发一次',
  product_id    BIGINT NULL,
  card_id       BIGINT NULL,
  title         VARCHAR(255) NOT NULL DEFAULT '',
  spec          VARCHAR(255) NOT NULL DEFAULT '',
  price         VARCHAR(32)  NOT NULL DEFAULT '',
  buyer         VARCHAR(255) NOT NULL DEFAULT '',
  content       TEXT COMMENT '实际发出的完整内容',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='发货记录（对账/去重）';

CREATE TABLE IF NOT EXISTS kb_entries (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  keywords      VARCHAR(512) NOT NULL DEFAULT '' COMMENT '逗号分隔关键词',
  reply         TEXT,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='知识库关键词问答';

-- 单行键值表：存店铺知识自由文本等
CREATE TABLE IF NOT EXISTS kv_store (
  k             VARCHAR(64) PRIMARY KEY,
  v             MEDIUMTEXT,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='杂项键值（如店铺知识文本）';

-- 远程发货指令队列：飞机上点「发货」→ 这里排一条 → 插件轮询取走执行 → 回写结果
CREATE TABLE IF NOT EXISTS deliver_commands (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id      VARCHAR(64) NOT NULL UNIQUE COMMENT '闲鱼订单号，唯一：同一单只排一条指令',
  buyer         VARCHAR(255) NOT NULL DEFAULT '',
  title         VARCHAR(255) NOT NULL DEFAULT '',
  spec          VARCHAR(255) NOT NULL DEFAULT '',
  price         VARCHAR(32)  NOT NULL DEFAULT '',
  status        VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'pending=待插件执行 / done=已发 / failed=失败',
  result        VARCHAR(255) NOT NULL DEFAULT '' COMMENT '执行结果说明（回写）',
  source        VARCHAR(16)  NOT NULL DEFAULT 'tg' COMMENT '来源：tg=飞机',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='远程发货指令队列（飞机→插件）';

-- ── 卡网自动进货（v2 新增；老库由 server.js 启动时自动 ALTER/建表，无需手动执行）──
-- products 新增列：
--   source       VARCHAR(16)  NOT NULL DEFAULT 'local'  -- local=本地库存 / shop=卡网自动进货
--   shop_sku_id  BIGINT NULL                             -- 卡网 SKU ID（source=shop 必填）
--   max_cost     DECIMAL(10,2) NULL                      -- 单件成本上限，卡网价超过则不自动进货
CREATE TABLE IF NOT EXISTS shop_purchases (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id      VARCHAR(64) NOT NULL UNIQUE COMMENT '闲鱼订单号（一单最多一笔进货）',
  product_id    BIGINT NOT NULL,
  shop_sku_id   BIGINT NOT NULL,
  downstream_no VARCHAR(80) NOT NULL COMMENT '发给卡网的幂等单号（先落库再下单，崩溃重放不重复扣款）',
  attempt       INT NOT NULL DEFAULT 1,
  shop_order_id BIGINT NULL,
  shop_order_no VARCHAR(64) NULL,
  amount        VARCHAR(32) NULL COMMENT '实际扣款金额（对账用）',
  status        VARCHAR(16) NOT NULL DEFAULT 'ordering' COMMENT 'ordering/ordered/imported/failed',
  error         VARCHAR(255) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='卡网自动进货记录';
