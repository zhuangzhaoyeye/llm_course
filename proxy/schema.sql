-- 匿名统计表。一批（一次 sendBeacon）一行，事件压成一列 JSON，省行数（D1 按写入行数计费）。
-- 故意不建索引：D1 文档没写明索引写入是否额外计入 rows written，不确定的事不赌；
-- 数据量小，全表扫描的读额度（每天 500 万行）绰绰有余。
-- 初始化：npx wrangler d1 execute llm-course-stats --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,   -- 服务端收到本批的毫秒时间戳。批内事件的 t 是「相对本次访问开始的毫秒数」，只用于排序和算间隔，不是绝对时间
  cid TEXT NOT NULL,     -- 匿名访客 ID（浏览器 localStorage 里随机生成，不是指纹）
  sid TEXT NOT NULL,     -- 本次访问 ID
  vn INTEGER NOT NULL,   -- 该访客第几次访问
  fd TEXT NOT NULL,      -- 该访客首次访问日期 YYYY-MM-DD
  dev TEXT NOT NULL,     -- mobile / tablet / desktop
  w INTEGER NOT NULL,    -- 屏幕宽度（px）
  ref TEXT NOT NULL,     -- 来源主机名（不含路径和查询串），直接打开则为空
  n INTEGER NOT NULL,    -- 本批事件数
  ev TEXT NOT NULL       -- JSON 数组：[{e,t,...}]，字段白名单见 events.js
);
