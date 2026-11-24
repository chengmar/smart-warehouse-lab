CREATE TABLE IF NOT EXISTS system_lock (
  id INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  name VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL,
  password_hash VARCHAR(256) NOT NULL,
  UNIQUE (username)
);

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  category VARCHAR(64) NOT NULL,
  unit VARCHAR(12) NOT NULL,
  min_stock INTEGER NOT NULL,
  cold INTEGER NOT NULL,
  CHECK (min_stock >= 0 AND cold IN (0,1))
);

CREATE TABLE IF NOT EXISTS locations (
  id VARCHAR(64) PRIMARY KEY,
  zone VARCHAR(64) NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  cold INTEGER NOT NULL,
  CHECK (capacity > 0 AND cold IN (0,1))
);

CREATE TABLE IF NOT EXISTS lots (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(64) NOT NULL,
  location_id VARCHAR(64) NOT NULL,
  batch VARCHAR(64) NOT NULL,
  expiry VARCHAR(10) NOT NULL,
  on_hand INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (location_id) REFERENCES locations(id),
  UNIQUE (product_id, location_id, batch),
  CHECK (reserved >= 0 AND on_hand >= reserved)
);

CREATE TABLE IF NOT EXISTS receipts (
  id VARCHAR(64) PRIMARY KEY,
  lot_id VARCHAR(64) NOT NULL,
  qty INTEGER NOT NULL,
  supplier VARCHAR(128) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (lot_id) REFERENCES lots(id),
  CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(64) PRIMARY KEY,
  customer VARCHAR(128) NOT NULL,
  destination VARCHAR(128) NOT NULL,
  priority VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS order_lines (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(64) NOT NULL,
  qty INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  CHECK (qty > 0),
  UNIQUE (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS allocations (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  lot_id VARCHAR(64) NOT NULL,
  qty INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (lot_id) REFERENCES lots(id),
  CHECK (qty > 0),
  UNIQUE (order_id, lot_id)
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id VARCHAR(64) PRIMARY KEY,
  lot_id VARCHAR(64) NOT NULL,
  order_id VARCHAR(64) ,
  operator_id VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  delta_hand INTEGER NOT NULL,
  delta_reserved INTEGER NOT NULL,
  reason VARCHAR(256) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (lot_id) REFERENCES lots(id),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (operator_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id VARCHAR(64) PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(64) NOT NULL,
  payload TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  previous_hash VARCHAR(64) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  attempts INTEGER NOT NULL,
  available_at VARCHAR(32) NOT NULL,
  error VARCHAR(256),
  consumed_at VARCHAR(32)
);

CREATE TABLE IF NOT EXISTS shipments (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL,
  carrier VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  UNIQUE (order_id)
);

CREATE TABLE IF NOT EXISTS tracking (
  id VARCHAR(64) PRIMARY KEY,
  shipment_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  message VARCHAR(256) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (shipment_id) REFERENCES shipments(id)
);

CREATE TABLE IF NOT EXISTS readings (
  id VARCHAR(64) PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL,
  temperature DECIMAL(6,2) NOT NULL,
  created_at VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id VARCHAR(64) PRIMARY KEY,
  kind VARCHAR(64) NOT NULL,
  message VARCHAR(256) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  resolved_at VARCHAR(32)
);

CREATE TABLE IF NOT EXISTS idempotency (
  id VARCHAR(64) PRIMARY KEY,
  fingerprint VARCHAR(64) NOT NULL,
  response TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL
);
