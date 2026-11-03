# Pandora FMS MCP Server

An independent Model Context Protocol server for Pandora FMS / Pandora Open. It exposes 55 tools (33 read, 16 write, 6 admin) over two APIs:

- **API v2**: `{PANDORA_BASE_URL}/pandora_console/api/v2` (request bodies built from the console's swagger schemas).
- **Legacy API**: `GET {PANDORA_BASE_URL}/pandora_console/include/api.php` (`op`, `op2`, `id`, `id2`, `other`, `other_mode=url_encode_separator_|`, `return_type=json`). The positional `other` fields are exposed as named tool inputs and joined with `|` in the order of the docblocks in `functions_api.php`. Any input value containing `|` is rejected.

## Installation

```bash
npm ci
npm run build
npm test
npm run lint
npm run lint:destructive
npm run smoke
```

## Auth setup

A single per-user API token is used for **both** APIs and is sent only as `Authorization: Bearer <token>` (legacy `api.php` accepts bearer tokens since v768). The token, user and password are never put in the URL, and `apipass`/`user`/`pass` auth is not implemented. The token is never logged and is redacted from errors.

1. Create or copy the API token of the console user the MCP should act as (that user's permissions apply).
2. In the console, under **General setup**, allow the MCP host's IP in **IP list with API access** (and check the **API password** setting). Requests from other IPs fail with "IP ... is not in ACL list".
3. Copy `.env.example` to `.env` and set:

```bash
PANDORA_BASE_URL=https://pandora.example.com
PANDORA_API_TOKEN=<your token>
PANDORA_TOOL_TIERS=read
AUTH_MODE=env
MCP_TRANSPORT=stdio
```

| Variable | Purpose |
|---|---|
| `PANDORA_BASE_URL` | Console base URL. https only (http only for localhost); no userinfo, query or fragment. Required. |
| `PANDORA_API_TOKEN` | Per-user API token (env mode). |
| `PANDORA_TOOL_TIERS` | Comma-separated tiers to expose: `read`, `write`, `admin`. Default `read`. |
| `PANDORA_CA_CERT_FILE` | Optional PEM CA bundle for a private CA. |
| `AUTH_MODE` | `env` (default) or `gateway` (HTTP only). |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. |
| `MCP_HTTP_PORT` / `MCP_HTTP_HOST` | HTTP listen port / host (defaults 8080 / 127.0.0.1). |
| `CONDUIT_S2S_SECRET` | Gateway service-to-service secret; required for HTTP unless `MCP_ALLOW_INSECURE_DEV=1` (loopback only). |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error`. |

## Gateway mode

With `MCP_TRANSPORT=http` and `AUTH_MODE=gateway`, every `POST /mcp` request must carry the per-user token in the `X-Pandora-Token` header (and a valid `X-Gateway-S2S` header). Requests without it get `401`; the environment token is never used as a fallback. `PANDORA_BASE_URL` still comes from the environment. `/health` is unauthenticated.

## Tools

Tools are tiered; `read` is the default. Tools marked `⚠ DESTRUCTIVE` change or remove monitoring data or behaviour and carry `destructiveHint`.

| Tool | Tier | Description |
|---|---|---|
| `pandora_ping_get` | read | Ping the Pandora FMS API v2 (checks that the base URL, API token and ACL work). |
| `pandora_events_list` | read | List events (API v2 POST /event/list; read-only). Filter with the named inputs; page/sort with page, sizePage, sortField, sortDirection. |
| `pandora_event_get` | read | Get one event by id. |
| `pandora_event_comments_list` | read | List the comments of an event (read-only). |
| `pandora_event_filters_list` | read | List saved event filters (read-only). |
| `pandora_event_filter_get` | read | Get one saved event filter by id. |
| `pandora_groups_list` | read | List agent groups (read-only). |
| `pandora_group_get` | read | Get one group by id. |
| `pandora_tags_list` | read | List tags (read-only). |
| `pandora_tag_get` | read | Get one tag by id. |
| `pandora_users_list` | read | List console users (read-only). |
| `pandora_user_get` | read | Get one console user by id (user name). |
| `pandora_profiles_list` | read | List user profiles (roles) (read-only). |
| `pandora_user_profiles_list` | read | List the profiles assigned to a user (read-only). |
| `pandora_itsm_inventories_list` | read | List Pandora ITSM inventory entries (read-only). May be unavailable on Pandora Open. |
| `pandora_itsm_inventory_get` | read | Get one Pandora ITSM inventory entry by id. May be unavailable on Pandora Open. |
| `pandora_event_create` | write | Create an event. |
| `pandora_event_update` | write | Update an event (for example set status to validated or inprocess, or change the owner). |
| `pandora_event_comment_create` | write | Add a comment to an event. |
| `pandora_group_create` | write | Create an agent group. |
| `pandora_group_update` | write | Update an agent group. |
| `pandora_event_delete` | admin | ⚠ DESTRUCTIVE Permanently delete an event. This cannot be undone. |
| `pandora_group_delete` | admin | ⚠ DESTRUCTIVE Permanently delete an agent group. This cannot be undone and may affect the agents in it. |
| `pandora_agents_list` | read | List all agents the token's user can read (legacy get/all_agents). Optional filters. |
| `pandora_agent_modules_list` | read | List the modules of an agent (legacy get/agent_modules). |
| `pandora_agent_id_get` | read | Look up agent ids from agent names (legacy get/agent_id). |
| `pandora_module_properties_get` | read | Get the properties of a module by id (legacy get/module_properties). |
| `pandora_module_last_value_get` | read | Get the last value of a module by id (legacy get/module_last_value). |
| `pandora_module_data_get` | read | Get historical data of a module (legacy get/module_data). |
| `pandora_agents_tree_get` | read | Get the group/agent/module tree (legacy get/tree_agents). |
| `pandora_agents_total_get` | read | Count the agents in a group (legacy get/total_agents). |
| `pandora_modules_total_get` | read | Count the modules in a group (legacy get/total_modules). |
| `pandora_tactical_view_get` | read | Get the tactical view summary (legacy get/tactical_view). |
| `pandora_servers_list` | read | List the Pandora servers and their status (legacy get/pandora_servers). |
| `pandora_alert_templates_list` | read | List all alert templates (legacy get/all_alert_templates). |
| `pandora_alert_actions_list` | read | List alert actions, optionally filtered by name (legacy get/alert_actions). |
| `pandora_downtimes_list` | read | List planned downtimes, optionally filtered (legacy get/all_planned_downtimes). |
| `pandora_downtime_items_list` | read | List the items (agents/modules) of a planned downtime (legacy get/planned_downtimes_items). |
| `pandora_module_groups_list` | read | List module groups (legacy get/module_groups). |
| `pandora_legacy_test_get` | read | Test the legacy api.php connection (get/test): returns OK, version and build. |
| `pandora_alert_validate` | write | Validate (acknowledge) one alert of a module (legacy set/validate_alert). |
| `pandora_alerts_validate_all` | write | Validate (acknowledge) ALL fired alerts the user can manage (legacy set/validate_all_alerts). |
| `pandora_module_enable` | write | Enable a module, given agent and module name (legacy set/enable_module). |
| `pandora_module_disable` | write | ⚠ DESTRUCTIVE Disable a module, given agent and module name; the module stops collecting data until re-enabled (legacy set/disable_module). |
| `pandora_module_alerts_enable` | write | Enable all the alerts of one module (legacy set/enable_module_alerts). |
| `pandora_module_alerts_disable` | write | ⚠ DESTRUCTIVE Disable all the alerts of one module; no alerts will fire for it until re-enabled (legacy set/disable_module_alerts). |
| `pandora_agent_enabled_set` | write | Enable or disable an agent (legacy set/enable_disable_agent). disabled=true stops the agent from being monitored. |
| `pandora_downtime_create` | write | Create a planned downtime (legacy set/planned_downtimes_created). Dates use MM-DD-YYYY, times HH:MM:SS. |
| `pandora_downtime_agents_add` | write | Add agents to a planned downtime (legacy set/planned_downtimes_add_agents). |
| `pandora_downtime_stop` | write | Stop a running planned downtime (legacy set/stop_downtime). |
| `pandora_agent_field_update` | write | Update fields of an agent (legacy set/update_agent_field). Field names must not contain ","; no value may contain "\|". |
| `pandora_agent_delete` | admin | ⚠ DESTRUCTIVE Permanently delete an agent by name, with all its modules and data (legacy set/delete_agent). This cannot be undone. |
| `pandora_module_delete` | admin | ⚠ DESTRUCTIVE Permanently delete a module and its data, given agent and module name (legacy set/delete_module). Use simulate=true for a dry run. This cannot be undone. |
| `pandora_downtime_delete` | admin | ⚠ DESTRUCTIVE Permanently delete a planned downtime (legacy set/planned_downtimes_deleted). This cannot be undone. |
| `pandora_agent_counts_reset` | admin | ⚠ DESTRUCTIVE Reset the module and alert counters of an agent, or of ALL agents with id "All" (legacy set/reset_agent_counts). |

## Security

- https only (http only for `localhost`/`127.0.0.1`, used in tests); userinfo is rejected.
- Redirects are not followed (`redirect: "manual"`); any 3xx is an error. Path parameters are URL-encoded.
- The token is sent only in the `Authorization` header and redacted from errors.
- Legacy errors (JSON `type: "error"`, or text starting with `Error`, `auth error`, ACL/credential messages) become tool errors.

## Upstream license

Pandora FMS open source (now Pandora Open, github.com/pandorafms/pandora-open) is licensed under GPL-2.0. This MCP is an independent MIT-licensed client that talks to it only over its HTTP APIs; no Pandora code is copied or linked, so GPL-2.0 does not reach it. The tool list was derived by reading the public source and swagger. The Enterprise edition is commercial; endpoints that are Enterprise-only may return errors on Pandora Open.
