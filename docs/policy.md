# 通过 GitHub 管理黑名单

本部署的规则文件是 [`catalog/policy.json`](../catalog/policy.json)。仓库公开，所以规则和撤销原因也公开。Cloudflare API Token、策略发布凭据均只放在 GitHub Environment Secrets 或 Cloudflare Worker Secrets，不能写进此文件。

1. 编辑规则文件：添加、修改或移除 `rules` 中的规则。
2. 将 `sequence` 递增，填写新的 `version`、当前 UTC `issuedAt` 和将来的 `expiresAt`。当前首版为空规则，过期时间为 **2026-11-05 00:00 UTC**；届时之前需要发布下一版。即使规则未变，续期也需新 sequence。
3. 审阅并提交到 `main`。提交本身不会发布策略。
4. 到仓库 Actions，选择 **Publish reviewed policy**，点击 **Run workflow**，选择 `main`。只有 `main` 可以取得 `catalog-policy` 环境的发布 Secret。
5. 检查工作流成功，并核对 `https://api.covel.cc/v1/policy` 的 sequence 和有效期。

规则示例（数字仅示意，必须换成实际 GitHub numeric ID）：

```json
{
  "id": "withdraw-plugin-example",
  "kind": "plugins",
  "repositoryId": 123456789,
  "path": "plugins/example",
  "reason": "作者要求撤下此包",
  "createdAt": "2026-10-29T00:00:00.000Z"
}
```

删除 `path` 可撤销整个仓库；用 `ownerId` 可以撤销该所有者的包；`repositoryId` + 完整 `commitSha` 可以撤销特定提交；`contentHash` 或 `artifactSha256` 可以撤销已核验的内容或 ZIP。不要使用仓库名称替代 numeric ID。一个规则中的多个条件需要同时命中，多个规则之间任意命中即撤销。此部署最多接受 100 条当前规则。

新策略发布后立即用于查询、签票、旧票据、旧版本和缓存命中，无需等待采集或重打 ZIP。已传出的文件无法收回。策略缺失或过期时目录和下载拒绝服务，不会默默忽略过期黑名单。恢复误撤销需要删除对应规则并发布更高 sequence；不能回滚数据库或重用旧 sequence。

策略工作流只取得策略发布凭据，采集工作流只取得任务凭据。它们均不向前端提供密钥，也不运行包内脚本。
