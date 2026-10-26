# dsh-firebird-connector

DeepSeek Harness（dsh）的 Firebird 数据库连接器 bundle 插件。让 dsh agent 在明确的权限边界内查询、写入和维护 Firebird 2.5 / 3.0 / 4.0 / 5.0 数据库。

核心约束：

- **凭据只来自环境变量或 dsh 凭据引用**，配置文件、工具结果和审计日志里都不会出现明文密码。
- **所有值必须通过 `?` / `:name` 参数绑定**，插件不接受把用户输入拼进 SQL。
- **每个连接必须声明 `accessMode`**（`readonly` / `readwrite` / `admin`），可叠加对象白名单。
- **每次工具调用都写 JSONL 审计**（含拒绝和失败），SQL 只保留前 200 字符，另附完整 SQL 的 SHA-256。
- **写操作默认需要显式确认**，危险操作需要二次确认，GRANT/REVOKE 使用一次性确认令牌。
- **Node 侧驱动运行在独立子进程**，超时后回收 worker，不会把整个 dsh 进程拖死。

---

## 环境要求

- Node.js >= 20.19（dsh 自带运行时即可）
- 支持插件/bundle 的 dsh 版本
- Firebird 2.5、3.0、4.0 或 5.0
- `node-firebird@^2.18.2`（安装在 dsh profile，而不是本包依赖）

`node-firebird` 故意留空依赖：版本由 dsh profile 统一注入，避免插件包内出现第二份驱动。

## 安装

dsh 的插件是**按 profile 安装**的，没有全局插件目录。常见两个客户端对应不同 profile：

| 客户端 | profile 目录 | 说明 |
| --- | --- | --- |
| Web（`dsh web`，浏览器访问） | `~/.dsh/profiles/web` | 用 npm 安装的 `dsh` CLI 管理 |
| Desktop（DeepSeek Harness 桌面端） | `~/.dsh/profiles/desktop` | 由 Electron 应用独占，CLI 会拒绝管理 |

同一个 npm 包可以装进两个 profile，但依赖、配置和重启互不影响。只装 web 或只配 web，桌面端不会生效，反之亦然。

### Web

```bash
dsh plugin --profile web add "node-firebird@^2.18.2"
dsh plugin --profile web add "dsh-firebird-connector"

# 本地开发也可以指向目录：
# dsh plugin --profile web add "D:\study\study-test\dsh-firebird-connector"

# 编辑 ~/.dsh/profiles/web/cordis.patch.yml（见下一节），然后重启 dsh web
```

### Desktop

桌面端 profile 由 Electron 应用管理。npm 安装的 `dsh` CLI 会拒绝对 `--profile desktop` 执行启动、配置导出和插件管理请求，请使用桌面端界面：

1. 打开左侧栏的 **插件** 页面。注意不是“设置 → 内置插件”，那里只列出内置插件和官方配置页。
2. 点 **添加插件**，输入 `dsh-firebird-connector`；再用同样方式安装驱动 `node-firebird@^2.18.2`（本包不把驱动声明为运行时依赖，必须由 profile 提供）。也可以填本地目录、Git 地址或压缩包。
3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中**追加** `firebird-connector` 配置（见下一节），不要覆盖文件里已有的 UI 配置行。
4. 完全退出并重新启动 Desktop。安装后不重启，当前进程可能仍在使用旧的插件树。
5. 重启后在同一页的“已安装插件”中确认条目。该插件只注册 agent 工具，不会新增独立页面或菜单；在对话中调用 `firebird_list_connections` 验证。

bundle 的 `cordis.patch.yml` 会插入一个 id 为 `firebird-connector` 的插件条目；profile 中的 patch 通过同一个 id 覆盖它的 `config`。

