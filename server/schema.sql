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
