# Covel Catalog — Cloudflare

面向少量用户的独立部署：**Workers + D1 + 私有 R2**，GitHub Actions 负责采集和 ZIP 打包。不需要 VPS、Redis 或 Kubernetes；不会自动开通付费计划。

两个站点共用 `https://api.covel.cc`。目录默认返回 24 条摘要，详情与历史按需读取。首次未缓存下载返回持久 `202 pending` 任务；可信 runner 完成单包校验后才签发票据并计入 `downloadRequests`。旧票据、历史版本和缓存命中始终检查当前规则及 GitHub 公开身份。

```sh
npm ci --ignore-scripts
npm run check:vendor
npm run test:kit
npm run build
npm test
```

公共规则、适配器、哈希、打包器及同一套 UI 来自 [covel-ai/covel-catalog](https://github.com/covel-ai/covel-catalog) 的固定 commit。`catalog-kit.lock.json` 记录完整文件 SHA-256 清单；不手改 vendor，依赖安装只使用副本。Workers 仅消费可运行的存储无关核心，不加载 Node SQLite/HTTP/磁盘服务。

- [架构、事务与授权边界](docs/architecture.md)
- [部署、环境变量、队列运维与可重复恢复](docs/operations.md)
- [费用、免费额度与容量边界](docs/costs.md)
- [通过 GitHub 管理黑名单](docs/policy.md)
- [上游变更与两个消费端接入](docs/consumers.md)
- [本地及 CI 验收记录](docs/validation.md)

本仓包含可运行实现和本地真实 workerd/D1/R2 测试。构建与 CI 不代表已经部署云资源。当前 Wrangler 配置绑定此部署的 D1 UUID；另行部署时须替换资源绑定并设置账号 ID。R2 必须保持私有且需账号单独订阅，超额计费。生产启用前按部署文档核对账号、资源、凭据与规则。