发布步骤见[发布到公网（npm）](#发布到公网npm)。

## 配置

参考 [config.example.yml](config.example.yml)。**每个 profile 都要单独配置**，只改 web 不会影响 desktop：

```text
C:\Users\<用户名>\.dsh\profiles\web\cordis.patch.yml
C:\Users\<用户名>\.dsh\profiles\desktop\cordis.patch.yml
```

配置中的 `connections` 至少要有一个连接；如果只安装插件、不添加配置，插件启动校验会失败，桌面端也就看不到可用的连接。

最小示例：

```yaml
- id: firebird-connector
  config:
    logLevel: info
    audit:
      file: ~/.dsh/firebird/audit.jsonl

    connections:
      app_ro:
        dsn: firebird://127.0.0.1:3050//data/app.fdb
        accessMode: readonly
        userEnv: FB_APP_RO_USER
        passwordEnv: FB_APP_RO_PASSWORD

      app_rw:
        host: 127.0.0.1
        port: 3050
        database: '/data/app.fdb'
        accessMode: readwrite
        allowedObjects: [CUSTOMERS, ORDERS, V_ORDERS]
        userRef: firebird/app-rw-user
        passwordRef: firebird/app-rw-password
        role: APP_WRITER
        allowRoleSwitch: true

      app_admin:
        dsn: jdbc:firebirdsql://db.internal:3050//data/app.fdb
        accessMode: admin
        userEnv: FB_ADMIN_USER
        passwordEnv: FB_ADMIN_PASSWORD
```

凭据环境变量必须对 **dsh 进程**可见。Windows PowerShell 示例：

```powershell
$env:FB_APP_RO_USER = "APP_RO"
$env:FB_APP_RO_PASSWORD = "..."
```

`$env:` 只对当前终端及其子进程有效。Web 端要在启动 `dsh web` 的终端里设置；Desktop 通常从开始菜单启动，必须在 Windows 用户环境变量中设置（“系统属性 → 环境变量”，或 `setx`），然后**完全退出并重启 Desktop**。`setx` 会把值写入用户环境；如果不能接受，请改用 `userRef` / `passwordRef`。

凭据引用（`userRef` / `passwordRef`）通过 dsh 的 credentials 服务解析，名称按你的 dsh 版本/凭据插件创建。两种来源二选一，同时配置会直接报错。配置校验会拒绝 `user`、`username`、`password` 等明文字段。

### 连接配置字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `dsn` | — | 与 `host`/`port`/`database` 二选一。支持 `firebird://`、`inet://`、`inet4://`、`inet6://`、`jdbc:firebirdsql://`，以及 `[host[/port]:]database`。DSN 中禁止携带账号、查询参数或 fragment |
| `host` | `127.0.0.1` | 主机名或 IP |
| `port` | `3050` | 1–65535 |
| `database` | — | 服务器侧数据库路径或别名 |
| `accessMode` | 必填 | `readonly`、`readwrite`、`admin`（大小写不敏感） |
| `userEnv` / `userRef` | 必填（二选一） | 用户名来源 |
| `passwordEnv` / `passwordRef` | 必填（二选一） | 密码来源 |
| `charset` | `UTF8` | Firebird 字符集名，如 `UTF8`、`WIN1252`、`GBK` |
| `authPlugin` | `auto` | 认证插件：`auto`、`Srp`、`Srp256`、`Srp384`、`Srp512`、`Legacy_Auth`。`auto` 先试 `Srp`，被服务器拒绝时回退 `Legacy_Auth`（Firebird 2.5） |
| `wireCrypt` | `false` | 是否启用 wire 加密。服务器未启用/未强制 WireCrypt 时必须为 `false`；服务器要求加密时设为 `true` || `dialect` | `3` | 接受 1 或 3；当前驱动实际以 `effectiveDialect: 3` 连接（见“已知限制”） |
| `allowedObjects` | `[]` | SQL 解析阶段允许引用的表/视图/过程名，大小写不敏感，禁止通配符；空数组表示不限制 |
| `role` | — | 连接时使用的原生 Firebird role |
| `allowRoleSwitch` | `false` | 是否允许 `firebird_set_role` 重新附加连接 |
| `allowUnrestrictedDML` | `false` | 是否允许无 `WHERE` 的 UPDATE/DELETE；打开后仍需 `confirmDangerous` |
| `allowSystemTables` | `false` | 是否允许写 `RDB$` 系统表；打开后仍需 `confirmDangerous` |
| `idleTimeoutSeconds` | `300` | 空闲自动断开；`0` 表示不自动断开 |
| `connectTimeoutSeconds` | `10` | 1–300 |
| `queryTimeoutSeconds` | `30` | 1–600 |
| `ddlTimeoutSeconds` | `60` | 1–1800 |
| `maxRows` | `500` | 查询行上限，1–5000 |

根配置项只有 `logLevel`（`silent`/`error`/`warn`/`info`/`debug`）、`audit.file` 和 `connections`。未知字段会导致配置加载失败，避免拼写错误静默生效。

### 认证插件与 wire 加密

`node-firebird` 默认优先 `Srp512` 并开启 wire 加密，而部分 Firebird 3.x 只接受 `Srp` 且未启用 WireCrypt，于是会出现两种容易误判的错误：

- 默认 `Srp512` 协商失败时报 `335544375 Unavailable database`。这个错误并不一定代表数据库路径错误或数据库不存在。
- 显式 `Srp` 认证通过后，如果仍要求加密，服务器会断开并报 `Connection to Firebird server was lost`。

插件默认 `authPlugin: auto`（先 `Srp`，被拒绝则回退 `Legacy_Auth`）且 `wireCrypt: false`，可以直接连接这类服务器；Firebird 2.5 只支持 `Legacy_Auth`，`auto` 也会自动回退。需要传输加密时，先在服务器启用 WireCrypt，再给连接设置 `wireCrypt: true`。

Windows 服务器上的数据库路径注意不要写成 `/D://...`。推荐直接用 `host` + `database`：

```yaml
database: 'D:/JW-EM3/JW-EM3DB/EM3.FDB'
```

使用 DSN 时盘符前只保留一个斜杠：

```yaml
dsn: firebird://121.37.27.160:3050/D:/JW-EM3/JW-EM3DB/EM3.FDB
```

## 工具

所有工具都通过 `defineTool` 注册，带参数/输出 schema，并在 `output.render` 中返回 JSON 文本。

| 工具 | 最低 accessMode | 主要参数 | 行为 |
| --- | --- | --- | --- |
| `firebird_list_connections` | 任意 | — | 返回安全连接信息；不含凭据 |
| `firebird_query` | readonly | `connection`、`sql`、`params`、`limit` | 仅 SELECT/WITH/EXPLAIN；自动追加 `ROWS limit+1` 探测截断；拒绝 `FOR UPDATE`/`WITH LOCK` |
| `firebird_execute` | readwrite | `connection`、`sql`、`params`、`confirmWrite`、`confirmDangerous` | INSERT/UPDATE/DELETE/MERGE；事务内执行并返回影响行数/RETURNING 行 |
| `firebird_call_procedure` | readwrite | `connection`、`procedure`、`params[]` | 先校验存在性与 EXECUTE 权限，再以 `SELECT * FROM P(?, ...)` 或 `EXECUTE PROCEDURE` 调用 |
| `firebird_list_objects` | 任意 | `connection`、`type`、`filter`、`includeSystem` | 列出表/视图/过程/触发器/生成器；120 秒缓存 |
| `firebird_describe_object` | 任意 | `connection`、`name`、`type` | 列、域、索引、外键、触发器、过程参数、依赖、有效性；120 秒缓存 |
| `firebird_create` | readwrite（表/视图/索引） | `connection`、`sql`、`confirmDDL`、`confirmDangerous` | CREATE / CREATE OR ALTER / RECREATE；过程、触发器、生成器、角色等要求 admin |
| `firebird_alter` | readwrite（表/视图/索引） | 同上 | ALTER / CREATE OR ALTER；DROP COLUMN 有依赖时要求 `confirmDangerous` |
| `firebird_drop` | readwrite（表/视图/索引） | 同上 | DROP；被外键引用的表、DROP DATABASE 要求 `confirmDangerous` |
| `firebird_grant` | admin | `connection`、`privileges[]`、`objectType`、`object`、`grantee`、`withGrantOption`、`confirmPrivilege`、`confirmationToken` | 两阶段：先返回 SQL + 一次性 token，再确认执行 |
| `firebird_revoke` | admin | 同上（`grantOptionFor`） | 两阶段 REVOKE |
| `firebird_set_role` | 任意 | `connection`、`role` | 重新附加连接以切换 role；要求 `allowRoleSwitch: true`；空字符串清除 role |
| `firebird_manage_user` | admin | `connection`、`action`、`username`、`passwordEnv`/`passwordRef`、姓名、`confirmDDL`、`confirmDangerous` | CREATE/ALTER/DROP USER；密码只从环境变量/凭据引用解析；DROP 需 `confirmDangerous` |

说明：

- `readwrite` 只覆盖表、视图、索引 DDL；存储过程、触发器、函数、生成器、异常、域、角色等一律要求 `admin`。
- `CREATE DATABASE` 被拒绝（连接器是连接级的）；通用 DDL 中的 USER 语法也会被拒绝，必须走 `firebird_manage_user`。
- 过程调用会在数据库侧检查 OWNER、`PUBLIC`、当前用户和当前 role 的 EXECUTE 授权。可选择过程（selectable）可能产生副作用，是否只读最终取决于数据库授权的 Firebird 用户。
- 元数据工具只读 `RDB$` catalog，本身不受 `allowedObjects` 限制；如果对象名本身敏感，不要向不可信调用方开放元数据工具。

## 安全模型

### SQL 拦截与参数绑定

- 自带 tokenizer 识别字符串、引号标识符、注释和括号层级；注释会被丢弃，未闭合的字符串/注释直接失败。
- 除存储过程/触发器体外，多语句 SQL 一律拒绝；末尾单个分号会被规范化掉。
- `firebird_query` 只接受 SELECT/WITH/EXPLAIN；`firebird_execute` 只接受 INSERT/UPDATE/DELETE/MERGE；DDL 工具只接受对应动作。
- 所有用户值都必须出现在 `params` 中。数组对应 `?`，对象对应 `:name`；命名参数会按出现顺序重写为 `?` 后绑定。数量不符、未使用参数、混合风格都会报错。
- DDL / GRANT / 用户管理 SQL 不允许出现绑定占位符，因为 Firebird 不支持在 DDL 中绑定参数。
- 服务端执行 SQL 前会去掉尾部空白和分号，避免把用户输入原样拼接进其他语句。

### 对象白名单

- `allowedObjects` 在 SQL 解析阶段检查读/写对象；未列出的对象直接以 `OBJECT_NOT_ALLOWED` 拒绝。
- 支持裸名和 `SCHEMA.OBJECT`。裸名可以匹配白名单中的限定名，但显式限定的对象不会错误匹配到其他 schema 的同名对象。
- CTE 名称按词法作用域识别，不能用来绕过白名单检查同名物理表。

### 事务与危险操作

- `firebird_execute` 在事务中执行：成功提交，失败回滚。
- 无 `WHERE` 的 UPDATE/DELETE 默认拒绝；只有连接开启 `allowUnrestrictedDML: true` 后才允许，并且仍要求 `confirmDangerous: true`。
- 写 `RDB$` 系统表默认拒绝；只有 `allowSystemTables: true` 的 admin 连接允许，并且要求 `confirmDangerous: true`。
- 以下 DDL 在需要时要求 `confirmDangerous: true`：`DROP DATABASE`、删除被外键引用的表、删除带依赖/索引/外键的列、在开启系统表写入时修改 `RDB$`。
- DDL 执行前读取 `RDB$DEPENDENCIES`，执行后再次读取并报告依赖对象和无效 BLR；无论成功失败都会清空该连接的元数据缓存。

### GRANT / REVOKE 两阶段确认

第一次调用只校验并生成 SQL，不执行：

```json
{
  "executed": false,
  "confirmationRequired": true,
  "confirmationToken": "...",
  "expiresAt": "2026-10-20T12:05:00.000Z",
  "sql": "GRANT SELECT ON TABLE CUSTOMERS TO alice"
}
```

第二次调用必须传入完全相同的业务参数、`confirmPrivilege: true` 和该 token。令牌：

- 32 字节随机数，base64url 编码；
- 5 分钟有效；
- 单次使用；
- 绑定 connection + 工具名 + 生成 SQL 的 SHA-256。

### 用户管理

- `firebird_manage_user` 的密码只能通过 `passwordEnv` 或 `passwordRef` 提供。
- 解析出的密码在生成 SQL 前会加入审计脱敏器；工具返回和审计日志中的 SQL 显示为 `'***'`。
- 用户名、姓名字段经过标识符/字面量校验，控制字符和 NUL 被拒绝。
- `DROP USER` 需要 `confirmDDL: true` 和 `confirmDangerous: true`。

## 审计日志

默认路径：`~/.dsh/firebird/audit.jsonl`（目录 `0700`，文件 `0600`，Windows 下使用默认 ACL）。每次工具调用同步追加一行，包括成功、拒绝、失败，以及 dsh 参数 schema 校验失败（`INVALID_ARGS`）。

示例：

```json
{"timestamp":"2026-10-20T03:12:45.123Z","connection":"app_rw","tool":"firebird_query","sql":"SELECT ID FROM CUSTOMERS WHERE ID = ?","sqlHash":"sha256:0f3d...","status":"success","durationMs":12}
{"timestamp":"2026-10-20T03:13:02.456Z","connection":"app_rw","tool":"firebird_execute","sql":"DELETE FROM CUSTOMERS","sqlHash":"sha256:9a1c...","status":"denied","durationMs":0,"error":"UPDATE/DELETE without a top-level WHERE clause is disabled...","code":"UNRESTRICTED_DML_DENIED"}
```

- `sql`：脱敏后 SQL 的前 200 字符；超过时附带 `sqlTruncated: true`。
- `sqlHash`：脱敏后完整 SQL 的 SHA-256，便于关联同一条语句而不泄露全文。
- `error`：最多 1000 字符；`code` 为稳定的错误码。
- 脱敏包括：本次连接/用户管理解析出的真实密码、`PASSWORD '...'`、`IDENTIFIED BY '...'`、`PASSWORD=...` 和 URI 中的账号密码。
- 审计写入是同步的。写审计失败会使调用失败；对于已经执行成功的数据库操作，错误信息会提示先核对数据库状态再重试。
- 日志没有内置轮转，请按部署环境自行归档/清理，不要把审计文件放在可被普通用户改写的位置。

## 运行架构

```text
dsh process
  └─ firebird-connector (Cordis plugin)
       ├─ ConnectionManager ──JSONL over stdio──> driver/worker.mjs
       │                                            └─ node-firebird
       ├─ MetadataService (120s cache + invalidate)
       ├─ ConfirmationStore (5 min, single use)
       └─ AuditLog (sync JSONL + redaction)
```

- 每个连接懒打开；同一连接的请求串行执行；空闲 300 秒自动断开。
- 连接超时 10s、查询 30s、DDL 60s（均可配置）。超时后 worker 被回收，下次调用重新建立所有连接。
- 凭据只在父进程解析，并通过私有 stdin 管道传给 worker；不写入 worker 参数、环境变量或日志。
- 查询/执行/过程调用/DDL 都在 worker 内使用事务；DDL 成功后提交。
- 插件卸载（`ctx.effect` 清理）时关闭连接、停止 worker、清空确认令牌并 flush/close 审计文件。

## 测试

### 单元测试

```bash
npm run test:unit
```

当前 57 个测试，覆盖：

- tokenizer、CTE 作用域、DDL 解析、EXPLAIN、多语句检测；
- 参数绑定（位置/命名/大小写/歧义/数量/标量类型）；
- 配置校验、DSN、凭据来源、安全描述；
- 审计脱敏、JSONL 字段、哈希与截断；
- 确认令牌单次使用/绑定/过期；
- 元数据缓存与过程 EXECUTE 判定；
- 全部 13 个工具的权限、白名单、系统表、危险确认和审计。

### 集成测试（Firebird 2.5 / 3.0 / 5.0）

`test/integration/docker-compose.yml` 使用三个一次性容器：

| 服务 | 端口 | 镜像 | 数据库路径 |
| --- | --- | --- | --- |
| Firebird 2.5.9 | `3025` | `jacobalberty/firebird:2.5-sc` | `/firebird/data/it25.fdb` |
| Firebird 3.0.14 | `3030` | `firebirdsql/firebird:3.0.14` | `/var/lib/firebird/data/it30.fdb` |
| Firebird 5.0.4 | `3035` | `firebirdsql/firebird:5.0.4` | `/var/lib/firebird/data/it50.fdb` |

```bash
# 启动容器（首次会自动创建数据库）
docker compose -f test/integration/docker-compose.yml up -d

# 让 worker 能加载驱动：在仓库内提供 node-firebird，或从已安装驱动的 profile 运行
npm install --no-save --package-lock=false "node-firebird@^2.18.2"

# 运行集成测试
FIREBIRD_INTEGRATION=1 npm run test:integration

# 清理容器与数据卷
docker compose -f test/integration/docker-compose.yml down -v
```

默认凭据为 `SYSDBA` / `masterkey`，仅用于本机一次性测试容器。可用环境变量覆盖：

- 凭据：`FB_IT_USER`、`FB_IT_PASSWORD`
- 每个版本：`FB25_HOST`、`FB25_PORT`、`FB25_DATABASE`，以及 `FB30_*`、`FB50_*`

集成测试覆盖：懒连接/参数查询、DDL、元数据列表与描述、参数化 INSERT/UPDATE/DELETE、无 WHERE DML 拒绝、行数截断、存储过程调用、GRANT/REVOKE 两阶段、拒绝审计、审计字段与密码/token 不泄露。

2026-10-20 本地实测：以上三个版本各 3 个用例，共 9/9 通过。

## 发布到公网（npm）

本包以普通 npm 包（非 scope）发布，当前包名为 `dsh-firebird-connector`。首次发布前用 `npm view dsh-firebird-connector --registry https://registry.npmjs.org` 确认包名可用；已被占用时改用 scope。发布前需要本机已登录 npm 账号：

```bash
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
npm config get registry
```

如果 `registry` 指向国内镜像（常见为 `https://registry.npmmirror.com`），镜像只读、不能发布；上面的登录、发布与校验命令都显式使用官方源。

### 首次发布

```bash
# 1. 确认版本、描述、keywords、license 无误
npm pkg get name version description license

# 2. 跑完单元测试（集成测试可选，但建议发布前至少跑一次）
npm test

# 3. 检查实际打包内容，避免遗漏 cordis.patch.yml 或误带测试文件
npm pack --dry-run

# 4. 发布到官方源（非 scope 包默认 public，--access public 可显式声明）
npm publish --registry https://registry.npmjs.org --access public

# 5. 验证公网可安装
npm view dsh-firebird-connector version --registry https://registry.npmjs.org
```

发布后分别安装到目标的 profile（npm 发布不会自动装进 Web 或 Desktop）：

```bash
# Web
dsh plugin --profile web add "node-firebird@^2.18.2"
dsh plugin --profile web add "dsh-firebird-connector"
# 合并 config.example.yml 到 ~/.dsh/profiles/web/cordis.patch.yml，重启 dsh web

# Desktop：在桌面端左侧栏“插件”页添加 dsh-firebird-connector 和 node-firebird@^2.18.2，
# 合并配置到 ~/.dsh/profiles/desktop/cordis.patch.yml，完全退出并重启
```

### 后续版本

```bash
npm version patch   # 或 minor / major；有 git 仓库时会同时打 tag
npm test
npm publish --registry https://registry.npmjs.org
git push --follow-tags   # 如果使用 git 仓库
```

预发布版本使用 dist-tag，避免覆盖 `latest`：

```bash
npm version prerelease --preid beta
npm publish --tag next
# 用户安装：dsh plugin --profile web add "dsh-firebird-connector@next"
```

### 发布检查清单

- [ ] `npm test` 全部通过；发布前至少跑一次三版本集成测试
- [ ] `package.json` 的 `repository`、`homepage`、`bugs` 指向公开仓库（建议首次发布前补齐）
- [ ] README 的安装命令、配置示例与当前版本一致
- [ ] 包内不含审计日志、`.env`、测试数据库或本机绝对路径
- [ ] npm 账号已开启 2FA；必要时发布命令追加 `--otp <code>`
- [ ] 版本号遵循 semver：破坏性配置/工具变更走 major
- [ ] 发布后执行 `npm view dsh-firebird-connector` 与一次真实安装冒烟

撤回须知：npm 只允许在发布后 72 小时内撤回无其他依赖的版本；超过后只能发布新版本修复，因此发布前务必用 `npm pack --dry-run` 核对内容。包名被占用时需改用 scope，例如 `@your-name/dsh-firebird-connector`，并同步修改 `package.json` 的 `name`、README 安装命令和 `cordis.patch.yml` 中的 bundle 引用。

## 已知限制

- **方言**：配置接受 `dialect: 1`，但当前 worker 以 `effectiveDialect: 3` 附加。Firebird 2.5 的现有 dialect 1 数据库通常仍可被 dialect 3 客户端访问；如依赖严格的方言 1 语义，请先在测试库验证。
- **readonly 是插件层策略**，不是数据库层强制。真正需要防写入时，请给连接使用只有 SELECT 权限的 Firebird 用户；`readonly` 只负责在 SQL 解析阶段拦截写语句。
- **元数据工具不受 `allowedObjects` 约束**，会通过 `RDB$` 暴露未列入白名单对象的定义。不要把元数据工具交给不应看到 schema 的调用方。
- **过程结果不套用 `maxRows`**；可选择过程可能返回大量行，且可能修改数据。
- 查询结果整体物化到内存；BLOB 以 base64 对象返回。不要用该连接器拉取超大结果集。
- DDL 由 Firebird 事务执行；如果 DDL 成功但后续元数据/依赖读取失败，数据库变更仍然已提交。
- 审计日志没有轮转和保留策略；文件系统权限之外没有额外加密。
- **默认不启用 wire 加密**：为兼容 Firebird 2.5–5.0，默认 `wireCrypt: false`。跨公网连接建议在服务器启用 WireCrypt 后改为 `true`；SRP 密码本身不会明文传输，但查询数据和结果会以明文经过网络。
- 名称大小写遵循 Firebird 规则：不加引号的名称会转成大写；区分大小写的对象请用 `"MixedCase"` 形式传入。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| Desktop 的“插件”页看不到本插件 | 确认装的是 `desktop` profile 而不是 web；在左侧栏 **插件** 页查看（不是“设置 → 内置插件”）；安装/改配置后完全退出并重启 Desktop。插件只贡献 agent 工具，不会新增独立页面 |
| 发布成功但客户端没有 | npm 发布只提供包，不会自动安装到任何 profile；Web 用 `dsh plugin --profile web add`，Desktop 在插件页安装 |
| `DRIVER_UNAVAILABLE` | 在同一个 dsh profile 安装 `node-firebird@^2.18.2`，然后重启 dsh |
| `AUDIT_UNAVAILABLE` | 检查 `audit.file` 目录是否可写，Windows 路径是否为绝对路径 |
| `Environment variable ... is not set` | 环境变量必须在启动 dsh 的进程中存在，而不是仅在当前终端临时设置；Desktop 需设置用户环境变量后完全重启 |
| Desktop 插件页/工具仍停留在旧版本 | 安装或更新后完全退出并重启 Desktop；CLI 的 `--profile desktop` 插件管理会被 Electron 拒绝 |
| `Credential reference ... requires the dsh credentials service` | 当前 dsh 未提供 `credentials` 服务，改用 `*Env` 来源 |
| `WORKER_EXITED` / `TIMEOUT` | 检查网络、服务器状态、认证和查询耗时；worker 已回收，下次调用重新连接 |
| `335544375 Unavailable database`（路径和账号已确认） | 常见于 Firebird 3.x 驱动默认协商 `Srp512` 失败；设置 `authPlugin: auto` 或 `Srp`，并保持 `wireCrypt: false` |
| 认证后报 `Connection to Firebird server was lost` | 服务器未启用/未强制 wire 加密时客户端却要求加密；把 `wireCrypt` 设为 `false`。需要加密时先在服务器启用 WireCrypt |
| `335544472` 登录失败 | 账号密码错误，或 Firebird 2.5 需要 `Legacy_Auth`（`auto` 会自动回退，也可显式指定） |
| 连接时报数据库不存在 / I/O error | Windows 服务器路径不要写成 `/D://dir//db.fdb`；改用 `D:/dir/db.fdb`，DSN 中盘符前只留一个 `/` |
| `OBJECT_NOT_ALLOWED` | 把对象加入 `allowedObjects`，或换一个不带白名单的连接 |
| `ACCESS_DENIED` | 当前连接 `accessMode` 不足；过程/触发器/GRANT/用户管理需要 admin |
| `SYSTEM_TABLE_WRITE_DENIED` | 默认禁止写 `RDB$`；确认风险后再设置 `allowSystemTables: true` |
| `UNRESTRICTED_DML_DENIED` | 给 UPDATE/DELETE 加 WHERE，或在明确风险后设置 `allowUnrestrictedDML: true` |
| `CONFIRM_*_REQUIRED` | 按错误提示补 `confirmWrite` / `confirmDDL` / `confirmDangerous` / `confirmPrivilege` |
| `CONFIRMATION_EXPIRED` / `CONFIRMATION_MISMATCH` | 重新发起 GRANT/REVOKE 预览，令牌 5 分钟过期且绑定原始参数 |
| 中文乱码 | 确认数据库字符集与连接 `charset`（默认 UTF8）；老库常见 `WIN1252`、`GBK` 等，以数据库实际字符集为准 |

## 项目结构

```text
dsh-firebird-connector/
├── package.json                 # dsh.bundle.patch 声明，依赖留空
├── cordis.patch.yml             # bundle 插入 id: firebird-connector
├── config.example.yml           # profile patch 配置示例
├── README.md
├── driver/
│   └── worker.mjs               # node-firebird JSONL 子进程
├── src/
│   ├── index.js                 # Cordis 插件入口
│   ├── config.js                # 配置校验、DSN、凭据解析
│   ├── driver.js                # worker 客户端与连接管理
│   ├── metadata.js              # RDB$ catalog + 120s 缓存
│   ├── audit.js                 # 脱敏 + 同步 JSONL
│   ├── confirmations.js         # 一次性确认令牌
│   ├── errors.js / logger.js
│   ├── sql/{tokenize,analyze,params}.js
│   └── tools/                   # 13 个 defineTool 定义
└── test/
    ├── unit/                    # 59 个单元测试
    └── integration/             # 2.5/3.0/5.0 Docker 集成测试
```

## License

MIT
